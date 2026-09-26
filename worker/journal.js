import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const emptyState = () => ({ schema_version: 1, cursor: 0, records: [], pending_messages: [],
  artifact_failures: {}, payment_failures: {}, preflight_requests: {},
  seen_order_ids: [], order_index_complete: true });

/**
 * One-worker durable journal. A lock file prevents two local workers from
 * consuming the same transfers. A stale lock after a crash needs operator
 * reconciliation; this class never guesses that it is safe to remove it.
 */
export async function openJournal(path) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  let state;
  try {
    const raw = await readFile(path, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    state = raw === null ? emptyState() : JSON.parse(raw);
    if (state.schema_version !== 1 || !Number.isSafeInteger(state.cursor) || !Array.isArray(state.records)) {
      throw new Error('Invalid FieldTrace journal');
    }
    state.pending_messages ??= [];
    if (!Array.isArray(state.pending_messages)) throw new Error('Invalid FieldTrace pending messages');
    state.artifact_failures ??= {};
    state.payment_failures ??= {};
    state.preflight_requests ??= {};
    state.seen_order_ids ??= [];
    state.order_index_complete ??= state.cursor === 0;
    if (!state.artifact_failures || typeof state.artifact_failures !== 'object'
      || !state.payment_failures || typeof state.payment_failures !== 'object'
      || !state.preflight_requests || typeof state.preflight_requests !== 'object'
      || !Array.isArray(state.seen_order_ids) || typeof state.order_index_complete !== 'boolean') {
      throw new Error('Invalid FieldTrace order index');
    }
  } catch (error) {
    await lock.close();
    await unlink(lockPath);
    throw error;
  }

  let closed = false;
  let queue = Promise.resolve();
  async function update(mutator) {
    const action = queue.then(async () => {
      if (closed) throw new Error('Journal is closed');
      const next = structuredClone(state);
      mutator(next);
      const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      let handle;
      try {
        handle = await open(temp, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temp, path);
        state = next;
      } finally {
        await handle?.close();
        await unlink(temp).catch(() => {});
      }
      return structuredClone(state);
    });
    queue = action.catch(() => {});
    return action;
  }
  return {
    snapshot: () => structuredClone(state),
    reserve: (record) => update((next) => {
      if (next.records.some((item) => item.order_id === record.order_id || item.transfer_id === record.transfer_id)) {
        throw new Error('Order or transfer already journaled');
      }
      next.records.push({ ...record, status: 'reserved' });
    }),
    reserveRefund: (record) => update((next) => {
      if (next.records.some((item) => item.order_id === record.order_id || item.transfer_id === record.transfer_id)) {
        throw new Error('Order or transfer already journaled');
      }
      if (!Number.isSafeInteger(record.refund_amount) || record.refund_amount < 1) {
        throw new Error('Invalid refund amount');
      }
      next.records.push({ ...record, status: 'refund_pending' });
    }),
    setStatus: (orderId, status, fields = {}) => update((next) => {
      const record = next.records.find((item) => item.order_id === orderId);
      if (!record) throw new Error('Order not journaled');
      Object.assign(record, fields, { status });
    }),
    advanceCursor: (sequence) => update((next) => {
      if (!Number.isSafeInteger(sequence) || sequence < next.cursor) throw new Error('Invalid cursor');
      next.cursor = sequence;
    }),
    queueMessage: (message) => update((next) => {
      if (!next.pending_messages.some((item) => item.id === message.id)) next.pending_messages.push(message);
    }),
    removeMessage: (messageId) => update((next) => {
      next.pending_messages = next.pending_messages.filter((item) => item.id !== messageId);
    }),
    noteArtifactFailure: (orderId, artifactId, transferId, at) => update((next) => {
      const previous = next.artifact_failures[orderId];
      const same = previous?.artifact_id === artifactId && previous?.transfer_id === transferId;
      next.artifact_failures[orderId] = {
        artifact_id: artifactId, transfer_id: transferId,
        first_at: same ? previous.first_at : at,
        attempts: same ? previous.attempts + 1 : 1,
      };
    }).then((next) => next.artifact_failures[orderId]),
    clearArtifactFailure: (orderId) => update((next) => { delete next.artifact_failures[orderId]; }),
    notePaymentFailure: (messageId, transferId, code, at, retryMs) => update((next) => {
      const previous = next.payment_failures[messageId];
      const same = previous?.transfer_id === transferId;
      const firstAt = same ? previous.first_at : at;
      next.payment_failures[messageId] = {
        transfer_id: transferId, code, first_at: firstAt,
        attempts: same ? previous.attempts + 1 : 1,
        terminal: (same && previous.terminal) || Date.parse(at) - Date.parse(firstAt) >= retryMs,
      };
    }).then((next) => next.payment_failures[messageId]),
    clearPaymentFailure: (messageId) => update((next) => { delete next.payment_failures[messageId]; }),
    checkPreflightRate: (messageId, buyerPrincipalId, at, limit = 5, windowMs = 600000) => {
      if (!Number.isFinite(Date.parse(at))) throw new TypeError('Invalid preflight time');
      return update((next) => {
        if (next.preflight_requests[messageId]) return;
        const current = Date.parse(at);
        const recent = Object.values(next.preflight_requests).filter((request) =>
          request.buyer_principal_id === buyerPrincipalId
          && request.allowed === true
          && current - Date.parse(request.at) >= 0
          && current - Date.parse(request.at) < windowMs);
        next.preflight_requests[messageId] = {
          buyer_principal_id: buyerPrincipalId, at, allowed: recent.length < limit,
        };
      }).then((next) => next.preflight_requests[messageId]);
    },
    noteOrderId: (orderId) => update((next) => {
      if (!next.seen_order_ids.includes(orderId)) next.seen_order_ids.push(orderId);
    }),
    completeOrderIndex: (orderIds) => update((next) => {
      next.seen_order_ids = [...new Set([...next.seen_order_ids, ...orderIds])];
      next.order_index_complete = true;
    }),
    close: async () => {
      await queue;
      if (closed) return;
      closed = true;
      await lock.close();
      await unlink(lockPath);
    },
  };
}
