import { parseOrderMessage } from './intake.js';
import { handleRoomMessage, stageOrphanRefunds } from './service.js';
import { processRefundRecord } from './refund.js';

const pauseDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processMessage({ message, pending, journal, transport, adapt, price, sellerPrincipalId, log }) {
  try {
    // Keep the order index even if delivery must be retried. This is also the
    // complete message history used to distinguish an orphan transfer.
    let order;
    try { order = parseOrderMessage(message); } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    if (order) await journal.noteOrderId(order.orderId);
    const outcome = await handleRoomMessage({ message, transport, journal, adapt, price, sellerPrincipalId });
    if (outcome.status === 'retry_later') await journal.queueMessage(message);
    else if (pending) await journal.removeMessage(message.id);
  } catch (error) {
    await journal.queueMessage(message);
    await log(`Message ${message.id ?? 'unknown'} failed; queued for retry: ${error.stack ?? error}`);
  }
  if (!pending) await journal.advanceCursor(message.sequence);
}

/** One polling cycle. Per-message failures never prevent later messages. */
export async function runCycle({ journal, transport, adapt, price, sellerPrincipalId,
  serviceStartedAt, graceMs, refundsEnabled, log, state = {}, now = Date.now }) {
  let hasMore;
  do {
    const page = await transport.readPage(journal.snapshot().cursor);
    for (const message of page.items) {
      await processMessage({ message, pending: false, journal, transport, adapt, price, sellerPrincipalId, log });
    }
    if (page.has_more && page.items.length === 0) throw new Error('SharedNet read returned an empty nonterminal page');
    hasMore = page.has_more;
  } while (hasMore);

  // New intake takes priority over retries so a backlog of unavailable
  // artifacts cannot prevent a later buyer from being served.
  const pending = journal.snapshot().pending_messages;
  const start = (state.pendingOffset ?? 0) % Math.max(pending.length, 1);
  for (let index = 0; index < Math.min(pending.length, 10); index++) {
    const message = pending[(start + index) % pending.length];
    await processMessage({ message, pending: true, journal, transport, adapt, price, sellerPrincipalId, log });
  }
  state.pendingOffset = start + Math.min(pending.length, 10);

  if (graceMs !== null && now() - (state.lastOrphanScan ?? 0) > 60000) {
    if (!journal.snapshot().order_index_complete) {
      // One-time migration for a journal created before the incremental index.
      const room = await transport.readAllOrderIds();
      if (!room.historyComplete) throw new Error('Order index backfill was incomplete');
      await journal.completeOrderIndex(room.orderIds);
    }
    const ledger = await transport.transfersSince(serviceStartedAt);
    const staged = await stageOrphanRefunds({ transfers: ledger.transfers,
      seenOrderIds: journal.snapshot().seen_order_ids, journal, sellerPrincipalId,
      serviceStartedAt, now: new Date(now()).toISOString(), graceMs,
      historyComplete: ledger.historyComplete && journal.snapshot().order_index_complete });
    if (staged.length) await log(`Staged ${staged.length} orphan refund(s) for reconciliation.`);
    state.lastOrphanScan = now();
  }
  if (now() - (state.lastRefundScan ?? 0) > 30000) {
    for (const record of journal.snapshot().records) {
      try {
        const outcome = await processRefundRecord({ record, transport, journal,
          sellerPrincipalId, refundsEnabled });
        if (outcome.status === 'manual_reconciliation') {
          await log(`Refund for ${record.order_id} needs manual ledger reconciliation.`);
        }
      } catch (error) {
        await log(`Refund check for ${record.order_id} failed; will retry: ${error.stack ?? error}`);
      }
    }
    state.lastRefundScan = now();
  }
  return state;
}

/** Supervises whole polling cycles, including read, ledger, and journal errors. */
export async function superviseWorker(options, { shouldStop = () => false, pause = pauseDefault,
  pollMs = 2000, initialBackoffMs = 1000, maxBackoffMs = 30000 } = {}) {
  const state = {};
  let backoff = initialBackoffMs;
  while (!shouldStop()) {
    try {
      await runCycle({ ...options, state });
      backoff = initialBackoffMs;
      if (!shouldStop()) await pause(pollMs);
    } catch (error) {
      try { await options.log(`Worker cycle failed; restarting in ${backoff} ms: ${error.stack ?? error}`); }
      catch { /* A failed log sink must not defeat the supervisor. */ }
      if (!shouldStop()) await pause(backoff);
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  }
}
