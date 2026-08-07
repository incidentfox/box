import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  DEEPSEEK_DEFAULT_EFFORT,
  DEEPSEEK_MODEL,
  DeepSeekExecEngine,
  buildDeepSeekCodexScript,
  normalizeDeepSeekSettings,
} from './deepseek-exec-engine.mjs';

assert.deepEqual(normalizeDeepSeekSettings(), { model: DEEPSEEK_MODEL, reasoningEffort: DEEPSEEK_DEFAULT_EFFORT });
assert.deepEqual(normalizeDeepSeekSettings({ model: 'deepseek-chat', reasoningEffort: 'low' }), {
  model: DEEPSEEK_MODEL,
  reasoningEffort: 'low',
});
// codex 0.135 accepts none/minimal/low/medium/high/xhigh — `max` is not a real effort and gets
// rejected by its model cache, so it falls back to the default instead of being passed through.
assert.equal(normalizeDeepSeekSettings({ model: 'deepseek-reasoner', reasoningEffort: 'xhigh' }).reasoningEffort, 'xhigh');
assert.equal(normalizeDeepSeekSettings({ model: 'deepseek-v4-pro', reasoningEffort: 'max' }).reasoningEffort, DEEPSEEK_DEFAULT_EFFORT);
assert.equal(normalizeDeepSeekSettings({ model: 'deepseek-v4-pro', reasoningEffort: 'max' }).model, DEEPSEEK_MODEL);

{
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let spawned = null;
  const engine = new DeepSeekExecEngine({
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      return child;
    },
  });
  engine.run({
    cwd: '/work',
    prompt: 'hello',
    settings: { model: 'deepseek-reasoner', reasoningEffort: 'xhigh' },
    apiKey: 'test-key',
  });

  assert.equal(spawned.command, 'bash');
  assert.equal(spawned.args[spawned.args.indexOf('--model') + 1], DEEPSEEK_MODEL);
  assert.ok(spawned.args.includes('model_reasoning_effort="xhigh"'));
  // Without an explicit provider codex stays on the owner's ChatGPT account and rejects the
  // DeepSeek model, so these must ride on every invocation (new turns AND resumes).
  assert.ok(spawned.args.includes('model_provider="deepseek"'));
  assert.ok(spawned.args.includes('model_providers.deepseek.base_url="https://api.deepseek.com"'));
  assert.ok(spawned.args.includes('model_providers.deepseek.env_key="DEEPSEEK_API_KEY"'));
  assert.ok(spawned.args.includes('model_providers.deepseek.wire_api="responses"'));
  assert.equal(spawned.options.env.OPENAI_BASE_URL, 'https://api.deepseek.com');
  assert.equal(spawned.options.env.OPENAI_API_KEY, 'test-key');
  assert.equal(spawned.options.env.DEEPSEEK_API_KEY, 'test-key');
  assert.equal(spawned.options.env.BOX_DEEPSEEK_OPENAI_BASE_URL, 'https://api.deepseek.com');
  assert.equal(spawned.options.env.BOX_DEEPSEEK_OPENAI_API_KEY, 'test-key');
  assert.match(spawned.args[1], /export OPENAI_BASE_URL="\$BOX_DEEPSEEK_OPENAI_BASE_URL"/);
  assert.match(spawned.args[1], /export OPENAI_API_KEY="\$BOX_DEEPSEEK_OPENAI_API_KEY"/);
  // The shared secrets file carries a blank DEEPSEEK_API_KEY; re-export after sourcing it.
  assert.match(spawned.args[1], /export DEEPSEEK_API_KEY="\$BOX_DEEPSEEK_OPENAI_API_KEY"/);
  assert.doesNotMatch(spawned.args[1], /unset OPENAI_API_KEY/);
  child.stdout.end();
  child.stderr.end();
}

assert.ok(buildDeepSeekCodexScript('/run/factory secrets.env').includes('[ -f "/run/factory secrets.env" ]'));

console.log('✅ deepseek-exec-engine.test.mjs passed');
