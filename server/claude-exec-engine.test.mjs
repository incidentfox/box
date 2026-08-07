import assert from 'node:assert/strict';
import { buildClaudeArgs } from './claude-exec-engine.mjs';

const args = buildClaudeArgs({ sessionId: 'session-1', prompt: 'hello', settings: {}, isNew: true });
assert.deepEqual(args.slice(0, 2), ['--bare', '--output-format']);
assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'claude-opus-5[1m]']);
assert.deepEqual(args.slice(-4), ['--session-id', 'session-1', '-p', 'hello']);

const legacy = buildClaudeArgs({ sessionId: 'session-2', settings: { model: 'claude-opus-5' } });
assert.deepEqual(legacy.slice(legacy.indexOf('--model'), legacy.indexOf('--model') + 2), ['--model', 'claude-opus-5[1m]']);

const sonnet = buildClaudeArgs({ sessionId: 'session-3', settings: { model: 'sonnet' } });
assert.deepEqual(sonnet.slice(sonnet.indexOf('--model'), sonnet.indexOf('--model') + 2), ['--model', 'sonnet']);

console.log('claude exec engine ok');
