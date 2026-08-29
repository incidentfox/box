#!/usr/bin/env node

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const SID = '019fdde3-0000-7000-8000-000000000001';
const TOKEN = 'autocontinue-toggle-e2e-token';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

let enabled = true;
let toggleRequests = 0;
const schedule = () => ({
  wakeups: [],
  autoContinue: {
    enabled,
    armed: enabled,
    state: enabled ? 'watching' : 'stopped',
    continuationCount: 0,
    reason: enabled ? '' : 'Turned off',
  },
});

const session = {
  id: SID, key: SID, title: 'Finish the whole task', agent: 'codex', cwd: ROOT,
  preview: 'Implement automatic task finishing.', state: 'idle', running: false,
  updatedAt: Date.now(), archived: false, favorite: false,
};
const history = {
  agent: 'codex', cwd: ROOT, hasMore: false, cursor: 0, liveCursor: 0,
  settings: {}, context: null,
  messages: [
    { role: 'user', parts: [{ t: 'text', text: 'Implement automatic task finishing.' }] },
    { role: 'assistant', parts: [{ t: 'text', text: 'The implementation is ready for verification.' }] },
  ],
};
const sync = {
  type: 'sync', sessionId: SID, agent: 'codex', cwd: ROOT, title: session.title,
  archived: false, favorite: false, running: false, curUser: '', curParts: [], curText: '', curTools: [], queue: [],
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://box-e2e');
  const send = (value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === `/api/sessions/${SID}/history`) return send(history);
  if (url.pathname === `/api/sessions/${SID}/schedule`) return send(schedule());
  if (url.pathname === `/api/sessions/${SID}/autocontinue` && req.method === 'PUT') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    return req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (body.toggle !== true) return send({ error: 'expected atomic toggle' }, 400);
      toggleRequests += 1;
      enabled = !enabled;
      return send({ ok: true, autoContinue: schedule().autoContinue });
    });
  }
  if (url.pathname === `/api/codex/threads/${SID}/goal`) return send({ goal: null });
  if (url.pathname === '/api/sessions') return send({ sessions: [session], counts: { all: 1 }, defaultCwd: ROOT, defaultAgent: 'codex' });
  if (url.pathname.startsWith('/api/')) return send({});
  const file = url.pathname === '/' || !extname(url.pathname) ? join(PUBLIC, 'index.html') : join(PUBLIC, url.pathname);
  if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  return res.end(readFileSync(file));
});

new WebSocketServer({ server, path: '/ws' }).on('connection', (ws) => {
  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'subscribe') ws.send(JSON.stringify(sync));
  });
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const PW_DIR = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
const { webkit } = createRequire(join(PW_DIR, 'package.json'))('@playwright/test');
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

try {
  await page.addInitScript((token) => localStorage.setItem('cc_token', token), TOKEN);
  await page.goto(`http://127.0.0.1:${port}/sessions/${SID}`, { waitUntil: 'networkidle' });
  const finisher = page.locator('.sessionMode.auto');
  await finisher.waitFor();
  if (!(await finisher.innerText()).includes('checks immediately after each response')) throw new Error('immediate-check copy is missing');

  await finisher.click();
  await page.waitForFunction(() => document.querySelector('.sessionMode.auto')?.innerText.includes('Tap to turn on'));
  if (await page.locator('#sheet').isVisible()) throw new Error('task finisher toggle opened a configuration sheet');

  await finisher.click();
  await page.waitForFunction(() => document.querySelector('.sessionMode.auto')?.innerText.includes('checks immediately after each response'));
  if (toggleRequests !== 2 || !enabled) throw new Error(`unexpected toggle state: requests=${toggleRequests} enabled=${enabled}`);

  if (process.env.BOX_E2E_SCREENSHOT) await page.screenshot({ path: process.env.BOX_E2E_SCREENSHOT, fullPage: true });
  console.log('PASS task finisher is a one-click, default-on toggle');
} finally {
  await browser.close();
  server.close();
}
