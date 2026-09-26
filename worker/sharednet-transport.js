import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_ARTIFACT_BYTES, parseOrderMessage } from './intake.js';

const execFileAsync = promisify(execFile);

function isArtifactSpecificFailure(error) {
  const detail = `${error?.message ?? ''} ${error?.stderr ?? ''}`;
  return /artifact.{0,80}(not[_ -]?found|does not exist|missing|unreadable|access[_ -]?denied|permission[_ -]?denied)|(?:not found|does not exist|missing|unreadable|access denied|permission denied).{0,80}artifact/i.test(detail);
}

function normalizeTransfer(raw) {
  const source = raw.from_principal_id ?? raw.from?.principal_id ?? raw.from?.id ?? raw.from;
  const target = raw.to_principal_id ?? raw.to?.principal_id ?? raw.to?.id ?? raw.to;
  return {
    id: raw.id, from: source, to: target, amount: raw.amount,
    memo: raw.memo, room_id: raw.room_id ?? null,
    created_at: raw.created_at,
  };
}

export function createSharedNetTransport({ roomDir, seatId, timeoutMs = 30000, commandRunner }) {
  if (process.platform === 'win32' && !commandRunner) throw new Error('Run the SharedNet worker in WSL or Linux');
  if (!/^i_[A-Za-z0-9]{10}$/.test(seatId)) throw new TypeError('Invalid SharedNet seat');
  const executable = 'npx';
  async function run(verb, args = []) {
    if (commandRunner) return commandRunner(verb, args, { roomDir, seatId });
    const { stdout } = await execFileAsync(executable, ['-y', 'sharednet@latest', verb, ...args, '--as', seatId], {
      cwd: roomDir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    try { return JSON.parse(stdout); } catch { throw new Error(`SharedNet ${verb} returned non-JSON output`); }
  }
  async function ledgerPage(before) {
    const payload = await run('ledger', ['--last', '100', ...(before ? ['--before', before] : [])]);
    const entries = payload.transfers ?? payload.items;
    if (!Array.isArray(entries)) throw new Error('Unrecognized SharedNet ledger response');
    return entries.map(normalizeTransfer);
  }
  async function readPage(after) {
    const page = await run('read', ['--after', String(after), '--limit', '100']);
    if (!Array.isArray(page.items)) throw new Error('Unrecognized SharedNet room response');
    return page;
  }
  return {
    readPage,
    findTransfer: async (id) => {
      let before;
      for (let page = 0; page < 20; page++) {
        const entries = await ledgerPage(before);
        const found = entries.find((entry) => entry.id === id);
        if (found) return found;
        if (entries.length < 100) return null;
        before = entries.at(-1).id;
      }
      throw new Error('Ledger search limit reached; cannot safely decide payment status');
    },
    findRefund: async ({ buyerPrincipalId, sellerPrincipalId, amount, memo }) => {
      let before;
      for (let page = 0; page < 20; page++) {
        const entries = await ledgerPage(before);
        const found = entries.find((entry) => entry.from === sellerPrincipalId
          && entry.to === buyerPrincipalId && entry.amount === amount && entry.memo === memo);
        if (found) return found;
        if (entries.length < 100) return null;
        before = entries.at(-1).id;
      }
      throw new Error('Ledger refund search limit reached; cannot safely issue another transfer');
    },
    payRefund: async ({ buyerPrincipalId, amount, memo }) => {
      const result = await run('pay', [buyerPrincipalId, String(amount), '--memo', memo, '--room']);
      return { transfer_id: result.transfer?.id };
    },
    findRefundNotice: async (refundTransferId) => {
      let after = 0;
      for (let page = 0; page < 100; page++) {
        const batch = await run('read', ['--after', String(after), '--grep', refundTransferId, '--limit', '100']);
        if (!Array.isArray(batch.items)) throw new Error('Unrecognized SharedNet room response');
        for (const message of batch.items) {
          try {
            const body = JSON.parse(message.content);
            if (message.sender_instance_id === seatId
              && body.type === 'fieldtrace.refund.v1' && body.refund_transfer_id === refundTransferId) {
              return { message_id: message.id };
            }
          } catch { /* A non-JSON message is not a refund notice. */ }
        }
        const last = batch.items.at(-1)?.sequence ?? after;
        if (!batch.has_more) return null;
        if (last <= after) throw new Error('Refund notice search made no progress');
        after = last;
      }
      throw new Error('Refund notice search limit reached');
    },
    transfersSince: async (startedAt) => {
      const threshold = Date.parse(startedAt);
      if (!Number.isFinite(threshold)) throw new TypeError('Invalid service start time');
      const all = [];
      let before;
      for (let page = 0; page < 20; page++) {
        const entries = await ledgerPage(before);
        all.push(...entries.filter((item) => Date.parse(item.created_at) >= threshold));
        if (entries.length < 100 || entries.some((item) => Date.parse(item.created_at) < threshold)) {
          return { transfers: all, historyComplete: true };
        }
        before = entries.at(-1).id;
      }
      return { transfers: all, historyComplete: false };
    },
    readAllOrderIds: async () => {
      const ids = new Set();
      let after = 0;
      for (let page = 0; page < 100; page++) {
        const batch = await run('read', ['--after', String(after), '--grep', 'fieldtrace.order', '--limit', '100']);
        if (!Array.isArray(batch.items)) throw new Error('Unrecognized SharedNet room response');
        for (const message of batch.items) {
          try {
            const order = parseOrderMessage(message);
            if (order) ids.add(order.orderId);
          } catch { /* A malformed order cannot establish a valid order ID. */ }
        }
        const last = batch.items.at(-1)?.sequence ?? after;
        if (!batch.has_more || last <= after) return { orderIds: [...ids], historyComplete: !batch.has_more };
        after = last;
      }
      return { orderIds: [...ids], historyComplete: false };
    },
    download: async (artifactId) => {
      const dir = await mkdtemp(join(tmpdir(), 'fieldtrace-download-'));
      const out = join(dir, 'request.json');
      try {
        const result = await run('download', [artifactId, '--out', out]);
        const advertisedSize = result.artifact?.size_bytes ?? result.size_bytes;
        if (Number.isSafeInteger(advertisedSize) && advertisedSize > MAX_ARTIFACT_BYTES) {
          return { status: 'too_large', size_bytes: advertisedSize };
        }
        let fileSize;
        try { fileSize = (await stat(out)).size; } catch (error) {
          return { status: 'confirmed_failure', reason: `artifact_unreadable: ${error.message}` };
        }
        if (fileSize > MAX_ARTIFACT_BYTES) return { status: 'too_large', size_bytes: fileSize };
        let bytes;
        try { bytes = await readFile(out); } catch (error) {
          return { status: 'confirmed_failure', reason: `artifact_unreadable: ${error.message}` };
        }
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (result.verified === false || result.sha256 !== digest) {
          return { status: 'confirmed_failure', reason: 'artifact_integrity_failed' };
        }
        return { status: 'found', bytes };
      } catch (error) {
        // Only artifact-specific failures advance the three-minute refund
        // timer; a general CLI or network outage must not mass-refund orders.
        return { status: isArtifactSpecificFailure(error) ? 'confirmed_failure' : 'temporary_error',
          reason: error.message };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    upload: async (bytes, filename) => {
      const dir = await mkdtemp(join(tmpdir(), 'fieldtrace-upload-'));
      const file = join(dir, 'result.json');
      try {
        await writeFile(file, bytes, { mode: 0o600 });
        const result = await run('upload', [file, '--name', filename]);
        return { artifact_id: result.artifact?.id ?? result.artifact_id ?? result.id };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    reply: async (messageId, content) => {
      const result = await run('say', [content, '--reply-to', messageId]);
      return { message_id: result.message?.id ?? result.id };
    },
    post: async (content) => {
      const result = await run('say', [content]);
      return { message_id: result.message?.id ?? result.id };
    },
  };
}
