import { createHash } from 'node:crypto';
import {
  ARTIFACT_ID_PATTERN, ORDER_ID_PATTERN, ORDER_TYPE, PREFLIGHT_TYPE, TRANSFER_ID_PATTERN,
} from '../client/order.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

function parseEnvelope(message, type) {
  if (typeof message?.content !== 'string') return null;
  let envelope;
  try { envelope = JSON.parse(message.content); } catch { return null; }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.type !== type) return null;
  if (!/^p_[A-Za-z0-9]{10}$/.test(message.sender_principal_id ?? '')) {
    throw new TypeError('FieldTrace message has no valid sender principal');
  }
  if (!ARTIFACT_ID_PATTERN.test(envelope.artifact_id) || !SHA256_PATTERN.test(envelope.artifact_sha256)) {
    throw new TypeError('Malformed FieldTrace artifact reference');
  }
  return { envelope, buyerPrincipalId: message.sender_principal_id, messageId: message.id };
}

/** Returns null for unrelated room messages; rejects malformed order envelopes. */
export function parseOrderMessage(message) {
  const parsed = parseEnvelope(message, ORDER_TYPE);
  if (!parsed) return null;
  const order = parsed.envelope;
  if (!ORDER_ID_PATTERN.test(order.order_id) || !TRANSFER_ID_PATTERN.test(order.transfer_id)) {
    throw new TypeError('Malformed FieldTrace order');
  }
  return {
    orderId: order.order_id,
    artifactId: order.artifact_id,
    artifactSha256: order.artifact_sha256,
    transferId: order.transfer_id,
    buyerPrincipalId: parsed.buyerPrincipalId,
    messageId: parsed.messageId,
  };
}

export function parsePreflightMessage(message) {
  const parsed = parseEnvelope(message, PREFLIGHT_TYPE);
  if (!parsed) return null;
  return {
    artifactId: parsed.envelope.artifact_id,
    artifactSha256: parsed.envelope.artifact_sha256,
    buyerPrincipalId: parsed.buyerPrincipalId,
    messageId: parsed.messageId,
  };
}

/** Ledger records are normalized to {id, from, to, amount, memo, room_id}. */
export function verifyTransfer(order, transfer, { sellerPrincipalId, price }) {
  if (!transfer) return { ok: false, code: 'transfer_not_found', retryable: true };
  if (transfer.id !== order.transferId || transfer.from !== order.buyerPrincipalId || transfer.to !== sellerPrincipalId) {
    return { ok: false, code: 'payment_mismatch' };
  }
  if (!Number.isSafeInteger(transfer.amount) || transfer.amount < 1) {
    return { ok: false, code: 'invalid_ledger_amount', retryable: true };
  }
  if (transfer.memo !== order.orderId) {
    return { ok: false, code: 'memo_mismatch', refundable: true, refundAmount: transfer.amount };
  }
  if (transfer.amount < price) {
    return { ok: false, code: 'underpaid', refundable: true, refundAmount: transfer.amount };
  }
  // Room association is optional on `sharednet pay`; it is not an identity check.
  return { ok: true, overpayment: transfer.amount - price };
}

function inspectArtifact(artifact, expectedSha256) {
  if (!artifact || artifact.status === 'temporary_error') return { status: 'retry_later', code: 'artifact_unavailable' };
  if (artifact.status === 'missing') return { status: 'invalid', code: 'artifact_missing' };
  if (artifact.status === 'too_large') return { status: 'invalid', code: 'artifact_too_large' };
  if (artifact.status !== 'found' || !Buffer.isBuffer(artifact.bytes)) {
    return { status: 'retry_later', code: 'artifact_unavailable' };
  }
  if (artifact.bytes.length > MAX_ARTIFACT_BYTES) return { status: 'invalid', code: 'artifact_too_large' };
  const digest = createHash('sha256').update(artifact.bytes).digest('hex');
  if (digest !== expectedSha256) return { status: 'invalid', code: 'artifact_hash_mismatch' };
  let request;
  try { request = JSON.parse(artifact.bytes.toString('utf8')); } catch {
    return { status: 'invalid', code: 'invalid_payload_json' };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 'invalid', code: 'invalid_conversion_request' };
  }
  return { status: 'found', request };
}

/**
 * Pure intake decision. `prior` is the durable journal's records, not an
 * in-memory cache. No adapter or payment side effect occurs in this function.
 * `artifact` is {status:'found', bytes}, {status:'missing'}, or
 * {status:'temporary_error'}; only a confirmed missing payload can be refunded.
 */
export function assessOrder({ order, transfer, artifact, prior = [], sellerPrincipalId, price }) {
  const sameOrder = prior.find((record) => record.order_id === order.orderId);
  const sameTransfer = prior.find((record) => record.transfer_id === order.transferId);
  if (sameOrder || sameTransfer) {
    if (sameOrder?.transfer_id === order.transferId && sameOrder.artifact_id === order.artifactId) {
      return { status: 'duplicate', record: sameOrder };
    }
    return { status: 'rejected', code: 'order_or_transfer_reused' };
  }

  const payment = verifyTransfer(order, transfer, { sellerPrincipalId, price });
  if (!payment.ok) {
    if (payment.refundable) return {
      status: 'refund_required', code: payment.code, transfer_id: order.transferId,
      buyer_principal_id: order.buyerPrincipalId, refund_amount: payment.refundAmount,
    };
    return { status: payment.retryable ? 'retry_later' : 'rejected', code: payment.code };
  }
  const payload = inspectArtifact(artifact, order.artifactSha256);
  if (payload.status === 'retry_later') return payload;
  if (payload.status === 'invalid') return {
    status: 'refund_required', code: payload.code, transfer_id: order.transferId,
    buyer_principal_id: order.buyerPrincipalId, refund_amount: transfer.amount,
  };
  const request = { mode: 'convert', ...payload.request };
  if (request.mode !== 'convert') return {
    status: 'refund_required', code: 'invalid_conversion_request', transfer_id: order.transferId,
    buyer_principal_id: order.buyerPrincipalId, refund_amount: transfer.amount,
  };
  return { status: 'ready', order, request, overpayment_refund_amount: payment.overpayment };
}

/** A free, server-side preflight. Detailed changes and output stay private. */
export async function assessPreflight({ preflight, artifact, adapt, price }) {
  const payload = inspectArtifact(artifact, preflight.artifactSha256);
  if (payload.status !== 'found') return { status: payload.status, code: payload.code };
  const result = await adapt({ ...payload.request, mode: 'preflight' });
  if (result?.status === 'ok' && result.convertible === true) {
    return { status: 'ok', convertible: true,
      change_count: result.change_count ?? result.changes?.length ?? 0, price };
  }
  return { status: 'unsupported', convertible: false, code: result?.code ?? 'invalid_request', path: result?.path ?? '' };
}

/**
 * Reconciliation candidate scan. The caller must supply a complete order
 * message window and a durable journal, then recheck both before refunding.
 */
export function findOrphanPayments({ transfers, seenOrderIds, prior = [], sellerPrincipalId, serviceStartedAt, now, graceMs, historyComplete }) {
  if (!historyComplete || !Number.isSafeInteger(graceMs) || graceMs < 1) return [];
  const start = Date.parse(serviceStartedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return [];
  const seen = new Set(seenOrderIds);
  const recorded = new Set(prior.map((record) => record.transfer_id));
  const recordedOrders = new Set(prior.flatMap((record) =>
    [record.order_id, record.claimed_order_id].filter(Boolean)));
  return transfers.filter((transfer) => {
    const created = Date.parse(transfer.created_at);
    return transfer.to === sellerPrincipalId
      && /^p_[A-Za-z0-9]{10}$/.test(transfer.from ?? '')
      && ORDER_ID_PATTERN.test(transfer.memo ?? '')
      && Number.isSafeInteger(transfer.amount) && transfer.amount > 0
      && Number.isFinite(created) && created >= start && current - created >= graceMs
      && !recorded.has(transfer.id);
  }).map((transfer) => ({
    status: 'refund_required',
    code: recordedOrders.has(transfer.memo) ? 'order_id_reused'
      : seen.has(transfer.memo) ? 'order_unmatched' : 'order_message_missing',
    order_id: transfer.memo,
    transfer_id: transfer.id, buyer_principal_id: transfer.from, refund_amount: transfer.amount,
  }));
}
