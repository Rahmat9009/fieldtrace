import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeOrderMessage, encodePreflightMessage } from '../client/order.js';
import { openJournal } from '../worker/journal.js';
import { handleRoomMessage, stageOrphanRefunds } from '../worker/service.js';

const seller = 'p_ZyXwVuTsRq';
const buyer = 'p_AbCdEfGhIj';
const orderId = 'ord_manual01';
const transferId = 'txn_AbCdEfGhIj';
const artifactId = 'art_AbCdEfGhIj';
const requestBytes = Buffer.from(JSON.stringify({ direction: 'response', payload: { x: 1 }, target_example: { x: 1 } }));
const hash = createHash('sha256').update(requestBytes).digest('hex');
const orderMessage = {
  id: 'msg_AbCdEfGhIj', sender_principal_id: buyer,
  content: encodeOrderMessage({ orderId, artifactId, transferId, artifactSha256: hash }),
};
const transfer = { id: transferId, from: buyer, to: seller, amount: 8, memo: orderId, room_id: null };

async function withJournal(run) {
  const dir = await mkdtemp(join(tmpdir(), 'fieldtrace-service-'));
  const journal = await openJournal(join(dir, 'orders.json'));
  try { await run(journal); } finally { await journal.close(); await rm(dir, { recursive: true, force: true }); }
}

test('a real payment with wrong memo becomes a durable refund case without reading the artifact', async () => {
  await withJournal(async (journal) => {
    let downloaded = false;
    const decision = await handleRoomMessage({ message: orderMessage, journal, price: 8, sellerPrincipalId: seller,
      adapt: () => { throw new Error('must not adapt'); },
      transport: {
        findTransfer: async () => ({ ...transfer, memo: 'ord_other123' }),
        download: async () => { downloaded = true; },
      },
    });
    assert.equal(decision.status, 'refund_required');
    assert.equal(downloaded, false);
    assert.deepEqual(journal.snapshot().records.map((record) => [record.status, record.refund_amount]), [['refund_pending', 8]]);
  });
});

test('a paid order delivers once and records the result before duplicate input', async () => {
  await withJournal(async (journal) => {
    let uploads = 0;
    let replies = 0;
    let uploadedBytes;
    let delivery;
    const transport = {
      findTransfer: async () => transfer,
      download: async () => ({ status: 'found', bytes: requestBytes }),
      upload: async (bytes) => { uploads++; uploadedBytes = bytes; return { artifact_id: 'art_ZyXwVuTsRq' }; },
      reply: async (_id, content) => { replies++; delivery = JSON.parse(content); return { message_id: 'msg_ZyXwVuTsRq' }; },
    };
    const args = { message: orderMessage, journal, transport, price: 8, sellerPrincipalId: seller,
      adapt: (request) => ({ status: 'ok', convertible: true, output: request.payload, provenance: [] }),
    };
    assert.equal((await handleRoomMessage(args)).status, 'fulfilled');
    assert.equal((await handleRoomMessage(args)).status, 'duplicate');
    assert.equal(uploads, 1);
    assert.equal(replies, 1);
    assert.equal(journal.snapshot().records[0].result_artifact_id, 'art_ZyXwVuTsRq');
    assert.equal(delivery.result_artifact_sha256, createHash('sha256').update(uploadedBytes).digest('hex'));
    assert.equal(delivery.receipt.target_kind, 'example_inferred');
    assert.equal(delivery.receipt.input_artifact_sha256, hash);
  });
});

test('free preflight replies with a quote but no output or detailed changes', async () => {
  await withJournal(async (journal) => {
    let posted;
    const message = { ...orderMessage, content: encodePreflightMessage({ artifactId, artifactSha256: hash }) };
    const result = await handleRoomMessage({ message, journal, price: 8, sellerPrincipalId: seller,
      adapt: () => ({ status: 'ok', convertible: true, changes: [{ path: '/x' }], output: { x: 1 } }),
      transport: {
        download: async () => ({ status: 'found', bytes: requestBytes }),
        reply: async (id, content) => { posted = { id, body: JSON.parse(content) }; return { message_id: 'msg_ZyXwVuTsRq' }; },
      },
    });
    assert.equal(result.status, 'ok');
    assert.equal(posted.id, message.id);
    assert.equal(posted.body.price, 8);
    assert.equal(posted.body.change_count, 1);
    assert.equal('output' in posted.body, false);
  });
});

test('orphan transfer is staged once for refund after a complete scan', async () => {
  await withJournal(async (journal) => {
    const args = { transfers: [{ ...transfer, created_at: '2026-09-25T12:00:00Z' }], seenOrderIds: [], journal,
      sellerPrincipalId: seller, serviceStartedAt: '2026-09-25T11:00:00Z', now: '2026-09-25T12:10:00Z',
      graceMs: 300000, historyComplete: true,
    };
    assert.equal((await stageOrphanRefunds(args)).length, 1);
    assert.equal((await stageOrphanRefunds(args)).length, 0);
    assert.equal(journal.snapshot().records[0].status, 'refund_pending');
  });
});

test('confirmed artifact failures become a refund after three minutes, while transient errors do not', async () => {
  await withJournal(async (journal) => {
    let current = '2026-09-25T12:00:00.000Z';
    let downloadStatus = 'confirmed_failure';
    const args = { message: orderMessage, journal, price: 8, sellerPrincipalId: seller,
      now: () => current, adapt: () => { throw new Error('must not adapt'); },
      transport: { findTransfer: async () => transfer,
        download: async () => ({ status: downloadStatus }) },
    };
    assert.equal((await handleRoomMessage(args)).status, 'retry_later');
    assert.equal(journal.snapshot().artifact_failures[orderId].attempts, 1);
    current = '2026-09-25T12:02:59.000Z';
    assert.equal((await handleRoomMessage(args)).status, 'retry_later');
    current = '2026-09-25T12:03:00.000Z';
    downloadStatus = 'temporary_error';
    assert.equal((await handleRoomMessage(args)).status, 'retry_later');
    assert.equal(journal.snapshot().artifact_failures[orderId].attempts, 2);
    downloadStatus = 'confirmed_failure';
    assert.equal((await handleRoomMessage(args)).status, 'refund_required');
    assert.equal(journal.snapshot().records[0].status, 'refund_pending');
    assert.equal(journal.snapshot().records[0].refund_reason, 'artifact_missing');
  });
});
