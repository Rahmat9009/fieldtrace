import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeOrderMessage, encodePreflightMessage, placeOrder } from '../client/order.js';
import { assessOrder, assessPreflight, findOrphanPayments, parseOrderMessage, parsePreflightMessage } from '../worker/intake.js';

const orderId = 'ord_12345678-1234-4234-8234-123456789abc';
const artifactId = 'art_AbCdEfGhIj';
const transferId = 'txn_AbCdEfGhIj';
const buyer = 'p_AbCdEfGhIj';
const seller = 'p_ZyXwVuTsRq';
const room = 'rom_AbCdEfGhIj';
const bytes = Buffer.from(JSON.stringify({ mode: 'convert', direction: 'request', payload: { x: 1 }, target_example: { x: 1 } }));
const hash = createHash('sha256').update(bytes).digest('hex');
const message = {
  id: 'msg_AbCdEfGhIj', sender_principal_id: buyer,
  content: encodeOrderMessage({ orderId, artifactId, transferId, artifactSha256: hash }),
};
const order = parseOrderMessage(message);
const transfer = { id: transferId, from: buyer, to: seller, amount: 8, memo: orderId, room_id: room };
const context = { sellerPrincipalId: seller, roomId: room, price: 8 };

test('correlates the exact sender, recipient, price, memo and transfer', () => {
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'found', bytes }, ...context }).status, 'ready');
  for (const [field, value] of [
    ['from', seller], ['to', buyer], ['id', 'txn_Other1234'],
  ]) {
    assert.equal(assessOrder({ order, transfer: { ...transfer, [field]: value }, artifact: { status: 'found', bytes }, ...context }).code, 'payment_mismatch');
  }
});

test('plain SharedNet orders accept a short hand-written ID and an unassociated payment', () => {
  const handOrderId = 'ord_manual01';
  const handOrder = parseOrderMessage({ ...message, content: encodeOrderMessage({ orderId: handOrderId, artifactId, transferId, artifactSha256: hash }) });
  const decision = assessOrder({ order: handOrder, transfer: { ...transfer, memo: handOrderId, room_id: null }, artifact: { status: 'found', bytes }, ...context });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.overpayment_refund_amount, 0);
});

test('verified underpayment or wrong memo requires a full refund; overpayment is delivered and excess refunded', () => {
  for (const [change, expectedCode] of [
    [{ amount: 7 }, 'underpaid'],
    [{ memo: 'ord_other123' }, 'memo_mismatch'],
  ]) {
    const decision = assessOrder({ order, transfer: { ...transfer, ...change }, artifact: { status: 'found', bytes }, ...context });
    assert.equal(decision.status, 'refund_required');
    assert.equal(decision.code, expectedCode);
    assert.equal(decision.refund_amount, change.amount ?? transfer.amount);
  }
  const overpaid = assessOrder({ order, transfer: { ...transfer, amount: 10, room_id: null }, artifact: { status: 'found', bytes }, ...context });
  assert.equal(overpaid.status, 'ready');
  assert.equal(overpaid.overpayment_refund_amount, 2);
});

test('a transfer cannot fulfill a second order and exact retries are idempotent', () => {
  const prior = [{ order_id: orderId, transfer_id: transferId, artifact_id: artifactId, status: 'fulfilled' }];
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'found', bytes }, prior, ...context }).status, 'duplicate');
  assert.equal(assessOrder({ order: { ...order, orderId: 'ord_87654321-1234-4234-8234-123456789abc' }, transfer, artifact: { status: 'found', bytes }, prior, ...context }).code, 'order_or_transfer_reused');
});

test('missing or altered payload takes a refund path only after payment verification', () => {
  const missing = assessOrder({ order, transfer, artifact: { status: 'missing' }, ...context });
  assert.equal(missing.status, 'refund_required');
  assert.equal(missing.refund_amount, 8);
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'too_large' }, ...context }).code, 'artifact_too_large');
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'temporary_error' }, ...context }).status, 'retry_later');
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'found', bytes: Buffer.from('changed') }, ...context }).code, 'artifact_hash_mismatch');
  assert.equal(assessOrder({ order, transfer: { ...transfer, to: buyer }, artifact: { status: 'missing' }, ...context }).status, 'rejected');
});

test('missing request mode defaults to convert without triggering a refund', () => {
  const noModeBytes = Buffer.from(JSON.stringify({ direction: 'request', payload: { x: 1 }, target_example: { x: 1 } }));
  const noModeOrder = { ...order, artifactSha256: createHash('sha256').update(noModeBytes).digest('hex') };
  const decision = assessOrder({ order: noModeOrder, transfer, artifact: { status: 'found', bytes: noModeBytes }, ...context });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.request.mode, 'convert');
});

test('free preflight returns only convertibility, count and quote', async () => {
  const preflight = parsePreflightMessage({ ...message, content: encodePreflightMessage({ artifactId, artifactSha256: hash }) });
  const result = await assessPreflight({ preflight, artifact: { status: 'found', bytes }, price: 8,
    adapt: () => ({ status: 'ok', convertible: true, changes: [{ path: '/x' }], output: { secret: true } }),
  });
  assert.deepEqual(result, { status: 'ok', convertible: true, change_count: 1, price: 8 });
  assert.equal('output' in result, false);
  const newer = await assessPreflight({ preflight, artifact: { status: 'found', bytes }, price: 8,
    adapt: () => ({ status: 'ok', convertible: true, change_count: 3 }),
  });
  assert.equal(newer.change_count, 3);
});

test('orphan scan only proposes refunds after a complete, aged ledger and room scan', () => {
  const orphan = { ...transfer, created_at: '2026-09-25T12:00:00Z' };
  const scan = (overrides = {}) => findOrphanPayments({
    transfers: [orphan], seenOrderIds: [], sellerPrincipalId: seller,
    serviceStartedAt: '2026-09-25T11:00:00Z', now: '2026-09-25T12:10:00Z',
    graceMs: 5 * 60 * 1000, historyComplete: true, ...overrides,
  });
  assert.equal(scan().length, 1);
  assert.equal(scan()[0].refund_amount, 8);
  assert.deepEqual(scan({ historyComplete: false }), []);
  assert.deepEqual(scan({ seenOrderIds: [orderId] }), []);
  assert.deepEqual(scan({ prior: [{ transfer_id: transferId }] }), []);
  assert.deepEqual(scan({ now: '2026-09-25T12:01:00Z' }), []);
});

test('buyer never pays after failed remote preflight', async () => {
  let paid = false;
  const result = await placeOrder({ request: { payload: {} }, price: 8, sellerPrincipalId: seller, orderId,
    transport: { preflight: async () => ({ status: 'unsupported', convertible: false }), pay: async () => { paid = true; } },
  });
  assert.equal(result.status, 'not_convertible');
  assert.equal(paid, false);
});

test('uncertain payment cannot trigger a second debit or an order post', async () => {
  let posts = 0;
  let payments = 0;
  const result = await placeOrder({ request: { payload: {} }, price: 8, sellerPrincipalId: seller, orderId,
    transport: {
      preflight: async () => ({ status: 'ok', convertible: true }),
      upload: async () => ({ artifact: { id: artifactId } }),
      pay: async () => { payments++; throw new Error('connection dropped'); },
      post: async () => { posts++; },
    },
  });
  assert.equal(result.status, 'payment_unconfirmed');
  assert.equal(payments, 1);
  assert.equal(posts, 0);
});

test('confirmed payment followed by uncertain post retains recovery fields', async () => {
  const result = await placeOrder({ request: { payload: {} }, price: 8, sellerPrincipalId: seller, orderId,
    transport: {
      preflight: async () => ({ status: 'ok', convertible: true }),
      upload: async () => ({ artifact: { id: artifactId } }),
      pay: async () => ({ transfer: { id: transferId } }),
      post: async () => { throw new Error('connection dropped'); },
    },
  });
  assert.equal(result.status, 'order_message_unconfirmed');
  assert.equal(result.transfer_id, transferId);
  assert.equal(JSON.parse(result.content).order_id, orderId);
});
