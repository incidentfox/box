import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCodexRpc } from './codex-app-server-client.mjs';

const children = [];

function fakeSpawn(command, args) {
  assert.equal(command, 'bash');
  assert.deepEqual(args, ['-lc', 'exec codex app-server --stdio']);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const writes = [];
  child.stdin = new EventEmitter();
  child.stdin.write = function write(line) {
    const message = JSON.parse(line);
    writes.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', '{"id":0,"result":{"codexHome":"/tmp"}}\n'));
    if (message.method === 'thread/resume') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: 1, result: { thread: { id: message.params.threadId } } })}\n`));
    if (message.method === 'thread/goal/get') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: { goal: { status: 'active' } } })}\n`));
    if (message.method === 'thread/goal/set') queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result: { goal: { objective: message.params.objective, status: message.params.status } } })}\n`));
  };
  child.writes = writes;
  children.push(child);
  return child;
}

const rpc = createCodexRpc({ spawnImpl: fakeSpawn, timeoutMs: 1000 });
const result = await rpc('thread/goal/get', { threadId: 'thread-1' });
assert.deepEqual(result, { goal: { status: 'active' } });

const resumedResult = await rpc('thread/goal/get', { threadId: 'thread-2' }, { resumeThreadId: 'thread-2' });
assert.deepEqual(resumedResult, { goal: { status: 'active' } });
assert.deepEqual(children[1].writes.map(({ method, id, params }) => ({ method, id, params })), [
  { method: 'initialize', id: 0, params: { clientInfo: { name: 'box', title: 'Box', version: '1' }, capabilities: { experimentalApi: true } } },
  { method: 'initialized', id: undefined, params: {} },
  { method: 'thread/resume', id: 1, params: { threadId: 'thread-2' } },
  { method: 'thread/goal/get', id: 2, params: { threadId: 'thread-2' } },
]);

const updatedGoal = await rpc('thread/goal/set', { threadId: 'thread-3', objective: 'Keep working', status: 'active' }, { resumeThreadId: 'thread-3' });
assert.deepEqual(updatedGoal, { goal: { objective: 'Keep working', status: 'active' } });
assert.deepEqual(children[2].writes.map(({ method, id, params }) => ({ method, id, params })), [
  { method: 'initialize', id: 0, params: { clientInfo: { name: 'box', title: 'Box', version: '1' }, capabilities: { experimentalApi: true } } },
  { method: 'initialized', id: undefined, params: {} },
  { method: 'thread/resume', id: 1, params: { threadId: 'thread-3' } },
  { method: 'thread/goal/set', id: 2, params: { threadId: 'thread-3', objective: 'Keep working', status: 'active' } },
]);

const epipeRpc = createCodexRpc({
  timeoutMs: 1000,
  spawnImpl() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => queueMicrotask(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
    child.kill = () => {};
    return child;
  },
});
await assert.rejects(epipeRpc('thread/goal/get'), { code: 'EPIPE' });

console.log('codex app-server client ok');
