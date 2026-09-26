import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapt } from '../core/src/adapter.js';
import { encodeOrderMessage, encodePreflightMessage } from '../client/order.js';
import { openJournal } from '../worker/journal.js';
import { handleRoomMessage } from '../worker/service.js';
import { stageOrphanRefunds } from '../worker/service.js';
import { processRefundRecord } from '../worker/refund.js';

const buyer = 'p_AbCdEfGhIj';
const seller = 'p_ZyXwVuTsRq';
const artifactId = 'art_AbCdEfGhIj';
const payload = Buffer.from(JSON.stringify({
  direction: 'response',
  payload: { user_name: 'Ada', age: '36', active: 'true' },
  target_example: { name: 'Ada', age: 36, active: true },
  aliases: { '/name': '/user_name' },
}));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const artifactSha256 = sha(payload);

async function withJournal(run) {
  const dir = await mkdtemp(join(tmpdir(), 'fieldtrace-integration-'));
  const journal = await openJournal(join(dir, 'orders.json'));
  try { await run(journal); } finally { await journal.close(); await rm(dir, { recursive: true, force: true }); }
}

test('the real core preflights then delivers a validated artifact only after payment', async () => {
  await withJournal(async (journal) => {
    const replies = [];
    let uploads = 0;
    let resultBytes;
    const orderId = 'ord_smoke01';
    const transferId = 'txn_AbCdEfGhIj';
    const transport = {
      download: async () => ({ status: 'found', bytes: payload }),
      findTransfer: async () => ({ id: transferId, from: buyer, to: seller, amount: 5, memo: orderId }),
      upload: async (bytes) => { uploads++; resultBytes = bytes; return { artifact_id: 'art_ZyXwVuTsRq' }; },
      reply: async (_id, content) => { replies.push(JSON.parse(content)); return { message_id: 'msg_ZyXwVuTsRq' }; },
    };
    const preflight = { id: 'msg_AbCdEfGhI1', sender_principal_id: buyer,
      content: encodePreflightMessage({ artifactId, artifactSha256 }) };
    const check = await handleRoomMessage({ message: preflight, journal, transport, adapt, price: 5,
      sellerPrincipalId: seller });
    assert.equal(check.status, 'ok');
    assert.deepEqual({ convertible: replies[0].convertible, change_count: replies[0].change_count,
      price: replies[0].price }, { convertible: true, change_count: 3, price: 5 });
    assert.equal('output' in replies[0], false);
    assert.equal('changes' in replies[0], false);
    assert.equal(uploads, 0);

    const order = { id: 'msg_AbCdEfGhI2', sender_principal_id: buyer,
      content: encodeOrderMessage({ orderId, artifactId, artifactSha256, transferId }) };
    const delivered = await handleRoomMessage({ message: order, journal, transport, adapt, price: 5,
      sellerPrincipalId: seller });
    assert.equal(delivered.status, 'fulfilled');
    assert.equal(uploads, 1);
    const artifact = JSON.parse(resultBytes);
    assert.deepEqual(artifact.result.output, { name: 'Ada', age: 36, active: true });
    assert.equal(artifact.result.validation.passed, true);
    assert.equal(artifact.receipt.input_artifact_sha256, artifactSha256);
    assert.equal(replies[1].result_artifact_sha256, sha(resultBytes));
    assert.equal((await handleRoomMessage({ message: order, journal, transport, adapt, price: 5,
      sellerPrincipalId: seller })).status, 'duplicate');
    assert.equal(uploads, 1);
  });
});

test('a second genuine payment reusing an order id cannot remain unrefunded', async () => {
  await withJournal(async (journal) => {
    const orderId = 'ord_smoke01';
    await journal.reserve({ order_id: orderId, transfer_id: 'txn_AbCdEfGhI1', artifact_id: artifactId,
      buyer_principal_id: buyer, message_id: 'msg_AbCdEfGhI1' });
    await journal.setStatus(orderId, 'fulfilled');
    const transferId = 'txn_AbCdEfGhI2';
    const message = { id: 'msg_AbCdEfGhI2', sender_principal_id: buyer,
      content: encodeOrderMessage({ orderId, artifactId, artifactSha256, transferId }) };
    const result = await handleRoomMessage({ message, journal, adapt, price: 5,
      sellerPrincipalId: seller, transport: {
        findTransfer: async () => ({ id: transferId, from: buyer, to: seller, amount: 5, memo: orderId }),
        download: async () => { throw new Error('never read artifact for reused order'); },
      } });
    assert.equal(result.status, 'refund_required');
    assert.equal(result.refund_amount, 5);
    const records = journal.snapshot().records;
    assert.equal(records.length, 2);
    assert.equal(records[0].status, 'fulfilled');
    assert.deepEqual({ id: records[1].order_id, claimed: records[1].claimed_order_id,
      transfer: records[1].transfer_id, status: records[1].status },
    { id: `refund_${transferId}`, claimed: orderId, transfer: transferId, status: 'refund_pending' });
    assert.equal((await handleRoomMessage({ message, journal, adapt, price: 5,
      sellerPrincipalId: seller, transport: {
        findTransfer: async () => ({ id: transferId, from: buyer, to: seller, amount: 5, memo: orderId }),
      } })).status, 'refund_required');
    assert.equal(journal.snapshot().records.length, 2);
    let paid = 0;
    const refundTransport = {
      findTransfer: async () => ({ id: transferId, from: buyer, to: seller, amount: 5, memo: orderId }),
      findRefund: async () => null,
      payRefund: async () => { paid++; return { transfer_id: 'txn_ZyXwVuTsRq' }; },
      reply: async (messageId, content) => {
        assert.equal(messageId, message.id);
        assert.equal(JSON.parse(content).code, 'order_id_reused');
        return { message_id: 'msg_ZyXwVuTsRq' };
      },
    };
    assert.equal((await processRefundRecord({ record: records[1], journal,
      transport: refundTransport, sellerPrincipalId: seller, refundsEnabled: true })).status, 'refunded');
    assert.equal((await processRefundRecord({ record: journal.snapshot().records[1], journal,
      transport: refundTransport, sellerPrincipalId: seller, refundsEnabled: true })).status, 'not_due');
    assert.equal(paid, 1);
  });
});

test('a reused order ID cannot refund a transfer from someone else', async () => {
  await withJournal(async (journal) => {
    const orderId = 'ord_smoke01';
    await journal.reserve({ order_id: orderId, transfer_id: 'txn_AbCdEfGhI1', artifact_id: artifactId,
      buyer_principal_id: buyer, message_id: 'msg_AbCdEfGhI1' });
    await journal.setStatus(orderId, 'fulfilled');
    const transferId = 'txn_AbCdEfGhI2';
    const message = { id: 'msg_AbCdEfGhI2', sender_principal_id: buyer,
      content: encodeOrderMessage({ orderId, artifactId, artifactSha256, transferId }) };
    const result = await handleRoomMessage({ message, journal, adapt, price: 5,
      sellerPrincipalId: seller, transport: {
        findTransfer: async () => ({ id: transferId, from: 'p_OtherBuyer1', to: seller,
          amount: 5, memo: orderId }),
      } });
    assert.equal(result.status, 'rejected');
    assert.equal(journal.snapshot().records.length, 1);
  });
});

test('two aged payments with the same memo but no order message receive distinct refund cases', async () => {
  await withJournal(async (journal) => {
    const orderId = 'ord_smoke01';
    const transfers = ['txn_AbCdEfGhI1', 'txn_AbCdEfGhI2'].map((id) => ({
      id, from: buyer, to: seller, amount: 5, memo: orderId,
      created_at: '2026-09-25T12:00:00Z',
    }));
    const args = { transfers, seenOrderIds: [], journal, sellerPrincipalId: seller,
      serviceStartedAt: '2026-09-25T11:00:00Z', now: '2026-09-25T12:10:00Z',
      graceMs: 300000, historyComplete: true };
    assert.equal((await stageOrphanRefunds(args)).length, 2);
    assert.equal((await stageOrphanRefunds(args)).length, 0);
    assert.deepEqual(journal.snapshot().records.map((r) => [r.order_id, r.transfer_id, r.status]), [
      ['refund_txn_AbCdEfGhI1', 'txn_AbCdEfGhI1', 'refund_pending'],
      ['refund_txn_AbCdEfGhI2', 'txn_AbCdEfGhI2', 'refund_pending'],
    ]);
  });
});

test('an aged extra payment is refunded even when its reused order ID was seen', async () => {
  await withJournal(async (journal) => {
    const orderId = 'ord_smoke01';
    await journal.reserve({ order_id: orderId, transfer_id: 'txn_AbCdEfGhI1', artifact_id: artifactId,
      buyer_principal_id: buyer, message_id: 'msg_AbCdEfGhI1' });
    await journal.setStatus(orderId, 'fulfilled');
    const staged = await stageOrphanRefunds({ transfers: [{ id: 'txn_AbCdEfGhI2',
      from: buyer, to: seller, amount: 5, memo: orderId, created_at: '2026-09-25T12:00:00Z' }],
    seenOrderIds: [orderId], journal, sellerPrincipalId: seller,
    serviceStartedAt: '2026-09-25T11:00:00Z', now: '2026-09-25T12:10:00Z',
    graceMs: 300000, historyComplete: true });
    assert.equal(staged.length, 1);
    assert.equal(journal.snapshot().records[1].refund_reason, 'order_id_reused');
  });
});

test('a mistyped transfer ID cannot hide the real payment from an aged refund scan', async () => {
  await withJournal(async (journal) => {
    const orderId = 'ord_typo001';
    const message = { id: 'msg_AbCdEfGhI2', sender_principal_id: buyer,
      content: encodeOrderMessage({ orderId, artifactId, artifactSha256,
        transferId: 'txn_AbCdEfGhI9' }) };
    const result = await handleRoomMessage({ message, journal, adapt, price: 5,
      sellerPrincipalId: seller, transport: { findTransfer: async () => null } });
    assert.equal(result.status, 'retry_later');
    const actual = { id: 'txn_AbCdEfGhI2', from: buyer, to: seller, amount: 5,
      memo: orderId, created_at: '2026-09-25T12:00:00Z' };
    const staged = await stageOrphanRefunds({ transfers: [actual], seenOrderIds: [orderId],
      journal, sellerPrincipalId: seller, serviceStartedAt: '2026-09-25T11:00:00Z',
      now: '2026-09-25T12:10:00Z', graceMs: 300000, historyComplete: true });
    assert.equal(staged.length, 1);
    assert.equal(journal.snapshot().records[0].refund_reason, 'order_unmatched');
    let paid = 0;
    const refunded = await processRefundRecord({ record: journal.snapshot().records[0],
      journal, sellerPrincipalId: seller, refundsEnabled: true,
      transport: { findTransfer: async () => actual, findRefund: async () => null,
        post: async (content) => {
          assert.equal(JSON.parse(content).code, 'order_unmatched');
          return { message_id: 'msg_ZyXwVuTsRq' };
        },
        payRefund: async ({ buyerPrincipalId, amount }) => {
          assert.equal(buyerPrincipalId, buyer);
          assert.equal(amount, 5);
          paid++;
          return { transfer_id: 'txn_ZyXwVuTsRq' };
        } } });
    assert.equal(refunded.status, 'refunded');
    assert.equal(paid, 1);
  });
});

test('a payment made by someone other than the order poster refunds its real sender', async () => {
  await withJournal(async (journal) => {
    const orderId = 'ord_other001';
    const transferId = 'txn_AbCdEfGhI2';
    const payer = 'p_OtherBuyer';
    const message = { id: 'msg_AbCdEfGhI2', sender_principal_id: buyer,
      content: encodeOrderMessage({ orderId, artifactId, artifactSha256, transferId }) };
    const actual = { id: transferId, from: payer, to: seller, amount: 5,
      memo: orderId, created_at: '2026-09-25T12:00:00Z' };
    const result = await handleRoomMessage({ message, journal, adapt, price: 5,
      sellerPrincipalId: seller, transport: { findTransfer: async () => actual } });
    assert.equal(result.status, 'rejected');
    const staged = await stageOrphanRefunds({ transfers: [actual], seenOrderIds: [orderId],
      journal, sellerPrincipalId: seller, serviceStartedAt: '2026-09-25T11:00:00Z',
      now: '2026-09-25T12:10:00Z', graceMs: 300000, historyComplete: true });
    assert.equal(staged.length, 1);
    assert.equal(journal.snapshot().records[0].buyer_principal_id, payer);
    const refunded = await processRefundRecord({ record: journal.snapshot().records[0],
      journal, sellerPrincipalId: seller, refundsEnabled: true,
      transport: { findTransfer: async () => actual, findRefund: async () => null,
        post: async (content) => {
          assert.equal(JSON.parse(content).order_id, orderId);
          return { message_id: 'msg_ZyXwVuTsRq' };
        },
        payRefund: async ({ buyerPrincipalId }) => {
          assert.equal(buyerPrincipalId, payer);
          return { transfer_id: 'txn_ZyXwVuTsRq' };
        } } });
    assert.equal(refunded.status, 'refunded');
  });
});
