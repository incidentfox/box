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
assert.equal(normalizeDeepSeekSettings({ model: 'deepseek-reasoner', reasoningEffort: 'xhigh' }).reasoningEffort, 'high');
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
    settings: { model: 'deepseek-reasoner', reasoningEffort: 'max' },
    apiKey: 'test-key',
  });

  assert.equal(spawned.command, 'bash');
  assert.equal(spawned.args[spawned.args.indexOf('--model') + 1], DEEPSEEK_MODEL);
  assert.ok(spawned.args.includes('model_reasoning_effort="max"'));
  assert.equal(spawned.options.env.OPENAI_BASE_URL, 'https://api.deepseek.com');
  assert.equal(spawned.options.env.OPENAI_API_KEY, 'test-key');
  assert.equal(spawned.options.env.BOX_DEEPSEEK_OPENAI_BASE_URL, 'https://api.deepseek.com');
  assert.equal(spawned.options.env.BOX_DEEPSEEK_OPENAI_API_KEY, 'test-key');
  assert.match(spawned.args[1], /export OPENAI_BASE_URL="\$BOX_DEEPSEEK_OPENAI_BASE_URL"/);
  assert.match(spawned.args[1], /export OPENAI_API_KEY="\$BOX_DEEPSEEK_OPENAI_API_KEY"/);
  assert.doesNotMatch(spawned.args[1], /unset OPENAI_API_KEY/);
  child.stdout.end();
  child.stderr.end();
}

assert.ok(buildDeepSeekCodexScript('/run/factory secrets.env').includes('[ -f "/run/factory secrets.env" ]'));

console.log('✅ deepseek-exec-engine.test.mjs passed');
