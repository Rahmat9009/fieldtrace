import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../worker/journal.js';
import { processRefundRecord } from '../worker/refund.js';

const seller = 'p_ZyXwVuTsRq';
const buyer = 'p_AbCdEfGhIj';
const original = { id: 'txn_AbCdEfGhIj', from: buyer, to: seller, amount: 8 };

async function withRefundRecord(run, status = 'refund_pending') {
  const dir = await mkdtemp(join(tmpdir(), 'fieldtrace-refund-'));
  const journal = await openJournal(join(dir, 'orders.json'));
  try {
    await journal.reserve({ order_id: 'ord_manual01', transfer_id: original.id,
      artifact_id: null, buyer_principal_id: buyer, message_id: 'msg_AbCdEfGhIj' });
    await journal.setStatus('ord_manual01', status, status === 'fulfilled'
      ? { overpayment_refund_amount: 2 } : { refund_amount: 8, refund_reason: 'memo_mismatch' });
    await run(journal);
  } finally { await journal.close(); await rm(dir, { recursive: true, force: true }); }
}

test('refund policy guard prevents a transfer, then confirmed refund happens once', async () => {
  await withRefundRecord(async (journal) => {
    let payments = 0;
    const replies = [];
    const transport = {
      findTransfer: async () => original,
      findRefund: async () => null,
      payRefund: async () => { payments++; return { transfer_id: 'txn_ZyXwVuTsRq' }; },
      reply: async (messageId, content) => {
        replies.push({ messageId, body: JSON.parse(content) });
        return { message_id: 'msg_ZyXwVuTsRq' };
      },
    };
    const args = { journal, transport, sellerPrincipalId: seller };
    assert.equal((await processRefundRecord({ ...args, record: journal.snapshot().records[0], refundsEnabled: false })).status, 'policy_pending');
    assert.equal(payments, 0);
    assert.equal((await processRefundRecord({ ...args, record: journal.snapshot().records[0], refundsEnabled: true })).status, 'refunded');
    assert.equal((await processRefundRecord({ ...args, record: journal.snapshot().records[0], refundsEnabled: true })).status, 'not_due');
    assert.equal(payments, 1);
    assert.equal(journal.snapshot().records[0].refund_transfer_id, 'txn_ZyXwVuTsRq');
    assert.deepEqual(replies, [{ messageId: 'msg_AbCdEfGhIj', body: {
      type: 'fieldtrace.refund.v1', order_id: 'ord_manual01', code: 'memo_mismatch',
      transfer_id: original.id, refund_transfer_id: 'txn_ZyXwVuTsRq',
    } }]);
  });
});

test('uncertain refund result is never paid again without reconciliation', async () => {
  await withRefundRecord(async (journal) => {
    let payments = 0;
    const transport = {
      findTransfer: async () => original,
      findRefund: async () => null,
      payRefund: async () => { payments++; throw new Error('connection dropped'); },
    };
    const args = { journal, transport, sellerPrincipalId: seller, refundsEnabled: true };
    assert.equal((await processRefundRecord({ ...args, record: journal.snapshot().records[0] })).status, 'manual_reconciliation');
    assert.equal((await processRefundRecord({ ...args, record: journal.snapshot().records[0] })).status, 'manual_reconciliation');
    assert.equal(payments, 1);
  });
});

test('overpayment refund preserves fulfilled status and returns only excess', async () => {
  await withRefundRecord(async (journal) => {
    let paidAmount;
    const transport = {
      findTransfer: async () => ({ ...original, amount: 10 }),
      findRefund: async () => null,
      payRefund: async ({ amount }) => { paidAmount = amount; return { transfer_id: 'txn_ZyXwVuTsRq' }; },
      reply: async () => ({ message_id: 'msg_ZyXwVuTsRq' }),
    };
    const result = await processRefundRecord({ record: journal.snapshot().records[0], journal,
      transport, sellerPrincipalId: seller, refundsEnabled: true });
    assert.equal(result.status, 'refunded');
    assert.equal(paidAmount, 2);
    assert.equal(journal.snapshot().records[0].status, 'fulfilled');
  }, 'fulfilled');
});

test('an uncertain refund reply is reconciled without paying twice', async () => {
  await withRefundRecord(async (journal) => {
    let payments = 0;
    let noticeVisible = false;
    const transport = {
      findTransfer: async () => original,
      findRefund: async () => null,
      payRefund: async () => { payments++; return { transfer_id: 'txn_ZyXwVuTsRq' }; },
      findRefundNotice: async () => noticeVisible ? { message_id: 'msg_ZyXwVuTsRq' } : null,
      reply: async () => { noticeVisible = true; throw new Error('reply confirmation lost'); },
    };
    const args = { journal, transport, sellerPrincipalId: seller, refundsEnabled: true };
    await assert.rejects(processRefundRecord({ ...args, record: journal.snapshot().records[0] }),
      /reply confirmation lost/);
    assert.equal(journal.snapshot().records[0].refund_status, 'confirmed');
    assert.equal(payments, 1);
    const recovered = await processRefundRecord({ ...args, record: journal.snapshot().records[0] });
    assert.equal(recovered.status, 'refunded');
    assert.equal(recovered.message_id, 'msg_ZyXwVuTsRq');
    assert.equal(payments, 1);
    assert.equal(journal.snapshot().records[0].refund_message_id, 'msg_ZyXwVuTsRq');
  });
});
