import {
  VOB_PRODUCTION_MODEL,
  VOB_PRODUCTION_INSTRUCTIONS,
  VOB_PRODUCTION_PROMPT_SOURCE,
  VOB_PRODUCTION_PROMPT_VERSION,
  buildVobProductionInstructions,
} from './vob-production-prompt.mjs';

// Keep the owner test room on the same media/runtime contract as the real
// Rise4 payer call.  The prompt compiler above uses Luna to assemble the
// deterministic call instructions; this separate model is the LiveKit
// conversation model that actually speaks with the representative.
export const VOB_LIVEKIT_PRODUCTION_MODEL = 'google/gemma-4-31b-it';
export const VOB_LIVEKIT_PRODUCTION_STT_MODEL = 'deepgram/flux-general-en';
export const VOB_LIVEKIT_PRODUCTION_TTS_MODEL = 'cartesia/sonic-3.5';
export const VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE = '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc';

// Ephemeral configuration for owner-only VOB test rooms. The agent receives the
// same pinned production caller contract used by a real payer call. The case
// snapshot is copied into memory only long enough for the LiveKit agent to load
// it; it is never written to the repository or durable chat history.

export const VOB_TEST_PROMPTS = Object.freeze([
  {
    id: 'production_guarded',
    label: 'Production VOB caller',
    description: `Exact production caller contract (${VOB_PRODUCTION_PROMPT_VERSION}).`,
  },
]);

export const VOB_TEST_MODELS = Object.freeze([
  {
    id: VOB_LIVEKIT_PRODUCTION_MODEL,
    label: 'Gemma 4 31B IT — production',
    description: 'Exact production LiveKit caller model.',
  },
]);

export const VOB_TEST_VOICES = Object.freeze([
  {
    id: VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE,
    label: 'Cartesia Sonic 3.5 — production voice',
    description: 'Exact production Cartesia voice.',
  },
]);

// The owner room is intentionally initialized after routing. It still uses the
// exact production caller contract and runtime; this is only the call-state
// snapshot the real worker would have after IVR and queue audio finish.
export const VOB_HUMAN_PHASE_CONTEXT = `CONNECTED TO LIVE REPRESENTATIVE
- Treat IVR routing and hold/queue audio as already completed for this call.
- Do not navigate an IVR, say the IVR reason phrase "eligibility and benefits," or ask the representative to transfer you.
- A live payer representative has just answered. You are the same provider-side caller at the start of the live-representative phase.
- On your first turn, introduce yourself and state the packet-grounded purpose in one concise sentence. Then wait for the representative's response.
- Continue with the production LIVE REPRESENTATIVE rules and unresolved evidence ledger fields, one question at a time.`;

const DEFAULTS = Object.freeze({
  promptPreset: 'production_guarded',
  model: VOB_LIVEKIT_PRODUCTION_MODEL,
  voice: VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE,
});

function idSet(items) { return new Set(items.map((item) => item.id)); }
const PROMPT_IDS = idSet(VOB_TEST_PROMPTS);
const MODEL_IDS = idSet(VOB_TEST_MODELS);
const VOICE_IDS = idSet(VOB_TEST_VOICES);

const clean = (value, max = 200) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

function copyRows(rows, limit = 600) {
  return (Array.isArray(rows) ? rows : []).slice(0, limit).map((row) => {
    if (!row || typeof row !== 'object') return { key: clean(row, 200), value: null, status: 'unknown' };
    return {
      key: clean(row.key, 200),
      value: row.value == null ? null : clean(row.value, 2000),
      status: clean(row.status || 'unknown', 80),
      ...(Array.isArray(row.sourceCallIds) ? { sourceCallIds: row.sourceCallIds.map((id) => clean(id, 180)).filter(Boolean).slice(0, 20) } : {}),
    };
  }).filter((row) => row.key);
}

function testDataFromSnapshot(snapshot = {}) {
  return {
    requestId: clean(snapshot.requestId, 180) || null,
    payerName: clean(snapshot.payerName, 240) || null,
    status: clean(snapshot.status, 80) || null,
    note: clean(snapshot.note, 800) || null,
    packetFacts: copyRows(snapshot.packetFacts),
    facts: copyRows(snapshot.facts),
    ledger: (Array.isArray(snapshot.ledger) ? snapshot.ledger : []).slice(0, 100).map((call) => ({
      callId: clean(call?.callId, 180),
      sequence: call?.sequence || null,
      kind: clean(call?.kind, 120),
      attemptStatus: clean(call?.attemptStatus, 80),
      focusFields: Array.isArray(call?.focusFields) ? call.focusFields.map((field) => clean(field, 200)).filter(Boolean).slice(0, 100) : [],
      fields: copyRows(call?.fields, 300),
    })),
  };
}

export function normalizeVobTestSettings(input = {}) {
  const body = input && typeof input === 'object' ? input : {};
  const promptPreset = PROMPT_IDS.has(String(body.promptPreset || '')) ? String(body.promptPreset) : DEFAULTS.promptPreset;
  const model = MODEL_IDS.has(String(body.model || '')) ? String(body.model) : DEFAULTS.model;
  const voice = VOICE_IDS.has(String(body.voice || '')) ? String(body.voice) : DEFAULTS.voice;
  const promptText = typeof body.promptText === 'string'
    ? body.promptText.trim().slice(0, 50_000)
    : '';
  return { promptPreset, model, voice, ...(promptText ? { promptText } : {}) };
}

export function buildVobTestInstructions({ snapshot = {}, settings = DEFAULTS } = {}) {
  const normalized = normalizeVobTestSettings(settings);
  if (normalized.promptPreset !== 'production_guarded') {
    throw new Error(`unsupported VOB prompt preset: ${normalized.promptPreset}`);
  }
  return `${buildVobProductionInstructions({ snapshot, basePrompt: normalized.promptText || VOB_PRODUCTION_INSTRUCTIONS })}\n\nCALL STATE AT CONNECT\n${VOB_HUMAN_PHASE_CONTEXT}`;
}

export function vobTestCatalog() {
  return {
    prompts: VOB_TEST_PROMPTS.map((item) => ({ ...item })),
    models: VOB_TEST_MODELS.map((item) => ({ ...item })),
    voices: VOB_TEST_VOICES.map((item) => ({ ...item })),
    productionPrompt: {
      version: VOB_PRODUCTION_PROMPT_VERSION,
      source: VOB_PRODUCTION_PROMPT_SOURCE,
      model: VOB_PRODUCTION_MODEL,
      baseText: VOB_PRODUCTION_INSTRUCTIONS,
    },
    productionRuntime: {
      llmProvider: 'livekit-inference',
      model: VOB_LIVEKIT_PRODUCTION_MODEL,
      sttProvider: 'livekit-inference',
      sttModel: VOB_LIVEKIT_PRODUCTION_STT_MODEL,
      ttsProvider: 'livekit-inference',
      ttsModel: VOB_LIVEKIT_PRODUCTION_TTS_MODEL,
      voice: VOB_LIVEKIT_PRODUCTION_CARTESIA_VOICE,
    },
    initialCallState: 'connected_to_live_representative',
    defaults: { ...DEFAULTS },
  };
}

export function createVobTestConfig({ testId, sessionId, snapshot, settings, ttlMs = 20 * 60 * 1000 } = {}) {
  const now = Date.now();
  const normalized = normalizeVobTestSettings(settings);
  const catalog = vobTestCatalog();
  return {
    testId: clean(testId, 120),
    sessionId: clean(sessionId, 180),
    settings: normalized,
    productionPrompt: catalog.productionPrompt,
    productionRuntime: catalog.productionRuntime,
    promptEditor: {
      version: catalog.productionPrompt.version,
      source: catalog.productionPrompt.source,
      productionBaseText: VOB_PRODUCTION_INSTRUCTIONS,
      baseText: normalized.promptText || VOB_PRODUCTION_INSTRUCTIONS,
      humanPhaseContext: VOB_HUMAN_PHASE_CONTEXT,
      compiledText: buildVobTestInstructions({ snapshot, settings: normalized }),
      overrideActive: Boolean(normalized.promptText),
    },
    initialCallState: catalog.initialCallState,
    testData: testDataFromSnapshot(snapshot),
    instructions: buildVobTestInstructions({ snapshot, settings: normalized }),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(60_000, Number(ttlMs) || 20 * 60 * 1000)).toISOString(),
  };
}

export function createVobTestConfigStore({ ttlMs = 20 * 60 * 1000 } = {}) {
  const configs = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [id, value] of configs) if (Date.parse(value.expiresAt) <= now) configs.delete(id);
  };
  return {
    put(config) { prune(); if (!config?.testId) throw new Error('test config needs an id'); configs.set(config.testId, config); return config; },
    create(args) { const config = createVobTestConfig({ ...args, ttlMs }); return this.put(config); },
    get(testId) { prune(); return configs.get(String(testId || '')) || null; },
    delete(testId) { return configs.delete(String(testId || '')); },
    size() { prune(); return configs.size; },
  };
}
