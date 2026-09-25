import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../worker/journal.js';

test('journal survives reopen and prevents duplicate transfer fulfillment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fieldtrace-journal-'));
  const path = join(dir, 'orders.json');
  try {
    const first = await openJournal(path);
    await first.reserve({ order_id: 'ord_manual01', transfer_id: 'txn_AbCdEfGhIj', artifact_id: 'art_AbCdEfGhIj' });
    await first.setStatus('ord_manual01', 'fulfilled', { result_artifact_id: 'art_ZyXwVuTsRq' });
    await first.advanceCursor(42);
    await assert.rejects(openJournal(path), { code: 'EEXIST' });
    await first.close();

    const reopened = await openJournal(path);
    assert.equal(reopened.snapshot().cursor, 42);
    assert.equal(reopened.snapshot().records[0].status, 'fulfilled');
    await assert.rejects(reopened.reserve({ order_id: 'ord_another', transfer_id: 'txn_AbCdEfGhIj' }), /already journaled/);
    assert.equal(reopened.snapshot().records.length, 1);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
