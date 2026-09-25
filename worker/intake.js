import { createHash } from 'node:crypto';
import {
  ARTIFACT_ID_PATTERN, ORDER_ID_PATTERN, ORDER_TYPE, TRANSFER_ID_PATTERN,
} from '../client/order.js';

/** Returns null for unrelated room messages; rejects malformed order envelopes. */
export function parseOrderMessage(message) {
  if (typeof message?.content !== 'string') return null;
  let order;
  try { order = JSON.parse(message.content); } catch { return null; }
  if (!order || typeof order !== 'object' || Array.isArray(order) || order.type !== ORDER_TYPE) return null;
  if (!ORDER_ID_PATTERN.test(order.order_id)
    || !ARTIFACT_ID_PATTERN.test(order.artifact_id)
    || !TRANSFER_ID_PATTERN.test(order.transfer_id)
    || !/^[a-f0-9]{64}$/.test(order.artifact_sha256)) {
    throw new TypeError('Malformed FieldTrace order');
  }
  if (!/^p_[A-Za-z0-9]{10}$/.test(message.sender_principal_id ?? '')) {
    throw new TypeError('Order message has no valid sender principal');
  }
  return {
    orderId: order.order_id,
    artifactId: order.artifact_id,
    artifactSha256: order.artifact_sha256,
    transferId: order.transfer_id,
    buyerPrincipalId: message.sender_principal_id,
    messageId: message.id,
  };
}

/** Ledger records are normalized to {id, from, to, amount, memo, room_id}. */
export function verifyTransfer(order, transfer, { sellerPrincipalId, roomId, price }) {
  if (!transfer) return { ok: false, code: 'transfer_not_found' };
  const matches = transfer.id === order.transferId
    && transfer.from === order.buyerPrincipalId
    && transfer.to === sellerPrincipalId
    && transfer.room_id === roomId
    && transfer.memo === order.orderId
    && transfer.amount === price;
  return matches ? { ok: true } : { ok: false, code: 'payment_mismatch' };
}

/**
 * Pure intake decision. `prior` is the durable journal's records, not an
 * in-memory cache. No adapter or payment side effect occurs in this function.
 * `artifact` is {status:'found', bytes}, {status:'missing'}, or
 * {status:'temporary_error'}; only a confirmed missing payload can be refunded.
 */
export function assessOrder({ order, transfer, artifact, prior = [], sellerPrincipalId, roomId, price }) {
  const sameOrder = prior.find((record) => record.order_id === order.orderId);
  const sameTransfer = prior.find((record) => record.transfer_id === order.transferId);
  if (sameOrder || sameTransfer) {
    if (sameOrder?.transfer_id === order.transferId && sameOrder.artifact_id === order.artifactId) {
      return { status: 'duplicate', record: sameOrder };
    }
    return { status: 'rejected', code: 'order_or_transfer_reused' };
  }

  const payment = verifyTransfer(order, transfer, { sellerPrincipalId, roomId, price });
  if (!payment.ok) return { status: 'rejected', code: payment.code };
  if (artifact?.status === 'temporary_error' || !artifact) {
    return { status: 'retry_later', code: 'artifact_unavailable' };
  }
  if (artifact.status === 'missing') {
    return { status: 'refund_required', code: 'artifact_missing', transfer_id: order.transferId, buyer_principal_id: order.buyerPrincipalId };
  }
  if (artifact.status !== 'found' || !Buffer.isBuffer(artifact.bytes)) {
    return { status: 'retry_later', code: 'artifact_unavailable' };
  }
  const digest = createHash('sha256').update(artifact.bytes).digest('hex');
  if (digest !== order.artifactSha256) {
    return { status: 'refund_required', code: 'artifact_hash_mismatch', transfer_id: order.transferId, buyer_principal_id: order.buyerPrincipalId };
  }
  let request;
  try { request = JSON.parse(artifact.bytes.toString('utf8')); } catch {
    return { status: 'refund_required', code: 'invalid_payload_json', transfer_id: order.transferId, buyer_principal_id: order.buyerPrincipalId };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.mode !== 'convert') {
    return { status: 'refund_required', code: 'invalid_conversion_request', transfer_id: order.transferId, buyer_principal_id: order.buyerPrincipalId };
  }
  return { status: 'ready', order, request };
}
