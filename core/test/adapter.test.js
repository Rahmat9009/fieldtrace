import test from 'node:test';
import assert from 'node:assert/strict';
import { adapt } from '../src/adapter.js';

test('converts a real delivery with explicit aliases and traces each field', () => {
  const payload = { orderQty: '12', item: 'pen' };
  const schema = {
    type: 'object',
    properties: { qty: { type: 'integer' }, item: { type: 'string' } },
    required: ['qty', 'item'],
    additionalProperties: false,
  };
  const result = adapt({ payload, target_schema: schema, aliases: { '/qty': '/orderQty' } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(JSON.parse(JSON.stringify(result.output)), { qty: 12, item: 'pen' });
  assert.deepEqual(result.changes.map(({ operation }) => operation), ['alias', 'coerce']);
  assert.deepEqual(payload, { orderQty: '12', item: 'pen' });
});

test('preflight checks conversion without returning usable output', () => {
  const result = adapt({ mode: 'preflight', direction: 'request', payload: { qty: '12' }, target_example: { qty: 0 } });
  assert.equal(result.status, 'ok');
  assert.equal(result.target, 'example_inferred_for_this_request');
  assert.equal(result.output, undefined);
  assert.equal(result.validation.passed, true);
});

test('refuses a missing required source or undeclared data loss before conversion', () => {
  const schema = { type: 'object', properties: { qty: { type: 'integer' } }, required: ['qty'], additionalProperties: false };
  assert.equal(adapt({ mode: 'preflight', payload: {}, target_schema: schema }).code, 'missing_required');
  assert.equal(adapt({ mode: 'preflight', payload: { qty: 1, comment: 'keep me' }, target_schema: schema }).code, 'extra_field');
});

test('refuses unsafe numbers and failing constraints', () => {
  assert.equal(adapt({ payload: { qty: '9007199254740993' }, target_example: { qty: 1 } }).code, 'unsafe_coercion');
  assert.equal(adapt({ payload: { status: 'bad' }, target_schema: {
    type: 'object', properties: { status: { type: 'string', enum: ['ok'] } }, required: ['status'],
  } }).code, 'validation_failed');
});

test('example target requires the fields shown for this request', () => {
  assert.equal(adapt({ payload: { qty: 1 }, target_example: { qty: 1, item: 'pen' } }).code, 'missing_required');
  assert.equal(adapt({ payload: {}, target_example: {} }).code, 'ambiguous_example');
});

test('does not silently drop extras, even when a target is strict', () => {
  const target_schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  const refused = adapt({ payload: { a: 'kept', b: 'important' }, target_schema });
  assert.equal(refused.code, 'extra_field');
  const accepted = adapt({ payload: { a: 'kept', b: 'important' }, target_schema, allow_drop_extras: true });
  assert.equal(accepted.status, 'ok');
  assert.deepEqual(accepted.changes, [{ path: '/b', source: '/b', operation: 'drop' }]);
});

test('rejects invalid aliases and schemas that reject every value', () => {
  assert.equal(adapt({ payload: { a: 1 }, target_example: { a: 1 }, aliases: { a: '/a' } }).code, 'invalid_request');
  assert.equal(adapt({ payload: {}, target_schema: false }).code, 'unsupported_target');
});

test('explicit aliases can wrap a flat source field into a nested target', () => {
  const target_example = { order: { qty: 0 } };
  const result = adapt({ payload: { quantity: '2' }, target_example, aliases: { '/order/qty': '/quantity' } });
  assert.equal(result.status, 'ok');
  assert.deepEqual(JSON.parse(JSON.stringify(result.output)), { order: { qty: 2 } });
  assert.equal(result.provenance.some((entry) => entry.path === '/order/qty' && entry.source === '/quantity'), true);
});

test('rejects a malformed date and unknown validation keywords', () => {
  const schema = {
    type: 'object', properties: { date: { type: 'string', format: 'date' } }, required: ['date'],
  };
  assert.equal(adapt({ payload: { date: 'someday' }, target_schema: schema }).code, 'validation_failed');
  assert.equal(adapt({ payload: { date: '2026-09-25' }, target_schema: schema }).status, 'ok');
  assert.equal(adapt({ payload: { a: 1 }, target_schema: { type: 'object', unexpectedRule: true } }).code, 'invalid_schema');
});

test('refuses unsafe integer values rather than silently rounding them', () => {
  const result = adapt({ payload: { quantity: 9007199254740992 }, target_example: { quantity: 1 } });
  assert.equal(result.code, 'unsafe_integer');
});

test('refuses aliases that would silently overwrite existing data or never run', () => {
  const target_schema = {
    type: 'object', properties: { qty: { type: 'integer' } }, required: ['qty'], additionalProperties: false,
  };
  assert.equal(adapt({ payload: { qty: 3, quantity: 4 }, target_schema, aliases: { '/qty': '/quantity' } }).code, 'alias_conflict');
  assert.equal(adapt({ payload: { qty: 3 }, target_schema, aliases: { '/missing': '/qty' } }).code, 'unused_alias');
  assert.equal(adapt({ payload: { qty: 3 }, target_schema, aliases: { '/qty': '/qty~2' } }).code, 'invalid_request');
  assert.equal(adapt({ payload: { qty: 3 }, target_schema, allow_drop_extras: 'true' }).code, 'invalid_request');
});

test('traces each converted array item to its original input location', () => {
  const result = adapt({
    payload: { quantities: ['1', '2'] },
    target_schema: {
      type: 'object', properties: { quantities: { type: 'array', items: { type: 'integer' } } },
      required: ['quantities'], additionalProperties: false,
    },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(JSON.parse(JSON.stringify(result.output)), { quantities: [1, 2] });
  assert.ok(result.provenance.some(({ path, source }) => path === '/quantities/1' && source === '/quantities/1'));
});

test('refuses numeric text whose spelling would be changed by conversion', () => {
  for (const qty of ['1.0', '-0', '0.0000001']) {
    const result = adapt({ payload: { qty }, target_example: { qty: 1 } });
    assert.equal(result.code, 'unsafe_coercion', qty);
  }
});

test('refuses an example whose array items contradict its inferred shape', () => {
  const result = adapt({
    payload: { rows: [{ id: 1 }, { id: 2 }] },
    target_example: { rows: [{ id: 1 }, { label: 'two' }] },
  });
  assert.equal(result.code, 'ambiguous_example');
});
