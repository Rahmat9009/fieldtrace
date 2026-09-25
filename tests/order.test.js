import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeOrderMessage, placeOrder } from '../client/order.js';
import { assessOrder, parseOrderMessage } from '../worker/intake.js';

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

test('correlates the exact sender, recipient, room, price, memo and transfer', () => {
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'found', bytes }, ...context }).status, 'ready');
  for (const [field, value] of [
    ['from', seller], ['to', buyer], ['room_id', 'rom_OtherRoom'],
    ['memo', 'ord_wrong'], ['amount', 7], ['id', 'txn_Other1234'],
  ]) {
    assert.equal(assessOrder({ order, transfer: { ...transfer, [field]: value }, artifact: { status: 'found', bytes }, ...context }).code, 'payment_mismatch');
  }
});

test('a transfer cannot fulfill a second order and exact retries are idempotent', () => {
  const prior = [{ order_id: orderId, transfer_id: transferId, artifact_id: artifactId, status: 'fulfilled' }];
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'found', bytes }, prior, ...context }).status, 'duplicate');
  assert.equal(assessOrder({ order: { ...order, orderId: 'ord_87654321-1234-4234-8234-123456789abc' }, transfer, artifact: { status: 'found', bytes }, prior, ...context }).code, 'order_or_transfer_reused');
});

test('missing or altered payload takes a refund path only after payment verification', () => {
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'missing' }, ...context }).status, 'refund_required');
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'temporary_error' }, ...context }).status, 'retry_later');
  assert.equal(assessOrder({ order, transfer, artifact: { status: 'found', bytes: Buffer.from('changed') }, ...context }).code, 'artifact_hash_mismatch');
  assert.equal(assessOrder({ order, transfer: { ...transfer, to: buyer }, artifact: { status: 'missing' }, ...context }).status, 'rejected');
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
