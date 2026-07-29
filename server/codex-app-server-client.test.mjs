import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCodexRpc } from './codex-app-server-client.mjs';

function fakeSpawn(command, args) {
  assert.equal(command, 'codex');
  assert.deepEqual(args, ['app-server', '--stdio']);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const writes = [];
  child.stdin = { write(line) {
    const message = JSON.parse(line);
    writes.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', '{"id":0,"result":{"codexHome":"/tmp"}}\n'));
    if (message.id === 1) queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: 1, result: { goal: { status: 'active' } } })}\n`));
  } };
  child.writes = writes;
  return child;
}

const rpc = createCodexRpc({ spawnImpl: fakeSpawn, timeoutMs: 1000 });
const result = await rpc('thread/goal/get', { threadId: 'thread-1' });
assert.deepEqual(result, { goal: { status: 'active' } });

console.log('codex app-server client ok');
