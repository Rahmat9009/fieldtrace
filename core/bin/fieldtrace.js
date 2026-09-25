#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { stdin, stdout, stderr, argv } from 'node:process';
import { adapt } from '../src/adapter.js';

async function input() {
  const limit = 1024 * 1024;
  if (argv[2] && argv[2] !== '-') {
    if ((await stat(argv[2])).size > limit) throw new Error('Request exceeds 1 MiB limit');
    return readFile(argv[2], 'utf8');
  }
  let body = '';
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > limit) throw new Error('Request exceeds 1 MiB limit');
    body += chunk;
  }
  return body;
}

try {
  const request = JSON.parse(await input());
  const result = adapt(request);
  stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'ok') process.exitCode = 2;
} catch (error) {
  stdout.write(`${JSON.stringify({ status: 'error', code: 'invalid_request', message: error.message })}\n`);
  process.exitCode = 2;
}
