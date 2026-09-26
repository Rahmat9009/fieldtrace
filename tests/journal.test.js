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
    await first.noteArtifactFailure('ord_manual01', 'art_AbCdEfGhIj', 'txn_AbCdEfGhIj', '2026-09-25T12:00:00Z');
    await first.noteOrderId('ord_manual01');
    for (let index = 0; index < 5; index++) {
      assert.equal((await first.checkPreflightRate(`msg_AbCdEfGhI${index}`,
        'p_AbCdEfGhIj', '2026-09-25T12:00:00Z')).allowed, true);
    }
    await assert.rejects(openJournal(path), { code: 'EEXIST' });
    await first.close();

    const reopened = await openJournal(path);
    assert.equal(reopened.snapshot().cursor, 42);
    assert.equal(reopened.snapshot().records[0].status, 'fulfilled');
    assert.equal(reopened.snapshot().artifact_failures.ord_manual01.first_at, '2026-09-25T12:00:00Z');
    assert.deepEqual(reopened.snapshot().seen_order_ids, ['ord_manual01']);
    assert.equal((await reopened.checkPreflightRate('msg_AbCdEfGhI5',
      'p_AbCdEfGhIj', '2026-09-25T12:01:00Z')).allowed, false);
    await assert.rejects(reopened.reserve({ order_id: 'ord_another', transfer_id: 'txn_AbCdEfGhIj' }), /already journaled/);
    assert.equal(reopened.snapshot().records.length, 1);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('denied preflights do not consume slots after admitted requests leave the window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fieldtrace-preflight-rate-'));
  const journal = await openJournal(join(dir, 'orders.json'));
  const buyer = 'p_AbCdEfGhIj';
  try {
    for (let index = 0; index < 5; index++) {
      assert.equal((await journal.checkPreflightRate(`msg_first${index}`, buyer,
        '2026-09-25T12:00:00Z')).allowed, true);
    }
    assert.equal((await journal.checkPreflightRate('msg_denied', buyer,
      '2026-09-25T12:01:00Z')).allowed, false);
    for (let index = 0; index < 5; index++) {
      assert.equal((await journal.checkPreflightRate(`msg_next${index}`, buyer,
        '2026-09-25T12:10:01Z')).allowed, true);
    }
    assert.equal((await journal.checkPreflightRate('msg_denied', buyer,
      '2026-09-25T12:10:01Z')).allowed, false);
    assert.equal((await journal.checkPreflightRate('msg_next5', buyer,
      '2026-09-25T12:10:01Z')).allowed, false);
  } finally {
    await journal.close();
    await rm(dir, { recursive: true, force: true });
  }
});
