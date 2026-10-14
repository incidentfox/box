#!/usr/bin/env node
import { settingsFromDialog } from '../server/dialog-settings.mjs';
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
  await page.getByRole('button', {name: '↓ Down', exact:true}).click();
  await page.getByRole('button', {name: 'Enter / Select', exact:true}).click();
  const sequence = await page.evaluate(() => window.dialogSent.map((message) => message.sel.key));
  if (sequence.join(',') !== 'right,down,enter') throw new Error('Dialog must support consecutive navigation and Enter');
  // Enter on a setting can leave the panel open. No server repaint should be
  // needed to recover the controls, including a second Enter or navigation.
  await page.getByRole('button', {name: 'Enter / Select', exact:true}).click();
  await page.getByRole('button', {name: '↓ Down', exact:true}).click();
  if (await page.evaluate(() => window.dialogSent.map(m => m.sel.key).join(',')) !== 'right,down,enter,enter,down') throw new Error('Enter stranded the dialog controls');
  await page.evaluate((prompt) => renderWaiting({prompt: {...prompt, body: prompt.body.replace('❯ Also scan shell history     true', '  Also scan shell history     false').replace('  Continue', '❯ Continue')}, answerable:true}), prompt);
  await page.locator('.waitDialog').filter({hasText:'❯ Continue'}).waitFor();
  await page.getByRole('button', {name: 'Enter / Select', exact:true}).click();
  await page.evaluate(() => clearWaitingCard());
  if (await page.locator('.waitingCard').count()) throw new Error('Confirmed completion must remove the panel');
  await page.evaluate((prompt) => renderWaiting({prompt, answerable:true}), prompt);
  await page.getByRole('button', {name: 'Esc / Cancel', exact:true}).click();
  if (await page.evaluate(() => window.dialogSent.at(-1)?.sel?.key) !== 'escape') throw new Error('Wrong cancel payload');
  await page.evaluate((prompt) => renderWaiting({prompt, answerable:false}), prompt);
  if (await page.locator('.waitControls button:disabled').count() !== 6) throw new Error('External dialog must be read only');
  await page.setViewportSize({width:1280, height:900});
  await page.evaluate((prompt) => renderWaiting({prompt, answerable:true}), prompt);
  await page.getByRole('button', {name: 'Enter / Select', exact:true}).click();
  await page.getByRole('button', {name: '↑ Up', exact:true}).click();
  const form = {...prompt, settings:settingsFromDialog(prompt)};
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(prompt => {window.dialogSent = []; renderWaiting({prompt,answerable:true});},form);
  const shell = page.getByRole('switch',{name:'Also scan shell history',exact:true});
  if(await shell.getAttribute('aria-checked') !== 'true') throw new Error('Wrong initial switch value');
  await shell.click();
  if(await page.locator('.waitOpt:disabled').count() !== 5) throw new Error('Pending form must lock duplicate submissions');
  if(await shell.getAttribute('aria-checked') !== 'true') throw new Error('Switch changed before terminal confirmation');
  const action = await page.evaluate(() => window.dialogSent.at(-1).sel.dialog);
  if(action.action !== 'change' || action.row !== 'shellHistory' || action.revision !== form.settings.revision) throw new Error('Wrong setting intent');
  const changed = {...prompt,body:prompt.body.replace('true','false')};
  changed.settings = settingsFromDialog(changed);
  await page.evaluate(prompt => renderWaiting({prompt,answerable:true}),changed);
  if(await shell.getAttribute('aria-checked') !== 'false' || await shell.isDisabled()) throw new Error('Confirmed value must refresh and unlock');
  await page.getByRole('button',{name:'How you use Claude here: Mixed. Tap to change',exact:true}).click();
  if(await page.evaluate(() => window.dialogSent.at(-1).sel.dialog.row) !== 'usage') throw new Error('Wrong usage target');
  await page.evaluate(prompt => renderWaiting({prompt,answerable:true}),form);
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  if(await page.evaluate(() => window.dialogSent.at(-1).sel.dialog.action) !== 'continue') throw new Error('Wrong Continue intent');
  if(!await page.locator('.waitingCard').count()) throw new Error('Continue must wait for terminal confirmation');
  await page.evaluate(() => clearWaitingCard());
  await page.evaluate(prompt => renderWaiting({prompt,answerable:true}),form);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  if(await page.evaluate(() => window.dialogSent.at(-1).sel.dialog.action) !== 'cancel') throw new Error('Wrong Cancel intent');
  await page.evaluate(prompt => renderWaiting({prompt,answerable:false}),form);
  if(await page.locator('.waitOpt:disabled').count() !== 5) throw new Error('External settings must be read only');
  await page.evaluate(prompt => {ws = {readyState:3,send:()=>{throw new Error('closed');}};renderWaiting({prompt,answerable:true});},form);
  await shell.click();
  if(await shell.isDisabled()) throw new Error('Disconnected form must recover');
  await page.getByRole('status').filter({hasText:'Connection lost'}).waitFor();
  await page.evaluate(prompt => {ws = {send:data=>window.dialogSent.push(JSON.parse(data))};renderWaiting({prompt,answerable:true});},form);
  for(const width of [320,390,1280]) {
    await page.setViewportSize({width,height:900});
    const overflow = await page.locator('.waitingCard').evaluate(card => card.scrollWidth > card.clientWidth + 2);
    if(overflow) throw new Error('Settings overflow viewport at ' + width);
  }
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/box-tappable-settings-mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  await shell.focus(); await page.keyboard.press('Space');
  if(await page.evaluate(() => window.dialogSent.at(-1).sel.dialog.row) !== 'shellHistory') throw new Error('Keyboard switch failed');
  console.log('Tappable settings: confirmed toggle, usage cycle, Continue, Cancel, pending lock, stale recovery, read-only ownership, disconnect recovery, keyboard and 320/390/1280px layouts verified.');
  console.log('Phone and desktop dialog navigation after Enter, repaint, confirmed closure, cancellation and external ownership verified.');
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
