import { parentPort, workerData } from 'node:worker_threads';
import { adapt } from '../core/src/adapter.js';

try {
  parentPort.postMessage(adapt(workerData));
} catch (error) {
  parentPort.postMessage({ status: 'unsupported', convertible: false,
    code: 'adapter_error', path: '', message: error.message });
}
