import {
  VOB_PRODUCTION_MODEL,
  VOB_PRODUCTION_PROMPT_SOURCE,
  VOB_PRODUCTION_PROMPT_VERSION,
  buildVobProductionInstructions,
} from './vob-production-prompt.mjs';

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
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Fast and economical.' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Fast, concise instruction following.' },
  { id: 'gpt-4.1', label: 'GPT-4.1', description: 'Higher reasoning quality for nuanced calls.' },
  { id: 'gpt-4o', label: 'GPT-4o', description: 'Natural conversational output.' },
]);

export const VOB_TEST_VOICES = Object.freeze([
  { id: 'marin', label: 'Marin' },
  { id: 'ash', label: 'Ash' },
  { id: 'cedar', label: 'Cedar' },
  { id: 'coral', label: 'Coral' },
  { id: 'ballad', label: 'Ballad' },
  { id: 'sage', label: 'Sage' },
  { id: 'verse', label: 'Verse' },
  { id: 'alloy', label: 'Alloy' },
  { id: 'echo', label: 'Echo' },
  { id: 'fable', label: 'Fable' },
  { id: 'onyx', label: 'Onyx' },
  { id: 'nova', label: 'Nova' },
  { id: 'shimmer', label: 'Shimmer' },
]);

const DEFAULTS = Object.freeze({ promptPreset: 'production_guarded', model: 'gpt-4.1-mini', voice: 'marin' });

function idSet(items) { return new Set(items.map((item) => item.id)); }
const PROMPT_IDS = idSet(VOB_TEST_PROMPTS);
const MODEL_IDS = idSet(VOB_TEST_MODELS);
const VOICE_IDS = idSet(VOB_TEST_VOICES);

const clean = (value, max = 200) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

export function normalizeVobTestSettings(input = {}) {
  const body = input && typeof input === 'object' ? input : {};
  const promptPreset = PROMPT_IDS.has(String(body.promptPreset || '')) ? String(body.promptPreset) : DEFAULTS.promptPreset;
  const model = MODEL_IDS.has(String(body.model || '')) ? String(body.model) : DEFAULTS.model;
  const voice = VOICE_IDS.has(String(body.voice || '')) ? String(body.voice) : DEFAULTS.voice;
  return { promptPreset, model, voice };
}

export function buildVobTestInstructions({ snapshot = {}, settings = DEFAULTS } = {}) {
  const normalized = normalizeVobTestSettings(settings);
  if (normalized.promptPreset !== 'production_guarded') {
    throw new Error(`unsupported VOB prompt preset: ${normalized.promptPreset}`);
  }
  return buildVobProductionInstructions({ snapshot });
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
    },
    defaults: { ...DEFAULTS },
  };
}

export function createVobTestConfig({ testId, sessionId, snapshot, settings, ttlMs = 20 * 60 * 1000 } = {}) {
  const now = Date.now();
  const normalized = normalizeVobTestSettings(settings);
  return {
    testId: clean(testId, 120),
    sessionId: clean(sessionId, 180),
    settings: normalized,
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
