#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempHome = mkdtempSync(join(tmpdir(), 'box-claude-history-e2e-'));
const workspace = join(tempHome, 'workspace');
const id = '00000000-0000-4000-8000-000000000450';
const title = 'Synthetic Claude history pagination';
const token = 'claude-history-test-token';
const project = join(tempHome, '.claude', 'projects', '-synthetic');
mkdirSync(project, { recursive: true });
mkdirSync(workspace, { recursive: true });
const rows = Array.from({ length: 450 }, (_, i) => ({
  type: 'user', timestamp: '2026-10-01T00:00:00Z',
  message: { role: 'user', content: `SYNTHETIC_HISTORY_MESSAGE_${String(i).padStart(3, '0')}` },
}));
rows.push({ type: 'custom-title', customTitle: title, sessionId: id });
writeFileSync(join(project, `${id}.jsonl`), `${rows.map(JSON.stringify).join('\n')}\n`);
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
});
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env: {
  PATH: process.env.PATH, HOME: tempHome, PORT: String(port), CC_AUTH_TOKEN: token,
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
  const headers = { Authorization: `Bearer ${token}` };
  const first = await (await fetch(`${base}/api/sessions/${id}/history`, { headers })).json();
  assert.equal(first.messages.length, 400);
  assert.equal(first.hasMore, true);
  assert.equal(first.messages[0].parts[0].text, 'SYNTHETIC_HISTORY_MESSAGE_050');
  const earlier = await (await fetch(`${base}/api/sessions/${id}/history?before=${first.cursor}`, { headers })).json();
  assert.equal(earlier.messages.length, 50);
  assert.equal(earlier.hasMore, false);
  assert.equal(earlier.messages[0].parts[0].text, 'SYNTHETIC_HISTORY_MESSAGE_000');

  const require = createRequire(import.meta.url);
  let playwright;
  try { playwright = require('@playwright/test'); } catch { playwright = require('/home/factory/development/tools/playwright/node_modules/@playwright/test'); }
  browser = await playwright.webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#tokenInput').fill(token);
  await page.locator('#loginBtn').click();
  await page.locator('#sessions:not(.hidden)').waitFor();
  await page.getByText(title, { exact: true }).first().click();
  await page.locator('#chat').getByText('SYNTHETIC_HISTORY_MESSAGE_449', { exact: true }).waitFor();
  for (let i = 0; i < 6; i++) {
    if (await page.locator('#chat').getByText('SYNTHETIC_HISTORY_MESSAGE_000', { exact: true }).count()) break;
    await page.locator('#messages').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(300);
  }
  await page.locator('#chat').getByText('SYNTHETIC_HISTORY_MESSAGE_000', { exact: true }).waitFor({ timeout: 10_000 });
  await page.locator('#chat').getByText('— beginning of conversation —', { exact: true }).waitFor();
  await page.locator('#messages').evaluate((el) => { el.scrollTop = 0; });
  await page.screenshot({ path: '/tmp/box-claude-history-pagination.png', fullPage: false });
  console.log(JSON.stringify({ ok: true, screenshot: '/tmp/box-claude-history-pagination.png' }));
} finally {
  await browser?.close().catch(() => {});
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
  rmSync(tempHome, { recursive: true, force: true });
}
