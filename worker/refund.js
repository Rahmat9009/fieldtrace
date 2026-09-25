/**
 * Reconciles a refund against the ledger before paying. This may move credits
 * only when an operator explicitly enables refunds after checking event rules.
 * An uncertain pay result is never automatically retried.
 */
export async function processRefundRecord({ record, transport, journal, sellerPrincipalId, refundsEnabled }) {
  const full = record.status === 'refund_pending';
  const excess = record.status === 'fulfilled' && record.overpayment_refund_amount > 0;
  if (!full && !excess) return { status: 'not_due' };
  if (record.refund_transfer_id || record.refund_status === 'confirmed') return { status: 'already_refunded' };
  const amount = full ? record.refund_amount : record.overpayment_refund_amount;
  if (!Number.isSafeInteger(amount) || amount < 1) return { status: 'invalid_refund_amount' };
  const original = await transport.findTransfer(record.transfer_id);
  if (!original || original.from !== record.buyer_principal_id || original.to !== sellerPrincipalId
    || !Number.isSafeInteger(original.amount) || amount > original.amount) {
    return { status: 'original_transfer_unverified' };
  }
  const memo = `refund:${record.order_id}:${record.transfer_id}`;
  const existing = await transport.findRefund({ buyerPrincipalId: original.from,
    sellerPrincipalId, amount, memo });
  if (existing) {
    await journal.setStatus(record.order_id, full ? 'refunded' : 'fulfilled', {
      refund_status: 'confirmed', refund_transfer_id: existing.id,
    });
    return { status: 'refunded', transfer_id: existing.id };
  }
  if (record.refund_status === 'confirmation_pending') return { status: 'manual_reconciliation' };
  if (!refundsEnabled) return { status: 'policy_pending' };
  await journal.setStatus(record.order_id, record.status, { refund_status: 'confirmation_pending' });
  let paid;
  try {
    paid = await transport.payRefund({ buyerPrincipalId: original.from, amount, memo });
  } catch {
    return { status: 'manual_reconciliation' };
  }
  if (!/^txn_[A-Za-z0-9]{10}$/.test(paid?.transfer_id ?? '')) {
    return { status: 'manual_reconciliation' };
  }
  await journal.setStatus(record.order_id, full ? 'refunded' : 'fulfilled', {
    refund_status: 'confirmed', refund_transfer_id: paid.transfer_id,
  });
  return { status: 'refunded', transfer_id: paid.transfer_id };
}
