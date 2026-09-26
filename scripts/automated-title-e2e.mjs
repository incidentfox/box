import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { webkit } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const token = 'automated-title-e2e-token';
const scheduledPrompt = 'You are running an automated daily task. Task: Reconcile overnight claim failures and flag action items.';
const expectedTitle = 'Reconcile Overnight Claim Failures Flag';
const home = await mkdtemp(join(tmpdir(), 'box-automated-title-'));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url, deadline = Date.now() + 15_000) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    PATH: '/usr/bin:/bin',
    HOME: home,
    USER: 'box-e2e',
    LOGNAME: 'box-e2e',
    LANG: 'C.UTF-8',
    PORT: String(port),
    CC_AUTH_TOKEN: token,
    CC_WORKSPACE: ROOT,
    BOX_IGNORE_LOCAL_ENV: '1',
    BOX_SKIP_META_PROBE: '1',
    BOX_HOST_SECRETS_FILE: join(home, 'missing-secrets.env'),
    CODEX_ENV_FILE: join(home, 'missing-codex.env'),
    LINEAR_LOCAL: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
try {
  await waitFor(`${origin}/health`);
  const response = await fetch(`${origin}/api/agent/enqueue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: scheduledPrompt, agent: 'codex', cwd: ROOT }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  assert.equal(result.title, expectedTitle);

  browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript((storedToken) => localStorage.setItem('cc_token', storedToken), token);
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#sessions').waitFor();
  await page.getByText(expectedTitle, { exact: true }).waitFor();

  const screenshot = join(tmpdir(), 'box-automated-title-e2e.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ ok: true, screenshot, title: expectedTitle }));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3_000).unref();
  });
  await rm(home, { recursive: true, force: true });
}
