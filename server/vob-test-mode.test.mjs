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
  VOB_HUMAN_PHASE_CONTEXT,
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
assert.equal(catalog.initialCallState, 'connected_to_live_representative');
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
    packetFacts: [
      { key: 'patient.name', value: 'Jordan Cissell', status: 'packet' },
      { key: 'patient.memberId', value: 'G4P591M89472', status: 'packet' },
      { key: 'patient.dob', value: '1990-12-10', status: 'packet' },
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
assert.match(config.instructions, /patient_member_id: G4P591M89472/);
assert.match(config.instructions, /patient_dob: 1990-12-10/);
assert.match(config.instructions, /CALL DATA section is the authoritative call packet/);
assert.match(config.instructions, /CALL DATA/);
assert.match(config.instructions, /EVIDENCE LEDGER/);
assert.match(config.instructions, new RegExp(VOB_HUMAN_PHASE_CONTEXT.split('\\n')[0]));
assert.match(config.instructions, /IVR routing and hold\/queue audio as already completed/);
assert.match(config.instructions, /same provider-side caller at the start of the live-representative phase/);
assert.doesNotMatch(config.instructions, /simulation|test mode|role-playing/i);
assert.doesNotMatch(config.instructions, /Additional operator instruction/);

const store = createVobTestConfigStore({ ttlMs: 60_000 });
store.put(config);
assert.equal(store.get('vob-test-1').settings.voice, VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE);
assert.equal(store.size(), 1);
store.delete('vob-test-1');
assert.equal(store.get('vob-test-1'), null);

console.log('vob test mode: ok');
