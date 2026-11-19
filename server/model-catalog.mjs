import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { codexRpc } from './codex-app-server-client.mjs';
import { discoverClaudeModels } from './claude-model-catalog.mjs';

export function recentModels(models, generations = 3) {
  const version = (m) => m.id.match(/(?:gpt-|claude-(?:opus|sonnet|haiku|fable)-)(\d+)(?:[.-](\d+))?/)?.slice(1).map((n) => Number(n || 0)) || null;
  const family = (m) => m.id.startsWith('claude-') ? m.id.split('-')[1] : 'gpt';
  const groups = new Map();
  for (const m of models) {
    if (!version(m)) continue;
    const key = family(m), versions = groups.get(key) || [];
    versions.push(version(m).join('.')); groups.set(key, versions);
  }
  for (const [key, versions] of groups) groups.set(key, [...new Set(versions)].sort((a, b) => {
    const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
    return bb[0] - aa[0] || bb[1] - aa[1];
  }).slice(0, generations));
  return models.filter((m) => !version(m) || groups.get(family(m)).includes(version(m).join('.')));
}
export async function discoverCodexModels(rpc = codexRpc) {
  const models = [], seen = new Set();
  let cursor, pages = 0;
  do {
    if (++pages > 20) throw new Error('Codex catalog page limit exceeded');
    const page = await rpc('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw new Error('Invalid Codex model catalog');
    for (const m of page.data) {
      if (m.hidden || !m.model || seen.has(m.model)) continue;
      seen.add(m.model);
      models.push({ id: m.model, label: m.displayName || m.model, desc: m.description || '',
        efforts: (m.supportedReasoningEfforts || []).map((e) => ({ id: e.reasoningEffort, label: e.reasoningEffort === 'xhigh' ? 'XHigh' : e.reasoningEffort[0].toUpperCase() + e.reasoningEffort.slice(1), desc: e.description || '' })),
        defaultEffort: m.defaultReasoningEffort,
      });
    }
    if (page.nextCursor && seen.has(`cursor:${page.nextCursor}`)) throw new Error('Repeated Codex catalog cursor');
    cursor = page.nextCursor; if (cursor) seen.add(`cursor:${cursor}`);
  } while (cursor);
  if (!models.length) throw new Error('Empty Codex model catalog');
  return models;
}
const validModels = (models) => Array.isArray(models) && models.length > 0 && models.length <= 300 && models.every((m) =>
  typeof m.id === 'string' && m.id.length < 200 && typeof m.label === 'string' && Array.isArray(m.efforts) && m.efforts.every((e) => typeof e.id === 'string' && typeof e.label === 'string'));
export function createModelCatalog({ stateDir, ttlMs = 3600000, discover = { codex: discoverCodexModels, claude: discoverClaudeModels }, now = Date.now, disabled = false } = {}) {
  const providers = {}, pending = {}, attempted = {};
  const file = path.join(stateDir, 'model-catalog.json');
  let loaded;
  const load = () => loaded ||= (async () => {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      for (const name of ['codex', 'claude']) if (validModels(saved[name]?.models) && Number.isFinite(saved[name].updatedAt)) providers[name] = saved[name];
    } catch {}
  })();
  async function refresh(name) {
    if (pending[name]) return pending[name];
    pending[name] = (async () => {
      try {
        attempted[name] = now();
        const models = await discover[name]();
        if (!validModels(models)) throw new Error('Invalid catalog');
        providers[name] = { models, updatedAt: now() };
      } catch { /* Preserve last successful catalog; never expose CLI stderr or credentials. */ }
      finally { delete pending[name]; }
    })();
    return pending[name];
  }
  let writing = Promise.resolve();
  return { async get() {
    await load();
    if (!disabled) {
      await Promise.all(['codex', 'claude'].map((name) => pending[name] || ((!providers[name] || now() - providers[name].updatedAt >= ttlMs) && (attempted[name] === undefined || now() - attempted[name] >= 300000) ? refresh(name) : null)));
      writing = writing.catch(() => {}).then(async () => {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await writeFile(file + '.tmp', JSON.stringify(providers), { mode: 0o600 });
        await rename(file + '.tmp', file);
      });
      await writing.catch(() => {});
    }
    return Object.fromEntries(['codex', 'claude'].map((name) => [name, {
      ...providers[name], allModels: providers[name]?.models || [], models: recentModels(providers[name]?.models || []),
      stale: !providers[name] || now() - providers[name].updatedAt >= ttlMs,
    }]));
  } };
}
