import assert from 'node:assert/strict';
import { buildClaudeArgs } from './claude-exec-engine.mjs';

const args = buildClaudeArgs({ sessionId: 'session-1', prompt: 'hello', settings: {}, isNew: true });
assert.deepEqual(args.slice(0, 2), ['--bare', '--output-format']);
assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);
assert.deepEqual(args.slice(-4), ['--session-id', 'session-1', '-p', 'hello']);

const legacy = buildClaudeArgs({ sessionId: 'session-2', settings: { model: 'claude-opus-5' } });
assert.deepEqual(legacy.slice(legacy.indexOf('--model'), legacy.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);

const shorthand = buildClaudeArgs({ sessionId: 'session-2b', settings: { model: 'opus' } });
assert.deepEqual(shorthand.slice(shorthand.indexOf('--model'), shorthand.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);

const mediumEffort = buildClaudeArgs({ sessionId: 'session-4', settings: { effort: 'medium' } });
assert.deepEqual(mediumEffort.slice(mediumEffort.indexOf('--effort'), mediumEffort.indexOf('--effort') + 2), ['--effort', 'medium']);

const legacyEffort = buildClaudeArgs({ sessionId: 'session-5', settings: { reasoningEffort: 'high' } });
assert.deepEqual(legacyEffort.slice(legacyEffort.indexOf('--effort'), legacyEffort.indexOf('--effort') + 2), ['--effort', 'high']);

const sonnet = buildClaudeArgs({ sessionId: 'session-3', settings: { model: 'sonnet' } });
assert.deepEqual(sonnet.slice(sonnet.indexOf('--model'), sonnet.indexOf('--model') + 2), ['--model', 'sonnet']);

console.log('claude exec engine ok');
