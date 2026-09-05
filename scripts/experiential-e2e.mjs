#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'experiential-browser-smoke-token';
const ARTIFACT = process.env.BOX_EXPERIENTIAL_SCREENSHOT
  || join(tmpdir(), 'box-experiential-desktop.png');

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

const tempHome = mkdtempSync(join(tmpdir(), 'box-experiential-e2e-'));
const bin = join(tempHome, 'bin');
mkdirSync(bin);
mkdirSync(join(tempHome, '.cc-mobile'));
writeFileSync(join(tempHome, '.cc-mobile', 'session-schedules.json'), JSON.stringify({ version: 1, sessions: {
  '019f2000-0000-7000-8000-000000000001': { agent: 'experiential', wakeups: [], autoContinue: { enabled: false } },
} }));
const calls = join(tempHome, 'calls.jsonl');
writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const id = '019f2000-0000-7000-8000-000000000001';
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args,pid:process.pid,credential:process.env.EXPLABS_API_KEY === 'synthetic-test-key'})+'\\n');
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
emit({type:'thread.started',thread_id:id});
if(args.includes('simulate quota')) {
  emit({type:'error',message:'free_tier_requires_payment: Add a card and a $1 payment on the Credits page.'});
  process.exitCode=1;
} else if(args.includes('wait for stop')) {
  emit({type:'item.started',item:{type:'command_execution',id:'waiting',command:'synthetic waiting tool'}});
  setInterval(()=>{},1000);
} else {
  emit({type:'item.started',item:{type:'command_execution',id:'tool1',command:'synthetic project check'}});
  emit({type:'item.completed',item:{type:'command_execution',id:'tool1',command:'synthetic project check',aggregated_output:'Synthetic check passed',exit_code:0}});
  emit({type:'item.completed',item:{type:'agent_message',text:args.includes('resume')?'Resumed the same Experiential conversation.':'Experiential is ready. Synthetic project check passed.'}});
  emit({type:'turn.completed',usage:{input_tokens:420,output_tokens:42}});
  if(args.includes('keep goal alive')) setInterval(()=>{},1000);
}
`, { mode: 0o700 });
const envFile = join(tempHome, 'codex.env');
writeFileSync(envFile, `export PATH='${bin}:/usr/bin:/bin'\nexport HOME='${tempHome}'\nexport CODEX_HOME='${tempHome}/.codex'\n`);
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    PATH: `${bin}:/usr/bin:/bin`,
    CODEX_ENV_FILE: envFile,
    EXPLABS_API_KEY: 'synthetic-test-key',
    CODEX_HOME: join(tempHome, '.codex'),
    HOME: tempHome,
    PORT: String(port),
    CC_AUTH_TOKEN: TOKEN,
    CC_WORKSPACE: tempHome,
    BOX_IGNORE_LOCAL_ENV: '1',
    BOX_SKIP_META_PROBE: '1',
    LINEAR_LOCAL: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.resume();
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
let browser;
let page;
try {
  await waitForServer(baseUrl, child);
  const { webkit } = await loadPlaywright();
  browser = await webkit.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#tokenInput').fill(TOKEN);
  await page.locator('#loginBtn').click();
  await page.locator('#sessions:not(.hidden)').waitFor();

  await page.locator('#newBtn').click();
  await page.locator('#sheet:not(.hidden)').waitFor();
  await page.locator('.sheetRow').filter({ hasText: 'Experiential' }).first().click();
  await page.locator('#chat:not(.hidden)').waitFor();
  await page.locator('#agentLabel').filter({ hasText: 'GPT-6 Astra · high' }).waitFor();

  await page.locator('#agentChip').click();
  await page.locator('.sheetRow').filter({ hasText: 'Current agent' }).click();
  await page.locator('#sheetInner h3').filter({ hasText: 'Experiential model' }).waitFor();

  const astra = page.locator('.sheetRow.sel').filter({ hasText: 'GPT-6 Astra' });
  await astra.waitFor();
  if (await page.locator('.sheetRow').filter({ hasText: 'Maximum reasoning depth' }).count() !== 1) {
    throw new Error('Astra Max effort option was not rendered exactly once');
  }
  if (await page.locator('.sheetRow').filter({ hasText: 'Ultra' }).count() !== 0) {
    throw new Error('Astra must not render the unsupported Ultra effort');
  }

  await page.keyboard.press('Escape');
  async function send(text) {
    await page.locator('#input').fill(text);
    await page.locator('#sendBtn').click();
  }
  const messages = page.locator('#messages');
  await send('keep goal alive');
  await messages.getByText('Experiential is ready. Synthetic project check passed.', { exact: true }).waitFor();
  await page.locator('#sendBtn[data-act="send"]').waitFor();
  const firstCall = JSON.parse(readFileSync(calls, 'utf8').trim().split('\n')[0]);
  assert.equal(firstCall.credential, true);
  process.kill(firstCall.pid, 0); // completed turn still has a supervised goal process
  await send('continue this conversation');
  await messages.getByText('Resumed the same Experiential conversation.', { exact: true }).waitFor();
  await page.locator('#sendBtn[data-act="send"]').waitFor();
  assert.throws(() => process.kill(firstCall.pid, 0));
  const invocations = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 2);
  assert.ok(invocations[1].args.includes('resume'));
  assert.ok(invocations[1].args.includes('019f2000-0000-7000-8000-000000000001'));
  assert.ok(invocations.every(call => call.credential && call.args.includes('model_provider="explabs"')));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#chat:not(.hidden)').waitFor();
  await messages.getByText('Resumed the same Experiential conversation.', { exact: true }).waitFor();
  await page.locator('#agentLabel').filter({ hasText: 'GPT-6 Astra · high' }).waitFor();
  assert.equal(await messages.getByText('keep goal alive', { exact: true }).count(), 1);
  const records = JSON.parse(readFileSync(join(tempHome, '.cc-mobile', 'experiential-sessions.json'), 'utf8'));
  const record = records.sessions['019f2000-0000-7000-8000-000000000001'];
  assert.equal(record.agent, 'experiential');
  assert.equal(record.messages.filter(row => row.role === 'assistant').length, 2);
  assert.ok(record.messages.some(row => row.parts?.some(part => part.t === 'tool' && part.result === 'Synthetic check passed')));
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  await page.screenshot({ path: ARTIFACT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ARTIFACT.replace('desktop', 'mobile'), fullPage: true });
  await send('wait for stop');
  await page.locator('#sendBtn[data-act="stop"]').waitFor();
  await messages.getByText('synthetic waiting tool', { exact: false }).first().waitFor();
  const waiting = JSON.parse(readFileSync(calls, 'utf8').trim().split('\n').at(-1));
  await page.locator('#sendBtn[data-act="stop"]').click();
  await page.locator('#sendBtn[data-act="send"]').waitFor();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.throws(() => process.kill(waiting.pid, 0));
  await send('simulate quota');
  await page.locator('#sendBtn[data-act="send"]').waitFor();
  await page.waitForFunction(() => document.body.textContent.includes('free_tier_requires_payment'));
  await page.reload({ waitUntil: 'networkidle' });
  await messages.getByText(/Experiential error:.*free_tier_requires_payment/).waitFor();
  console.log(JSON.stringify({ ok: true, checks: ['picker', 'model', 'tool streaming', 'goal supervision', 'resume', 'durable history', 'stop', 'durable quota error'], screenshot: ARTIFACT }, null, 2));
} catch (error) {
  console.error(diagnostics);
  console.error(await page?.locator('#messages').innerText().catch(() => ''));
  console.error('Browser URL:', page?.url());
  throw error;
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
