import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createModelCatalog, discoverCodexModels, recentModels } from './model-catalog.mjs';
const model = (id) => ({ id, label: id, efforts: [{ id: 'medium', label: 'Medium' }], defaultEffort: 'medium' });

test('latest three generations retain every tier and Claude family independently', () => {
  const ids = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-luna', 'claude-opus-5-5', 'claude-haiku-4-5', 'codex-mini-latest'];
  assert.deepEqual(recentModels(ids.map(model)).map((m) => m.id), ids.filter((id) => id !== 'gpt-5.6-luna'));
});
test('Codex discovery pages, removes hidden/duplicate entries and preserves capability metadata', async () => {
  const calls = [];
  const rows = [{ model: 'gpt-future', displayName: 'Future', defaultReasoningEffort: 'adaptive', supportedReasoningEfforts: [{ reasoningEffort: 'adaptive', description: 'New effort' }] }, { model: 'hidden', hidden: true }];
  const models = await discoverCodexModels(async (method, params) => {
    calls.push([method, params]);
    return { data: rows, nextCursor: params.cursor ? null : 'next' };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].cursor, 'next');
  assert.deepEqual(models, [{ id: 'gpt-future', label: 'Future', desc: '', defaultEffort: 'adaptive', efforts: [{ id: 'adaptive', label: 'Adaptive', desc: 'New effort' }] }]);
  await assert.rejects(discoverCodexModels(async () => ({ data: rows, nextCursor: 'same' })), /Repeated/);
});
test('catalog coalesces requests, refreshes independently and persists last success across outages/restarts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'box-catalog-test-'));
  try {
    let time = 1000, calls = 0, fail = false;
    const discover = { codex: async () => { calls++; await new Promise((r) => setTimeout(r, 10)); if (fail) throw Error('SECRET must never leak'); return ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'].map(model); }, claude: async () => { if (fail) throw Error('unavailable'); return [model('claude-opus-5-5')]; } };
    const catalog = createModelCatalog({ stateDir: dir, now: () => time, ttlMs: 100, discover });
    const [first, same] = await Promise.all([catalog.get(), catalog.get()]);
    assert.equal(calls, 1);
    assert.deepEqual(first, same);
    assert.equal(first.codex.models.length, 3);
    assert.equal(first.codex.allModels.length, 4); // Current old chats retain their capabilities.
    time += 300001; fail = true;
    const outage = await catalog.get();
    assert.equal(outage.codex.stale, true);
    assert.equal(outage.codex.models[0].id, 'gpt-6.2-sol');
    assert.equal(JSON.stringify(outage).includes('SECRET'), false);
    await catalog.get(); assert.equal(calls, 2); // Backoff on failure.
    const restarted = await createModelCatalog({ stateDir: dir, disabled: true }).get();
    assert.deepEqual(restarted.codex.models, first.codex.models);
    time += 300001;
    discover.claude = async () => [model('claude-fable-5-2')];
    const recovered = await catalog.get();
    assert.equal(recovered.claude.models[0].id, 'claude-fable-5-2');
    assert.equal(recovered.codex.models[0].id, 'gpt-6.2-sol');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
