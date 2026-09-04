#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'astra-browser-smoke-token';
const ARTIFACT = process.env.BOX_ASTRA_SCREENSHOT
  || join(tmpdir(), 'box-gpt6-astra-local.png');

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
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
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
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#tokenInput').fill(TOKEN);
  await page.locator('#loginBtn').click();
  await page.locator('#sessions:not(.hidden)').waitFor();

  await page.locator('#newBtn').click();
  await page.locator('#sheet:not(.hidden)').waitFor();
  await page.locator('.sheetRow').filter({ hasText: 'Codex' }).first().click();
  await page.locator('#chat:not(.hidden)').waitFor();
  await page.locator('#agentLabel').filter({ hasText: 'GPT-6 Astra · high' }).waitFor();

  await page.locator('#agentChip').click();
  await page.locator('.sheetRow').filter({ hasText: 'Current agent' }).click();
  await page.locator('#sheetInner h3').filter({ hasText: 'Codex model' }).waitFor();

  const astra = page.locator('.sheetRow.sel').filter({ hasText: 'GPT-6 Astra' });
  await astra.waitFor();
  if (await page.locator('.sheetRow').filter({ hasText: 'Maximum reasoning depth' }).count() !== 1) {
    throw new Error('Astra Max effort option was not rendered exactly once');
  }
  if (await page.locator('.sheetRow').filter({ hasText: 'Ultra' }).count() !== 0) {
    throw new Error('Astra must not render the unsupported Ultra effort');
  }

  mkdirSync(dirname(ARTIFACT), { recursive: true });
  await page.screenshot({ path: ARTIFACT, fullPage: true });
  console.log(JSON.stringify({
    ok: true,
    model: (await astra.innerText()).split('\n').find((line) => line.includes('GPT-6 Astra')),
    agentChip: await page.locator('#agentLabel').innerText(),
    contextTitle: await page.locator('#contextMeter').getAttribute('title'),
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
