#!/usr/bin/env node
// Real-browser regression for reading older chat messages while the latest reply streams.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const SID = '019fdde3-0000-7000-8000-000000000000';
const TOKEN = 'chat-scroll-e2e-token';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const messages = [];
for (let i = 0; i < 34; i += 1) {
  messages.push({ role: 'user', parts: [{ t: 'text', text: `Question ${i + 1}: ${'background '.repeat((i % 3) + 1)}` }] });
  messages.push({ role: 'assistant', parts: [{ t: 'text', text: `Answer ${i + 1}\n\n${'A deliberately varied-height response line. '.repeat((i % 7) + 1)}` }] });
}
const currentPrompt = 'Keep working while I read the older messages.';
messages.push({ role: 'user', parts: [{ t: 'text', text: currentPrompt }] });

const history = {
  agent: 'codex', cwd: ROOT, hasMore: false, cursor: 0, liveCursor: 0,
  settings: {}, context: null, messages,
};
const sync = {
  type: 'sync', sessionId: SID, agent: 'codex', cwd: ROOT, title: 'Scroll stability test',
  archived: false, favorite: false, running: true, curUser: currentPrompt,
  curParts: [{ t: 'text', text: 'Working on the newest answer.' }], curText: '', curTools: [], queue: [],
};

const sessionCard = {
  id: SID, key: SID, title: sync.title, agent: 'codex', cwd: ROOT,
  preview: currentPrompt, state: 'working', running: true, updatedAt: Date.now(),
  archived: false, favorite: false,
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://box-e2e');
  const send = (value) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === `/api/sessions/${SID}/history`) return send(history);
  if (url.pathname === '/api/sessions') return send({ sessions: [sessionCard], counts: { all: 1 }, defaultCwd: ROOT, defaultAgent: 'codex' });
  if (url.pathname.startsWith('/api/')) return send({});
  const file = url.pathname === '/' || !extname(url.pathname)
    ? join(PUBLIC, 'index.html')
    : join(PUBLIC, url.pathname);
  if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

let client;
new WebSocketServer({ server, path: '/ws' }).on('connection', (ws) => {
  client = ws;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'subscribe') ws.send(JSON.stringify(sync));
  });
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const PW_DIR = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
const { chromium } = createRequire(join(PW_DIR, 'package.json'))('@playwright/test');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await page.addInitScript((token) => localStorage.setItem('cc_token', token), TOKEN);
await page.goto(`http://127.0.0.1:${port}/sessions/${SID}`, { waitUntil: 'networkidle' });
await page.waitForSelector('#messages > .msg');
await page.waitForTimeout(600);

const before = await page.evaluate(() => {
  const scroller = document.querySelector('#messages');
  scroller.scrollTop = Math.round(scroller.scrollHeight * 0.42);
  const rows = [...scroller.querySelectorAll(':scope > .msg')];
  const row = rows.find((el) => el.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top + 1);
  return {
    top: scroller.scrollTop,
    anchor: row && row.dataset.rawText,
    anchorTop: row && row.getBoundingClientRect().top,
    contentVisibility: row && getComputedStyle(row).contentVisibility,
  };
});

for (let i = 0; i < 24; i += 1) {
  client.send(JSON.stringify({ type: 'text', delta: ` Streaming update ${i + 1}.` }));
  await new Promise((resolve) => setTimeout(resolve, 20));
}
await page.waitForTimeout(250);

const after = await page.evaluate((anchor) => {
  const scroller = document.querySelector('#messages');
  const row = [...scroller.querySelectorAll(':scope > .msg')].find((el) => el.dataset.rawText === anchor);
  return { top: scroller.scrollTop, anchorTop: row && row.getBoundingClientRect().top };
}, before.anchor);

await browser.close();
server.close();

const topDrift = Math.abs(after.top - before.top);
const anchorDrift = Math.abs(after.anchorTop - before.anchorTop);
if (!before.anchor || before.contentVisibility !== 'visible' || topDrift > 1 || anchorDrift > 1) {
  console.error({ before, after, topDrift, anchorDrift });
  process.exit(1);
}
console.log(`PASS mobile streaming scroll: scrollTop drift=${topDrift}px anchor drift=${anchorDrift}px`);
