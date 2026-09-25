import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const server = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

test('server defaults new Codex chats to GPT-6 Sol at medium', () => {
  assert.match(server, /codex: \{ model: 'gpt-6-sol', reasoningEffort: 'medium'/);
  assert.match(server, /claude: \{ model: DEFAULT_CLAUDE_MODEL, effort: 'medium'/);
  assert.match(server, /mac: \{ model: 'gpt-6-astra', reasoningEffort: 'medium'/);
});

test('server reports GPT-6 Sol and Astra full context for Codex and Computer Use', () => {
  const start = server.indexOf('const DEFAULT_CONTEXT_WINDOWS = {');
  const end = server.indexOf('const sumNums =', start);
  assert.ok(start >= 0 && end > start, 'locate the model context helper');

  const ctx = {};
  vm.runInNewContext(`${server.slice(start, end)}\ncontextWindow = modelContextWindow;`, ctx);
  assert.equal(ctx.contextWindow('codex', 'gpt-6-sol'), 1050000);
  assert.equal(ctx.contextWindow('codex', 'gpt-6-astra'), 1050000);
  assert.equal(ctx.contextWindow('mac', 'gpt-6-astra'), 1050000);
  assert.equal(ctx.contextWindow('codex', 'gpt-5.5'), 258400);
});
