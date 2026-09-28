#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempHome = mkdtempSync(join(tmpdir(), 'box-chat-isolation-'));
const codexHome = join(tempHome, '.codex');
const workspace = join(tempHome, 'workspace');
const token = 'chat-isolation-test-token';
const ids = ['00000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000042'];
const titles = ['Bay synthetic', 'Unused synthetic'];
const prompts = ['BAY_ONLY_SYNTHETIC', 'UNUSED_ONLY_SYNTHETIC'];
const now = new Date().toISOString();
const rollouts = join(codexHome, 'sessions', '2026', '09', '28');
mkdirSync(rollouts, { recursive: true });
mkdirSync(join(tempHome, '.cc-mobile'), { recursive: true });
mkdirSync(workspace, { recursive: true });
for (let i = 0; i < ids.length; i++) {
  const rows = [
    { timestamp: now, type: 'session_meta', payload: { id: ids[i], cwd: workspace, timestamp: now } },
    { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompts[i] }] } },
  ];
  writeFileSync(join(rollouts, `rollout-2026-09-28T00-00-0${i}-${ids[i]}.jsonl`), rows.map(JSON.stringify).join('\n') + '\n');
}
writeFileSync(join(tempHome, '.cc-mobile', 'codex-sessions.json'), JSON.stringify({ sessions: Object.fromEntries(ids.map((id, i) => [id, {
  id, title: titles[i], cwd: workspace, createdAt: now, updatedAt: now, agent: 'codex',
}])) }));
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
});
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env: {
  PATH: process.env.PATH, HOME: tempHome, CODEX_HOME: codexHome, PORT: String(port), CC_AUTH_TOKEN: token,
  CC_WORKSPACE: workspace, BOX_IGNORE_LOCAL_ENV: '1', BOX_HOST_SECRETS_FILE: '/dev/null',
  BOX_SKIP_META_PROBE: '1', BOX_TEAM: '0', LINEAR_LOCAL: 'off',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const deadline = Date.now() + 20_000;
  while (true) {
    if (child.exitCode !== null) throw Error(`server exited: ${child.exitCode}`);
    try { if ((await fetch(base)).ok) break; } catch {}
    if (Date.now() > deadline) throw Error('server startup timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
  const require = createRequire(import.meta.url);
  let playwright;
  try { playwright = require('@playwright/test'); } catch { playwright = require('/home/factory/development/tools/playwright/node_modules/@playwright/test'); }
  browser = await playwright.webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#tokenInput').fill(token);
  await page.locator('#loginBtn').click();
  await page.locator('#sessions:not(.hidden)').waitFor();
  for (let i = 0; i < ids.length; i++) {
    await page.getByText(titles[i], { exact: true }).first().click();
    await page.locator('#chat').getByText(prompts[i], { exact: true }).waitFor();
    assert.equal((await page.locator('#chat').innerText()).includes(prompts[1 - i]), false);
  }
  await page.screenshot({ path: '/tmp/box-chat-isolation.png', fullPage: true });

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((r, reject) => { socket.once('open', r); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'subscribe', key: ids[0] }));
  await new Promise((r, reject) => {
    const timeout = setTimeout(() => reject(Error('sync timeout')), 5000);
    socket.on('message', function onMessage(raw) { if (JSON.parse(String(raw)).type === 'sync') { clearTimeout(timeout); socket.off('message', onMessage); r(); } });
  });
  socket.send(JSON.stringify({ type: 'settings', key: ids[1], settings: { codex: { model: 'gpt-6-sol', effort: 'high' } } }));
  const rejected = await new Promise((r, reject) => {
    const timeout = setTimeout(() => reject(Error('cross-chat guard timeout')), 5000);
    socket.on('message', function onMessage(raw) { const event = JSON.parse(String(raw)); if (event.type === 'error') { clearTimeout(timeout); socket.off('message', onMessage); r(event); } });
  });
  assert.match(rejected.msg, /Chat changed/);
  socket.close();
  console.log(JSON.stringify({ ok: true, screenshot: '/tmp/box-chat-isolation.png' }));
} finally {
  await browser?.close().catch(() => {});
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  rmSync(tempHome, { recursive: true, force: true });
}
