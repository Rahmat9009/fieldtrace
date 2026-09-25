import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const emptyState = () => ({ schema_version: 1, cursor: 0, records: [], pending_messages: [] });

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
    close: async () => {
      await queue;
      if (closed) return;
      closed = true;
      await lock.close();
      await unlink(lockPath);
    },
  };
}
