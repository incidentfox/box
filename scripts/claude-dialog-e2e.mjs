#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'dialog-browser-smoke-token';
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

const tempHome = mkdtempSync(join(tmpdir(), 'box-dialog-e2e-'));
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    HOME: tempHome, BOX_TEAM: '0', BOX_HOST_SECRETS_FILE: '/dev/null',
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
  await page.locator('.sheetRow').filter({ hasText: 'Claude' }).first().click();
  await page.locator('#chat:not(.hidden)').waitFor();
  const prompt = {
    kind: 'dialog', title: 'Teach auto mode about your environment?',
    body: 'Claude customizes auto mode for this environment.\n\n  How you use Claude here     Mixed\n❯ Also scan shell history     true\n  Also scan your other repos  false\n\n  Continue',
    actions: ['up', 'down', 'left', 'right', 'enter', 'escape'],
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate((prompt) => {
    window.dialogSent = [];
    ws = { send: (data) => window.dialogSent.push(JSON.parse(data)) };
    renderWaiting({ prompt, answerable: true });
  }, prompt);
  await page.locator('.waitDialog').filter({hasText:'Also scan shell history'}).waitFor();
  const card = await page.locator('.waitingCard').boundingBox();
  if (!card || card.x < 0 || card.x + card.width > 390) throw new Error('Panel exceeds phone viewport');
  await page.screenshot({ path: '/tmp/box-visible-dialog-mobile.png', fullPage: true });
  await page.getByRole('button', {name: 'Change →', exact:true}).click();
  const sent = await page.evaluate(() => window.dialogSent);
  if (sent.at(-1)?.sel?.key !== 'right') throw new Error('Wrong navigation payload');
  await page.evaluate((prompt) => renderWaiting({prompt, answerable:true}), prompt);
  await page.getByRole('button', {name: 'Esc / Cancel', exact:true}).click();
  if (await page.evaluate(() => window.dialogSent.at(-1)?.sel?.key) !== 'escape') throw new Error('Wrong cancel payload');
  await page.evaluate((prompt) => renderWaiting({prompt, answerable:false}), prompt);
  if (await page.locator('.waitControls button:disabled').count() !== 6) throw new Error('External dialog must be read only');
  console.log('Phone dialog content, layout, navigation, cancellation and external ownership verified.');
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
