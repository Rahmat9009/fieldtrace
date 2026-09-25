import { resolve } from 'node:path';
import { openJournal } from './journal.js';
import { runAdapter } from './run-adapter.js';
import { handleRoomMessage, stageOrphanRefunds } from './service.js';
import { createSharedNetTransport } from './sharednet-transport.js';

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option ${name ?? ''}`);
    options[name.slice(2)] = value;
  }
  for (const required of ['room-dir', 'seat', 'seller', 'price', 'journal', 'started-at']) {
    if (!options[required]) throw new Error(`Missing --${required}`);
  }
  const price = Number(options.price);
  if (!Number.isSafeInteger(price) || price < 1) throw new Error('Invalid --price');
  const graceMs = options['orphan-grace-ms'] === undefined ? null : Number(options['orphan-grace-ms']);
  if (graceMs !== null && (!Number.isSafeInteger(graceMs) || graceMs < 1)) throw new Error('Invalid --orphan-grace-ms');
  if (!Number.isFinite(Date.parse(options['started-at']))) throw new Error('Invalid --started-at');
  return {
    roomDir: resolve(options['room-dir']), seatId: options.seat,
    sellerPrincipalId: options.seller, price,
    journalPath: resolve(options.journal), serviceStartedAt: options['started-at'], graceMs,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const journal = await openJournal(options.journalPath);
  const transport = createSharedNetTransport(options);
  const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  try {
    let lastOrphanScan = 0;
    while (!stopping) {
      for (const pending of journal.snapshot().pending_messages) {
        const outcome = await handleRoomMessage({ message: pending, transport, journal, adapt: runAdapter,
          price: options.price, sellerPrincipalId: options.sellerPrincipalId });
        if (outcome.status !== 'retry_later') await journal.removeMessage(pending.id);
      }
      let hasMore;
      do {
        const page = await transport.readPage(journal.snapshot().cursor);
        for (const message of page.items) {
          const outcome = await handleRoomMessage({ message, transport, journal, adapt: runAdapter,
            price: options.price, sellerPrincipalId: options.sellerPrincipalId });
          if (outcome.status === 'retry_later') await journal.queueMessage(message);
          await journal.advanceCursor(message.sequence);
        }
        hasMore = page.has_more;
      } while (hasMore && !stopping);

      if (options.graceMs !== null && Date.now() - lastOrphanScan > 60000) {
        const room = await transport.readAllOrderIds();
        const ledger = await transport.transfersSince(options.serviceStartedAt);
        const staged = await stageOrphanRefunds({ transfers: ledger.transfers, seenOrderIds: room.orderIds,
          journal, sellerPrincipalId: options.sellerPrincipalId, serviceStartedAt: options.serviceStartedAt,
          now: new Date().toISOString(), graceMs: options.graceMs,
          historyComplete: room.historyComplete && ledger.historyComplete });
        if (staged.length) process.stderr.write(`Staged ${staged.length} orphan refund(s) for reconciliation.\n`);
        lastOrphanScan = Date.now();
      }
      if (!stopping) await pause(2000);
    }
  } finally {
    await journal.close();
  }
}

main().catch((error) => {
  process.stderr.write(`FieldTrace worker stopped: ${error.message}\n`);
  process.exitCode = 1;
});
