import { Worker } from 'node:worker_threads';

/** Limit one conversion's CPU time and memory so it cannot stall room intake. */
export function runAdapter(request, { timeoutMs = 10000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid adapter timeout');
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./adapter-task.js', import.meta.url), {
      workerData: request,
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = (code, message) => ({ status: 'unsupported', convertible: false, code, path: '', message });
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(failed('adapter_timeout', 'The conversion exceeded its time limit.'));
    }, timeoutMs);
    worker.once('message', (result) => finish(result));
    worker.once('error', (error) => finish(failed('adapter_error', error.message)));
    worker.once('exit', (code) => {
      if (!settled) finish(failed('adapter_error', `Adapter worker exited with code ${code}.`));
    });
  });
}
