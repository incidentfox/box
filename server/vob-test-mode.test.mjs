import assert from 'node:assert/strict';
import {
  VOB_PRODUCTION_PROMPT_SOURCE,
  VOB_PRODUCTION_PROMPT_VERSION,
} from './vob-production-prompt.mjs';
import {
  VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE,
  VOB_LIVEKIT_PRODUCTION_MODEL,
  VOB_LIVEKIT_PRODUCTION_STT_MODEL,
  VOB_LIVEKIT_PRODUCTION_TTS_MODEL,
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
assert.equal(catalog.defaults.model, VOB_LIVEKIT_PRODUCTION_MODEL);
assert.equal(catalog.defaults.voice, VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE);
assert.deepEqual(catalog.productionRuntime, {
  llmProvider: 'livekit-inference',
  model: VOB_LIVEKIT_PRODUCTION_MODEL,
  sttProvider: 'livekit-inference',
  sttModel: VOB_LIVEKIT_PRODUCTION_STT_MODEL,
  ttsProvider: 'livekit-inference',
  ttsModel: VOB_LIVEKIT_PRODUCTION_TTS_MODEL,
  voice: VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE,
});
assert.deepEqual(catalog.models.map((model) => model.id), [VOB_LIVEKIT_PRODUCTION_MODEL]);
assert.deepEqual(catalog.voices.map((voice) => voice.id), [VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE]);

const settings = normalizeVobTestSettings({
  promptPreset: 'balanced',
  model: 'gpt-4.1',
  voice: 'ash',
  customPrompt: 'This must be ignored rather than changing production behavior.',
});
assert.deepEqual(settings, {
  promptPreset: 'production_guarded',
  model: VOB_LIVEKIT_PRODUCTION_MODEL,
  voice: VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE,
});
assert.equal(normalizeVobTestSettings({ model: 'not-a-model', voice: 'nope' }).model, VOB_LIVEKIT_PRODUCTION_MODEL);

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
assert.equal(store.get('vob-test-1').settings.voice, VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE);
assert.equal(store.size(), 1);
store.delete('vob-test-1');
assert.equal(store.get('vob-test-1'), null);

console.log('vob test mode: ok');
