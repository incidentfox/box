#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'astra-browser-smoke-token';
const ARTIFACT = process.env.BOX_ASTRA_HISTORY_SCREENSHOT
  || join(tmpdir(), 'box-astra-history-fixed.png');

const reservePort = () => new Promise((resolvePort, reject) => {
  const socket = createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const { port } = socket.address();
    socket.close((error) => error ? reject(error) : resolvePort(port));
  });
});

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Box exited before startup (${child.exitCode})`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for isolated Box server');
}

async function loadPlaywright() {
  try {
    return await import('@playwright/test');
  } catch {
    const playwrightDir = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
    return createRequire(join(playwrightDir, 'package.json'))('@playwright/test');
  }
}

const tempHome = mkdtempSync(join(tmpdir(), 'box-astra-e2e-'));
const sessionId = '00000000-0000-4000-8000-000000000006';
const codexHome = join(tempHome, '.codex');
const rolloutDir = join(codexHome, 'sessions', '2026', '09', '05');
mkdirSync(rolloutDir, { recursive: true });
mkdirSync(join(tempHome, '.cc-mobile'), { recursive: true });
const timestamp = new Date().toISOString();
const row = (role, text, phase = '') => ({ timestamp, type: 'response_item',
  payload: { type: 'message', role, phase, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
writeFileSync(join(rolloutDir, `rollout-2026-09-05T07-00-00-${sessionId}.jsonl`), [
  { type: 'session_meta', payload: { id: sessionId, cwd: ROOT, timestamp } },
  row('developer', 'PRIVATE_CONTEXT_MUST_NOT_RENDER'),
  row('user', '# AGENTS.md instructions for PRIVATE_CONTEXT_MUST_NOT_RENDER'),
  row('user', 'Check that Astra conversation history is visible.'),
  row('assistant', 'I am checking the saved transcript.', 'commentary'),
  { timestamp, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'check', arguments: '{"cmd":"echo verified"}' } },
  { timestamp, type: 'response_item', payload: { type: 'function_call_output', call_id: 'check', output: 'verified' } },
  row('assistant', 'The Astra conversation is restored. User messages, progress updates, and the final answer are all visible.', 'final_answer'),
].map(JSON.stringify).join('\n') + '\n');
writeFileSync(join(tempHome, '.cc-mobile', 'codex-sessions.json'), JSON.stringify({ sessions: {
  [sessionId]: { id: sessionId, title: 'Astra history verification', cwd: ROOT, createdAt: timestamp,
    updatedAt: timestamp, settings: { codex: { model: 'gpt-6-astra', effort: 'high' } } },
} }));
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOME: tempHome,
    CODEX_HOME: codexHome,
    PORT: String(port),
    CC_AUTH_TOKEN: TOKEN,
    CC_WORKSPACE: ROOT,
    BOX_IGNORE_LOCAL_ENV: '1',
    BOX_SKIP_META_PROBE: '1',
    LINEAR_LOCAL: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
try {
  await waitForServer(baseUrl, child);
  const { webkit } = await loadPlaywright();
  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#tokenInput').fill(TOKEN);
  await page.locator('#loginBtn').click();
  await page.locator('#sessions:not(.hidden)').waitFor();

  await page.getByText('Astra history verification', { exact: true }).first().click();
  await page.locator('#chat:not(.hidden)').waitFor();
  for (const text of [
    'Check that Astra conversation history is visible.',
    'I am checking the saved transcript.',
    'The Astra conversation is restored. User messages, progress updates, and the final answer are all visible.',
  ]) {
    const message = page.locator('#chat').getByText(text, { exact: true });
    await message.waitFor();
    if (await message.count() !== 1) throw new Error(`Duplicate message: ${text}`);
  }
  if ((await page.locator('#chat').innerText()).includes('PRIVATE_CONTEXT_MUST_NOT_RENDER')) throw new Error('Private context rendered');
  await page.screenshot({ path: ARTIFACT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#chat').getByText('I am checking the saved transcript.', { exact: true }).waitFor();
  await page.screenshot({ path: ARTIFACT.replace('.png', '-mobile.png'), fullPage: true });
  console.log(JSON.stringify({ ok: true, screenshot: ARTIFACT, mobile: ARTIFACT.replace('.png', '-mobile.png') }));

} finally {
  await browser?.close().catch(() => {});
  child.kill('SIGTERM');
  await new Promise((resolveWait) => {
    if (child.exitCode !== null) return resolveWait();
    child.once('exit', resolveWait);
    setTimeout(() => { child.kill('SIGKILL'); resolveWait(); }, 3_000).unref();
  });
  rmSync(tempHome, { recursive: true, force: true });
}
