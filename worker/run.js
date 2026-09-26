import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { openJournal } from './journal.js';
import { runAdapter } from './run-adapter.js';
import { createSharedNetTransport } from './sharednet-transport.js';
import { superviseWorker } from './loop.js';

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
  if (options['refunds-enabled'] !== undefined && options['refunds-enabled'] !== 'true') throw new Error('--refunds-enabled takes true');
  if (!Number.isFinite(Date.parse(options['started-at']))) throw new Error('Invalid --started-at');
  return {
    roomDir: resolve(options['room-dir']), seatId: options.seat,
    sellerPrincipalId: options.seller, price,
    journalPath: resolve(options.journal), logPath: resolve(options.log ?? `${options.journal}.log`),
    serviceStartedAt: options['started-at'], graceMs,
    refundsEnabled: options['refunds-enabled'] === 'true',
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const journal = await openJournal(options.journalPath);
  const transport = createSharedNetTransport(options);
  const log = async (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    process.stderr.write(line);
    try { await appendFile(options.logPath, line, { mode: 0o600 }); }
    catch (error) { process.stderr.write(`Could not write worker log: ${error.message}\n`); }
  };
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  try {
    await superviseWorker({ journal, transport, adapt: runAdapter, price: options.price,
      sellerPrincipalId: options.sellerPrincipalId, serviceStartedAt: options.serviceStartedAt,
      graceMs: options.graceMs, refundsEnabled: options.refundsEnabled, log },
    { shouldStop: () => stopping });
  } finally {
    await journal.close();
  }
}

main().catch((error) => {
  process.stderr.write(`FieldTrace worker stopped: ${error.message}\n`);
  process.exitCode = 1;
});
