import assert from 'node:assert/strict';
import {
  VOB_PRODUCTION_PROMPT_SOURCE,
  VOB_PRODUCTION_PROMPT_VERSION,
} from './vob-production-prompt.mjs';
import {
  buildVobTestInstructions,
  createVobTestConfig,
  createVobTestConfigStore,
  normalizeVobTestSettings,
  vobTestCatalog,
} from './vob-test-mode.mjs';

const catalog = vobTestCatalog();
assert.equal(catalog.defaults.promptPreset, 'production_guarded');
assert.equal(catalog.productionPrompt.version, VOB_PRODUCTION_PROMPT_VERSION);
assert.equal(catalog.productionPrompt.source, VOB_PRODUCTION_PROMPT_SOURCE);
assert.ok(catalog.models.some((model) => model.id === 'gpt-4.1-mini'));
assert.ok(catalog.voices.some((voice) => voice.id === 'marin'));

const settings = normalizeVobTestSettings({
  promptPreset: 'balanced',
  model: 'gpt-4.1',
  voice: 'ash',
  customPrompt: 'This must be ignored rather than changing production behavior.',
});
assert.deepEqual(settings, {
  promptPreset: 'production_guarded',
  model: 'gpt-4.1',
  voice: 'ash',
});
assert.equal(normalizeVobTestSettings({ model: 'not-a-model', voice: 'nope' }).model, 'gpt-4.1-mini');

const config = createVobTestConfig({
  testId: 'vob-test-1',
  sessionId: 'session-1',
  settings,
  snapshot: {
    payerName: 'Example Health',
    requestId: 'request-1',
    facts: [
      { key: 'rep.name', value: 'Taylor', status: 'captured' },
      { key: 'benefit.copay', value: '$25', status: 'captured' },
    ],
    ledger: [{ fields: [
      { key: 'rep.name', value: 'Taylor', status: 'captured' },
      { key: 'benefit.copay', value: '$25', status: 'captured' },
    ] }],
  },
  ttlMs: 60_000,
});
assert.match(config.instructions, /You are the provider-side insurance coordinator calling a payer/);
assert.match(config.instructions, /Example Health/);
assert.match(config.instructions, /Taylor/);
assert.match(config.instructions, /\$25/);
assert.match(config.instructions, /CALL DATA/);
assert.match(config.instructions, /EVIDENCE LEDGER/);
assert.doesNotMatch(config.instructions, /simulation|test mode|role-playing/i);
assert.doesNotMatch(config.instructions, /Additional operator instruction/);

const store = createVobTestConfigStore({ ttlMs: 60_000 });
store.put(config);
assert.equal(store.get('vob-test-1').settings.voice, 'ash');
assert.equal(store.size(), 1);
store.delete('vob-test-1');
assert.equal(store.get('vob-test-1'), null);

console.log('vob test mode: ok');
