import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  assessOrder, assessPreflight, findOrphanPayments, parseOrderMessage, parsePreflightMessage,
} from './intake.js';

function journalRecord(order) {
  return {
    order_id: order.orderId, transfer_id: order.transferId,
    artifact_id: order.artifactId, buyer_principal_id: order.buyerPrincipalId,
    message_id: order.messageId,
  };
}

/**
 * Transport contract:
 * - findTransfer(id) -> normalized ledger transfer or null
 * - download(id) -> {status:'found',bytes} | {status:'missing'|'temporary_error'}
 * - upload(bytes, filename) -> {artifact_id}
 * - reply(messageId, content) -> {message_id}
 * No refund is executed here. Every refund decision is journaled for a
 * policy-aware executor to reconcile and perform once.
 */
export async function handleRoomMessage({ message, transport, journal, adapt, price, sellerPrincipalId }) {
  let preflight;
  let order;
  try {
    preflight = parsePreflightMessage(message);
    if (!preflight) order = parseOrderMessage(message);
  } catch (error) {
    if (error instanceof TypeError) return { status: 'invalid_message', code: 'malformed_envelope' };
    throw error;
  }
  if (preflight) {
    const artifact = await transport.download(preflight.artifactId);
    const decision = await assessPreflight({ preflight, artifact, adapt, price });
    if (decision.status === 'retry_later') return decision;
    await transport.reply(preflight.messageId, JSON.stringify({
      type: 'fieldtrace.preflight.result.v1', artifact_id: preflight.artifactId, ...decision,
    }));
    return decision;
  }

  if (!order) return { status: 'ignored' };
  const prior = journal.snapshot().records;
  const transfer = await transport.findTransfer(order.transferId);
  // Payment is checked before any artifact download. A malformed or absent
  // transfer cannot induce us to read a third party's private artifact.
  const paymentOnly = assessOrder({ order, transfer, prior, sellerPrincipalId, price });
  if (paymentOnly.status === 'duplicate' || paymentOnly.status === 'rejected') return paymentOnly;
  if (paymentOnly.status === 'retry_later' && paymentOnly.code !== 'artifact_unavailable') return paymentOnly;
  if (paymentOnly.status === 'refund_required') {
    await journal.reserve(journalRecord(order));
    await journal.setStatus(order.orderId, 'refund_pending', {
      refund_reason: paymentOnly.code, refund_amount: paymentOnly.refund_amount,
    });
    return paymentOnly;
  }

  const artifact = await transport.download(order.artifactId);
  const decision = assessOrder({ order, transfer, artifact, prior, sellerPrincipalId, price });
  if (decision.status === 'retry_later' || decision.status === 'rejected') return decision;
  await journal.reserve(journalRecord(order));
  if (decision.status === 'refund_required') {
    await journal.setStatus(order.orderId, 'refund_pending', {
      refund_reason: decision.code, refund_amount: decision.refund_amount,
    });
    return decision;
  }
  const result = await adapt(decision.request);
  if (result?.status !== 'ok' || result.convertible !== true) {
    await journal.setStatus(order.orderId, 'refund_pending', {
      refund_reason: result?.code ?? 'conversion_failed', refund_amount: transfer.amount,
    });
    return { status: 'refund_required', code: result?.code ?? 'conversion_failed', refund_amount: transfer.amount };
  }

  await journal.setStatus(order.orderId, 'delivery_pending');
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');
  const target = decision.request.target_schema ?? decision.request.target_example;
  const targetDigest = sha256(Buffer.from(JSON.stringify(target)));
  const schemaProvided = decision.request.target_schema !== undefined;
  const receipt = {
    claim: 'This adapted output conforms to the supplied target for this conversion; no claim of factual truth.',
    input_artifact_sha256: order.artifactSha256,
    ...(schemaProvided ? { schema_sha256: targetDigest } : { target_example_sha256: targetDigest }),
    adapted_output_sha256: sha256(Buffer.from(JSON.stringify(result.output))),
    target_kind: schemaProvided ? 'schema' : 'example_inferred',
    target_hash_method: 'SHA-256 of UTF-8 Node JSON.stringify(parsed target)',
  };
  const bytes = Buffer.from(JSON.stringify({ order_id: order.orderId, result, receipt }));
  const resultArtifactSha256 = sha256(bytes);
  const uploaded = await transport.upload(bytes, `${order.orderId}-result.json`);
  if (!/^art_[A-Za-z0-9]{10}$/.test(uploaded?.artifact_id ?? '')) {
    throw new Error('Result upload was not confirmed; reconcile before retrying');
  }
  await journal.setStatus(order.orderId, 'reply_pending', { result_artifact_id: uploaded.artifact_id });
  const reply = await transport.reply(order.messageId, JSON.stringify({
    type: 'fieldtrace.delivery.v1', order_id: order.orderId, result_artifact_id: uploaded.artifact_id,
    result_artifact_sha256: resultArtifactSha256, receipt,
  }));
  if (!/^msg_[A-Za-z0-9]{10}$/.test(reply?.message_id ?? '')) {
    throw new Error('Delivery reply was not confirmed; reconcile before retrying');
  }
  await journal.setStatus(order.orderId, 'fulfilled', {
    delivery_message_id: reply.message_id,
    result_artifact_sha256: resultArtifactSha256,
    overpayment_refund_amount: decision.overpayment_refund_amount,
  });
  return { status: 'fulfilled', order_id: order.orderId, result_artifact_id: uploaded.artifact_id,
    result_artifact_sha256: resultArtifactSha256, overpayment_refund_amount: decision.overpayment_refund_amount };
}

/** Records aged payments with no order message; the caller must recheck first. */
export async function stageOrphanRefunds({ transfers, seenOrderIds, journal, sellerPrincipalId, serviceStartedAt, now, graceMs, historyComplete }) {
  const candidates = findOrphanPayments({ transfers, seenOrderIds, prior: journal.snapshot().records,
    sellerPrincipalId, serviceStartedAt, now, graceMs, historyComplete });
  for (const candidate of candidates) {
    await journal.reserve({ order_id: candidate.order_id, transfer_id: candidate.transfer_id,
      artifact_id: null, buyer_principal_id: candidate.buyer_principal_id, message_id: null });
    await journal.setStatus(candidate.order_id, 'refund_pending', {
      refund_reason: candidate.code, refund_amount: candidate.refund_amount,
    });
  }
  return candidates;
}
