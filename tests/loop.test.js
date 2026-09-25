import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOrderMessage } from '../client/order.js';
import { openJournal } from '../worker/journal.js';
import { runCycle, superviseWorker } from '../worker/loop.js';

const seller = 'p_ZyXwVuTsRq';
const buyer = 'p_AbCdEfGhIj';
const hash = 'a'.repeat(64);
const makeMessage = (sequence, orderId, transferId) => ({
  sequence, id: `msg_AbCdEfGhI${sequence}`, sender_principal_id: buyer,
  content: encodeOrderMessage({ orderId, transferId, artifactId: 'art_AbCdEfGhIj', artifactSha256: hash }),
});

async function withJournal(run) {
  const dir = await mkdtemp(join(tmpdir(), 'fieldtrace-loop-'));
  const journal = await openJournal(join(dir, 'orders.json'));
  try { await run(journal); } finally { await journal.close(); await rm(dir, { recursive: true, force: true }); }
}

test('one transport throw queues that message and the next paid order is still processed', async () => {
  await withJournal(async (journal) => {
    const first = makeMessage(1, 'ord_first01', 'txn_AbCdEfGhI1');
    const second = makeMessage(2, 'ord_second01', 'txn_AbCdEfGhI2');
    const logs = [];
    await runCycle({ journal, transport: {
      readPage: async () => ({ items: [first, second], has_more: false }),
      findTransfer: async (id) => {
        if (id === 'txn_AbCdEfGhI1') throw new Error('npx timed out');
        return { id, from: buyer, to: seller, amount: 5, memo: 'ord_wrong01' };
      },
      findRefund: async () => null,
    }, adapt: async () => { throw new Error('must not adapt'); },
    price: 5, sellerPrincipalId: seller, graceMs: null, refundsEnabled: false,
    log: async (line) => { logs.push(line); }, now: () => 0 });
    const snapshot = journal.snapshot();
    assert.equal(snapshot.cursor, 2);
    assert.deepEqual(snapshot.pending_messages.map((item) => item.id), [first.id]);
    assert.deepEqual(snapshot.seen_order_ids, ['ord_first01', 'ord_second01']);
    assert.equal(snapshot.records[0].status, 'refund_pending');
    assert.match(logs[0], /npx timed out/);
  });
});

test('supervisor restarts after a read failure with backoff', async () => {
  await withJournal(async (journal) => {
    let reads = 0;
    const pauses = [];
    const logs = [];
    await superviseWorker({ journal, transport: { readPage: async () => {
      reads++;
      if (reads === 1) throw new Error('network blip');
      return { items: [], has_more: false };
    } }, adapt: async () => {}, price: 5, sellerPrincipalId: seller, graceMs: null,
    refundsEnabled: false, log: async (line) => { logs.push(line); }, now: () => 0 },
    { shouldStop: () => reads >= 2, pause: async (ms) => { pauses.push(ms); } });
    assert.equal(reads, 2);
    assert.deepEqual(pauses, [1000]);
    assert.match(logs[0], /network blip/);
  });
});

test('orphan scan uses persisted incremental order ids without re-reading room history', async () => {
  await withJournal(async (journal) => {
    await journal.noteOrderId('ord_existing01');
    await runCycle({ journal, transport: {
      readPage: async () => ({ items: [], has_more: false }),
      readAllOrderIds: async () => { throw new Error('must not re-read room'); },
      transfersSince: async () => ({ transfers: [{ id: 'txn_AbCdEfGhI1', from: buyer,
        to: seller, amount: 5, memo: 'ord_existing01', created_at: '2026-09-25T12:00:00Z' }],
        historyComplete: true }),
    }, adapt: async () => {}, price: 5, sellerPrincipalId: seller,
    serviceStartedAt: '2026-09-25T11:00:00Z', graceMs: 300000,
    refundsEnabled: false, log: async () => {}, now: () => Date.parse('2026-09-25T12:10:00Z') });
    assert.deepEqual(journal.snapshot().records, []);
  });
});
