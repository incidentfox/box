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
const ARTIFACT = process.env.BOX_MODEL_CATALOG_SCREENSHOT
  || join(tmpdir(), 'box-model-catalog-local.png');

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
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const fixtureModel = (id, label, efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) => ({ id, label, efforts: efforts.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })), defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0] || '' });
mkdirSync(join(tempHome, '.cc-mobile'));
writeFileSync(join(tempHome, '.cc-mobile/model-catalog.json'), JSON.stringify({
  codex: { updatedAt: Date.now(), models: [fixtureModel('gpt-6.2-sol', 'GPT-6.2 Sol'), fixtureModel('gpt-6.2-astra', 'GPT-6.2 Astra'), fixtureModel('gpt-6.1-sol', 'GPT-6.1 Sol'), fixtureModel('gpt-6-sol', 'GPT-6 Sol'), fixtureModel('gpt-5.6-sol', 'GPT-5.6 Sol')] },
  claude: { updatedAt: Date.now(), models: [fixtureModel('claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max']), fixtureModel('claude-test-9-1', 'Test model without effort', [])] },
}));
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH,
    BOX_HOST_SECRETS_FILE: '/dev/null',
    HOME: tempHome,
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
  page.setDefaultTimeout(10000);
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#tokenInput').fill(TOKEN);
  await page.locator('#loginBtn').click();
  await page.locator('#sessions:not(.hidden)').waitFor();

  await page.locator('#newBtn').click();
  await page.locator('#sheet:not(.hidden)').waitFor();
  await page.locator('.sheetRow').filter({ hasText: 'Codex' }).first().click();
  await page.locator('#chat:not(.hidden)').waitFor();
  await page.locator('#agentLabel').filter({ hasText: 'GPT-6.1 Sol · medium' }).waitFor();

  await page.locator('#agentChip').click();
  await page.locator('.sheetRow').filter({ hasText: 'Current agent' }).click();
  await page.locator('#sheetInner h3').filter({ hasText: 'Codex model' }).waitFor();

  if (await page.locator('.sheetRow').filter({ hasText: 'GPT-5.6 Sol' }).count()) throw Error('Old generation leaked into menu');
  await page.locator('.sheetRow').filter({ hasText: 'GPT-6.2 Astra' }).click();
  await page.locator('.sheetRow').filter({ hasText: 'Ultra' }).click();
  await page.locator('#agentLabel').filter({ hasText: 'GPT-6.2 Astra · ultra' }).waitFor();
  await page.locator('#sheetInner h3').filter({ hasText: 'Codex model' }).waitFor();
  await page.screenshot({ path: join(tmpdir(), 'box-dynamic-models.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.locator('#agentChip').click();
  await page.locator('.sheetRow').filter({ hasText: 'Claude' }).first().click();
  await page.locator('#agentChip').click();
  await page.locator('.sheetRow').filter({ hasText: 'Current agent' }).click();
  await page.locator('#sheetInner h3').filter({ hasText: 'Claude model' }).waitFor();
  await page.locator('.sheetRow').filter({ hasText: 'Test model without effort' }).click();
  if (await page.locator('.sheetRow').filter({ hasText: /^Max$/ }).count()) throw Error('Unsupported Claude effort remained visible');
  const cfg = await page.evaluate(() => cur.settings.claude);
  if (cfg.effort !== '') throw Error('Unsupported Claude effort was not cleared');
  const catalog = await fetch(baseUrl + '/api/models', { headers: { Authorization: 'Bearer ' + TOKEN } }).then(r => r.json());
  if (catalog.codex.models.length !== 4 || catalog.codex.allModels.length !== 5) throw Error('Wrong visible/retained catalog');
  if ((await fetch(baseUrl + '/api/models')).status !== 401) throw Error('Catalog must require auth');
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  await page.screenshot({ path: ARTIFACT, fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    screenshot: ARTIFACT,
  }, null, 2));
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
