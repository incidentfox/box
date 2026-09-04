import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Pull the effort table + its two helpers straight out of app.js (same trick the other
// public/ tests use — app.js is a browser script, not a module).
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = app.indexOf('// Ordered cheapest → deepest;');
const end = app.indexOf('const CLAUDE_MODELS = [', start);
assert.ok(start >= 0 && end > start, 'locate the Codex effort table');

const ctx = {};
vm.runInNewContext(`${app.slice(start, end)}\nefforts = codexEffortsForModel; clamp = clampCodexEffort;`, ctx);
// Array.from re-homes the vm's array into this realm, so deepEqual compares values
// instead of failing the cross-realm prototype check.
const ids = (model) => Array.from(ctx.efforts(model), (e) => e.id);

// Expected values are Codex's own `supported_reasoning_levels` (~/.codex/models_cache.json).
// If Codex adds a level or a model, update BOTH this table and codexEffortsForModel.
test('effort list matches what each model actually supports', () => {
  assert.deepEqual(ids('gpt-6-astra'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(ids('gpt-5.6-sol'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(ids('gpt-5.6-terra'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(ids('gpt-5.6-luna'), ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const m of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']) {
    assert.deepEqual(ids(m), ['low', 'medium', 'high', 'xhigh'], m);
  }
});

test('Max stays selectable on Astra and 5.6 — the regression that hid it', () => {
  for (const m of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.ok(ids(m).includes('max'), `${m} must offer Max`);
  }
  assert.ok(!ids('gpt-5.5').includes('max'), '5.5 must not offer Max');
});

test('an unknown or empty model falls back to the universally-safe list', () => {
  assert.deepEqual(ids(''), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(ids(undefined), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(ids('some-future-model'), ['low', 'medium', 'high', 'xhigh']);
});

test('switching models clamps a stranded effort to the deepest supported', () => {
  assert.equal(ctx.clamp('gpt-6-astra', 'ultra'), 'max');
  assert.equal(ctx.clamp('gpt-5.5', 'ultra'), 'xhigh');
  assert.equal(ctx.clamp('gpt-5.5', 'max'), 'xhigh');
  assert.equal(ctx.clamp('gpt-5.6-luna', 'ultra'), 'max');
  // Supported efforts are left exactly as the user set them.
  assert.equal(ctx.clamp('gpt-5.6-sol', 'ultra'), 'ultra');
  assert.equal(ctx.clamp('gpt-5.6-luna', 'max'), 'max');
  assert.equal(ctx.clamp('gpt-5.5', 'high'), 'high');
});

test('Astra is the default and first Codex picker option', () => {
  assert.match(app, /codex: \{ model: 'gpt-6-astra', reasoningEffort: 'high'/);
  assert.match(app, /mac: \{ model: 'gpt-6-astra', reasoningEffort: 'medium'/);
  assert.ok(app.indexOf("{ id: 'gpt-6-astra'") < app.indexOf("{ id: 'gpt-5.6-sol'"));
});
