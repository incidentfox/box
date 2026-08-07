import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = app.indexOf('const HISTORY_LOAD_TIMEOUT_MS =');
const end = app.indexOf('\nfunction resetWsWatchdog', start);
assert.ok(start >= 0 && end > start, 'locate history deadline helper');

const context = {
  AbortController,
  Error,
  Promise,
  clearTimeout,
  setTimeout,
  api: null,
  result: null,
};
vm.runInNewContext(`${app.slice(start, end)}\nresult = { beginHistoryRequest, loadHistoryWithDeadline };`, context);

let requestOptions;
context.api = async (_path, options) => {
  requestOptions = options;
  return { json: async () => ({ messages: ['ready'] }) };
};
const fastController = context.result.beginHistoryRequest();
assert.deepEqual(
  await context.result.loadHistoryWithDeadline('/history', { controller: fastController, timeoutMs: 50 }),
  { messages: ['ready'] },
);
assert.equal(requestOptions.cache, 'no-store');
assert.equal(requestOptions.signal, fastController.signal);

context.api = () => new Promise(() => {});
const stuckController = context.result.beginHistoryRequest();
await assert.rejects(
  context.result.loadHistoryWithDeadline('/history', { controller: stuckController, timeoutMs: 5 }),
  (error) => error && error.name === 'HistoryTimeoutError',
);
assert.equal(stuckController.signal.aborted, true);

console.log('history load deadline ok');
