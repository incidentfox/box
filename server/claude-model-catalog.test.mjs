import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { discoverClaudeModels, normalizeClaudeModels } from './claude-model-catalog.mjs';

const models = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5' },
  { value: 'claude-fable-5-2[1m]', resolvedModel: 'claude-fable-5-2', supportedEffortLevels: ['high', 'xhigh'], defaultEffort: 'high' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', supportsEffort: false },
  { value: 'unknown' }, null,
];
const normalized = normalizeClaudeModels(models);
assert.deepEqual(normalized.map((m) => m.id), ['claude-opus-5-5', 'claude-fable-5-2[1m]', 'claude-haiku-5-5']);
assert.equal(normalized[0].label, 'Claude Opus 5.5');
assert.equal(normalized[0].defaultEffort, 'medium');
assert.equal(normalized[1].label, 'Claude Fable 5.2 (1M)');
assert.equal(normalized[1].defaultEffort, 'high');
assert.deepEqual(normalized[2].efforts, []);
assert.equal(normalized[2].defaultEffort, '');
assert.deepEqual(normalizeClaudeModels(null), []);

let lastChild;
function fakeSpawn(mode) {
  return (command, args, options) => {
    assert.equal(command, 'claude');
    assert.ok(args.includes('--bare'));
    assert.equal(options.env.CC_AUTH_TOKEN, undefined);
    assert.equal(options.env.CLAUDECODE, '');
    const child = new EventEmitter();
    lastChild = child;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = (signal) => { child.signalCode = signal; queueMicrotask(() => child.emit('close')); };
    child.stdin.once('data', (data) => {
      const request = JSON.parse(data);
      assert.equal(request.type, 'control_request');
      assert.equal(request.request.subtype, 'initialize');
      // No user prompt may be sent: discovery must never start a model turn.
      assert.deepEqual(request.request, { subtype: 'initialize', hooks: {} });
      queueMicrotask(() => {
        if (mode === 'timeout') return;
        if (mode === 'exit') { child.emit('close', 1); return; }
        if (mode === 'overflow') { child.stdout.write('x'.repeat(100)); return; }
        const line = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models: mode === 'empty' ? [] : models } } }) + '\n';
        child.stdout.write('invalid preface\n');
        child.stdout.write(line.slice(0, 15));
        child.stdout.write(line.slice(15));
      });
    });
    return child;
  };
}
assert.deepEqual(await discoverClaudeModels({ spawnImpl: fakeSpawn('success'), env: { CC_AUTH_TOKEN: 'private' } }), normalized);
assert.equal(lastChild.signalCode, 'SIGTERM');
await assert.rejects(discoverClaudeModels({ spawnImpl: fakeSpawn('empty') }), /no supported models/);
await assert.rejects(discoverClaudeModels({ spawnImpl: fakeSpawn('exit') }), /exited before/);
await assert.rejects(discoverClaudeModels({ spawnImpl: fakeSpawn('timeout'), timeoutMs: 5 }), /timed out/);
await assert.rejects(discoverClaudeModels({ spawnImpl: fakeSpawn('overflow'), maxBytes: 10 }), /output limit/);
await assert.rejects(discoverClaudeModels({ spawnImpl() { throw new Error('private diagnostic'); } }), /could not start/);
console.log('Claude model catalog tests passed');
