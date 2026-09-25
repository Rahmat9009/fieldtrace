import { createHash, randomUUID } from 'node:crypto';

export const ORDER_TYPE = 'fieldtrace.order.v1';
export const ORDER_ID_PATTERN = /^ord_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9]{10}$/;
export const TRANSFER_ID_PATTERN = /^txn_[A-Za-z0-9]{10}$/;

export function newOrderId() {
  return `ord_${randomUUID()}`;
}

export function paymentMemo(orderId) {
  if (!ORDER_ID_PATTERN.test(orderId)) throw new TypeError('Invalid order_id');
  return orderId;
}

export function encodeOrderMessage({ orderId, artifactId, transferId, artifactSha256 }) {
  paymentMemo(orderId);
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new TypeError('Invalid artifact_id');
  if (!TRANSFER_ID_PATTERN.test(transferId)) throw new TypeError('Invalid transfer_id');
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new TypeError('Invalid artifact_sha256');
  return JSON.stringify({
    type: ORDER_TYPE,
    order_id: orderId,
    artifact_id: artifactId,
    artifact_sha256: artifactSha256,
    transfer_id: transferId,
  });
}

/**
 * Buyer-side orchestration. `transport` is the authenticated SharedNet boundary.
 * It must return confirmed IDs; an uncertain payment is never retried here.
 * Free preflight runs remotely, so this module contains no adapter logic.
 */
export async function placeOrder({ request, price, sellerPrincipalId, transport, orderId = newOrderId() }) {
  paymentMemo(orderId);
  if (!Number.isSafeInteger(price) || price < 1) throw new TypeError('Invalid price');
  if (!/^p_[A-Za-z0-9]{10}$/.test(sellerPrincipalId)) throw new TypeError('Invalid seller principal');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Invalid request');

  const preflight = await transport.preflight({ ...request, mode: 'preflight' });
  if (preflight?.status !== 'ok' || preflight.convertible !== true) {
    return { status: 'not_convertible', order_id: orderId, preflight };
  }

  const bytes = Buffer.from(JSON.stringify({ ...request, mode: 'convert' }));
  const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  const upload = await transport.upload(bytes, { filename: `${orderId}.json` });
  if (!ARTIFACT_ID_PATTERN.test(upload?.artifact?.id ?? upload?.id)) {
    throw new Error('Upload did not confirm an artifact ID');
  }
  const artifactId = upload.artifact?.id ?? upload.id;

  let payment;
  try {
    payment = await transport.pay(sellerPrincipalId, price, { memo: paymentMemo(orderId), room: true });
  } catch (error) {
    return {
      status: 'payment_unconfirmed', order_id: orderId, artifact_id: artifactId,
      reason: error.message, action: 'Check the ledger before any retry.',
    };
  }
  const transferId = payment?.transfer?.id;
  if (!TRANSFER_ID_PATTERN.test(transferId)) {
    return {
      status: 'payment_unconfirmed', order_id: orderId, artifact_id: artifactId,
      action: 'Check the ledger before any retry.',
    };
  }

  const content = encodeOrderMessage({ orderId, artifactId, transferId, artifactSha256 });
  try {
    const post = await transport.post(content);
    if (!/^msg_[A-Za-z0-9]{10}$/.test(post?.message?.id ?? post?.id)) {
      throw new Error('Order message was not confirmed');
    }
    return { status: 'ordered', order_id: orderId, artifact_id: artifactId, transfer_id: transferId, message_id: post.message?.id ?? post.id };
  } catch (error) {
    return {
      status: 'order_message_unconfirmed', order_id: orderId, artifact_id: artifactId,
      transfer_id: transferId, content, reason: error.message,
      action: 'Check the room for this order_id before reposting; do not pay again.',
    };
  }
}
