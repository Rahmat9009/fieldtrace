import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdapter } from '../worker/run-adapter.js';

test('isolated adapter executes a real conversion and returns validated output', async () => {
  const result = await runAdapter({
    mode: 'convert', direction: 'response', payload: { quantity: '12' },
    target_schema: {
      type: 'object', properties: { quantity: { type: 'integer' } },
      required: ['quantity'], additionalProperties: false,
    },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.output, { quantity: 12 });
  assert.equal(result.validation.passed, true);
});
