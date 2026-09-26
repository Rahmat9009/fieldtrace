import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createSharedNetTransport } from '../worker/sharednet-transport.js';

test('CLI transport normalizes ledger fields and preserves artifact bytes', async () => {
  const bytes = Buffer.from('{"payload":{"x":1}}');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const calls = [];
  const transport = createSharedNetTransport({ roomDir: '/joined-room', seatId: 'i_AbCdEfGhIj',
    commandRunner: async (verb, args) => {
      calls.push(verb);
      if (verb === 'ledger') return { transfers: [{
        id: 'txn_AbCdEfGhIj', from_principal_id: 'p_AbCdEfGhIj',
        to_principal_id: 'p_ZyXwVuTsRq', amount: 8, memo: 'ord_manual01', room_id: null,
      }] };
      if (verb === 'download') {
        await writeFile(args[args.indexOf('--out') + 1], bytes);
        return { sha256: hash, verified: true };
      }
      if (verb === 'upload') {
        assert.deepEqual(await readFile(args[0]), bytes);
        return { artifact: { id: 'art_ZyXwVuTsRq' } };
      }
      if (verb === 'say') return { message: { id: 'msg_ZyXwVuTsRq' } };
      if (verb === 'read') return { items: [], has_more: false };
      throw new Error(`Unexpected ${verb}`);
    },
  });
  assert.deepEqual(await transport.findTransfer('txn_AbCdEfGhIj'), {
    id: 'txn_AbCdEfGhIj', from: 'p_AbCdEfGhIj', to: 'p_ZyXwVuTsRq',
    amount: 8, memo: 'ord_manual01', room_id: null, created_at: undefined,
  });
  assert.deepEqual(await transport.download('art_AbCdEfGhIj'), { status: 'found', bytes });
  assert.deepEqual(await transport.upload(bytes, 'result.json'), { artifact_id: 'art_ZyXwVuTsRq' });
  assert.deepEqual(await transport.reply('msg_AbCdEfGhIj', 'done'), { message_id: 'msg_ZyXwVuTsRq' });
  assert.deepEqual((await transport.readPage(0)).items, []);
  assert.deepEqual(calls, ['ledger', 'download', 'upload', 'say', 'read']);
});

test('download distinguishes artifact-specific failures from general transport failures', async () => {
  let reason = 'artifact_not_found: SharedNet rejected the request';
  const transport = createSharedNetTransport({ roomDir: '/joined-room', seatId: 'i_AbCdEfGhIj',
    commandRunner: async () => { throw new Error(reason); },
  });
  assert.equal((await transport.download('art_AbCdEfGhIj')).status, 'confirmed_failure');
  reason = 'npx timed out';
  assert.equal((await transport.download('art_AbCdEfGhIj')).status, 'temporary_error');
});

test('download refuses more than 1 MiB before reading the file', async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 1);
  const transport = createSharedNetTransport({ roomDir: '/joined-room', seatId: 'i_AbCdEfGhIj',
    commandRunner: async (_verb, args) => {
      await writeFile(args[args.indexOf('--out') + 1], bytes);
      return { sha256: createHash('sha256').update(bytes).digest('hex'), verified: true };
    },
  });
  assert.deepEqual(await transport.download('art_AbCdEfGhIj'),
    { status: 'too_large', size_bytes: bytes.length });
});

test('legacy order-index backfill uses filtered room reads', async () => {
  const calls = [];
  const transport = createSharedNetTransport({ roomDir: '/joined-room', seatId: 'i_AbCdEfGhIj',
    commandRunner: async (verb, args) => {
      calls.push([verb, args]);
      return { items: [], has_more: false };
    },
  });
  assert.deepEqual(await transport.readAllOrderIds(), { orderIds: [], historyComplete: true });
  assert.deepEqual(calls[0], ['read', ['--after', '0', '--grep', 'fieldtrace.order', '--limit', '100']]);
});

test('refund notice search accepts only this worker seat and supports room posts', async () => {
  const calls = [];
  const content = JSON.stringify({ type: 'fieldtrace.refund.v1', refund_transfer_id: 'txn_ZyXwVuTsRq' });
  const transport = createSharedNetTransport({ roomDir: '/joined-room', seatId: 'i_AbCdEfGhIj',
    commandRunner: async (verb, args) => {
      calls.push([verb, args]);
      if (verb === 'read') return { items: [
        { id: 'msg_AbCdEfGhI1', sender_instance_id: 'i_OtherSeat1', content },
        { id: 'msg_AbCdEfGhI2', sender_instance_id: 'i_AbCdEfGhIj', content },
      ], has_more: false };
      if (verb === 'say') return { message: { id: 'msg_ZyXwVuTsRq' } };
      throw new Error(`Unexpected ${verb}`);
    },
  });
  assert.deepEqual(await transport.findRefundNotice('txn_ZyXwVuTsRq'),
    { message_id: 'msg_AbCdEfGhI2' });
  assert.deepEqual(await transport.post(content), { message_id: 'msg_ZyXwVuTsRq' });
  assert.deepEqual(calls[0], ['read', ['--after', '0', '--grep', 'txn_ZyXwVuTsRq', '--limit', '100']]);
  assert.deepEqual(calls[1], ['say', [content]]);
});
