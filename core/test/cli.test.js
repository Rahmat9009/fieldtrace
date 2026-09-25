import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(request) {
  const child = spawnSync(process.execPath, ['bin/fieldtrace.js'], {
    cwd: new URL('..', import.meta.url),
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  return { code: child.status, lines: child.stdout.trim().split('\n').map(JSON.parse), stderr: child.stderr };
}

test('CLI returns one machine-readable result and a failure code on unsupported conversions', () => {
  const base = { payload: { qty: '2' }, target_example: { qty: 1 } };
  const check = run({ ...base, mode: 'preflight' });
  assert.equal(check.code, 0);
  assert.equal(check.lines.length, 1);
  assert.equal(check.lines[0].convertible, true);
  assert.equal(Object.hasOwn(check.lines[0], 'output'), false);

  const fail = run({ payload: { qty: 'bad' }, target_example: { qty: 1 } });
  assert.equal(fail.code, 2);
  assert.equal(fail.lines.length, 1);
  assert.equal(fail.lines[0].status, 'unsupported');
});
