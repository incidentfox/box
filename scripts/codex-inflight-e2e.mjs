#!/usr/bin/env node
// Browser E2E for the "open a Codex session mid-turn" render path.
//
// Regression guarded: a Codex thread backed by a ROLLOUT file renders its IN-FLIGHT turn as
// ordinary history rows (no `live` flag), while the WS `sync` snapshot that follows is EMPTY
// (`curParts: []`) because the live tail only starts at the history cursor. onSync used to
// conclude the running turn's prompt wasn't on screen yet, so it appended the prompt a SECOND
// time below the answer it had already produced — reading, on a phone scrolled to the bottom,
// as "my message is there but the agent's replies are missing".
//
// This drives the REAL public/app.js in a REAL browser against a stub server that replays a
// captured-shape /history + `sync` pair, so it exercises the actual render/merge path.
//
// Usage:
//   node scripts/codex-inflight-e2e.mjs
//   APP_JS=/path/to/other/app.js node scripts/codex-inflight-e2e.mjs   # e.g. prove the old bug
//   FIXTURE_DIR=/path/with/history.json+sync.json node scripts/codex-inflight-e2e.mjs
//
// Needs Playwright (same location the voice E2E uses): PW_DIR=~/development/tools/playwright

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const APP_JS = process.env.APP_JS || join(PUBLIC, 'app.js');
const FIXTURE_DIR = process.env.FIXTURE_DIR || '';
const TOKEN = 'e2e-token';
const SID = '019f9bb4-b02c-7590-b040-000000000000';
const SHOT = process.env.SHOT || '/tmp/codex-inflight-e2e.png';

// ---- fixtures -----------------------------------------------------------------
// Synthetic by default: the real transcript that surfaced this bug is company content and
// must not live in git. Shape mirrors it exactly — a rollout-backed Codex history whose LAST
// message is the still-running assistant turn, with `live` absent on every row.
const PROMPT = "Well, you said that the four cases remain pending CRM inputs, but can't you just derive everything you need from those four call transcripts?";
const RUNNING_ANSWER = "You're right - the successful recordings are authoritative for any values actually spoken during the calls.";
const LATEST_LINE = 'Still waiting for the 5:00 AM Pacific payer opening window; no timer or service has failed.';
const OLD_PROMPT = 'Looking good. Now, what better way to test than actually calling?';
const PRIOR_ANSWER = "I'll schedule the first live wave for 5:00 AM Pacific.";

const base = (agent, tailAssistant) => ({
  agent, cwd: '/home/factory/development', hasMore: false, cursor: 0, liveCursor: 12146796,
  settings: {}, context: null, parentId: null, parentTitle: '',
  messages: [
    { role: 'user', ts: '2026-07-27T10:27:04.461Z', parts: [{ t: 'text', text: OLD_PROMPT }] },
    { role: 'assistant', ts: '2026-07-27T10:27:12.977Z', parts: [
      { t: 'text', text: PRIOR_ANSWER },
      { t: 'tool', id: 'c1', name: 'Bash', input: 'python3 schedule_wave.py', detail: {}, result: 'scheduled' },
    ] },
    { role: 'user', ts: '2026-07-27T10:35:48.399Z', parts: [{ t: 'text', text: PROMPT }] },
    ...(tailAssistant ? [tailAssistant] : []),
  ],
});
const sync_ = (h, over) => ({
  type: 'sync', sessionId: SID, agent: h.agent, cwd: h.cwd, archived: false, favorite: false,
  parentId: null, parentTitle: '', title: 'AI Voice Agent Development', settings: {}, context: null,
  running: true, activityAt: Date.parse('2026-07-27T10:35:43.192Z'), activityLabel: 'Starting',
  curUser: PROMPT, curUserImages: [], curText: '', curTools: [], curParts: [], queue: [], ...over,
});

// The turn that is STILL RUNNING, already durable in the rollout — no `live` flag on it.
const rolloutTail = {
  role: 'assistant', ts: '2026-07-27T10:35:57.228Z', parts: [
    { t: 'text', text: RUNNING_ANSWER },
    { t: 'tool', id: 'c2', name: 'Bash', input: 'rg -n "transcript" .', detail: {}, result: 'ok' },
    { t: 'tool', id: 'c3', name: 'Wait', input: 'Waiting for command output', detail: {}, result: 'ok' },
    { t: 'text', text: LATEST_LINE },
  ],
};

const SCENARIOS = {
  // THE BUG: rollout-backed Codex history holds the running turn; the snapshot is empty.
  'codex-inflight': () => {
    const h = base('codex', rolloutTail);
    return { history: h, sync: sync_(h), expect: {
      promptCopies: 1, contains: [RUNNING_ANSWER, LATEST_LINE, PRIOR_ANSWER], absent: [],
      answerBelowPrompt: true, noPromptBelowAnswer: true } };
  },
  // Claude mid-turn WITH a real snapshot: the stale durable partial must be replaced by it.
  'claude-snapshot-redraw': () => {
    const h = base('claude', { role: 'assistant', ts: '2026-07-27T10:35:57.228Z', parts: [{ t: 'text', text: 'PARTIAL-OLD stale half-written answer' }] });
    return { history: h, sync: sync_(h, { agent: 'claude', curParts: [{ t: 'text', text: 'SNAPSHOT-NEW full in-flight answer' }] }), expect: {
      promptCopies: 1, contains: ['SNAPSHOT-NEW', PRIOR_ANSWER], absent: ['PARTIAL-OLD'] } };
  },
  // Claude mid-turn with an EMPTY snapshot: keep the durable partial rather than blanking it.
  'claude-empty-snapshot': () => {
    const h = base('claude', { role: 'assistant', ts: '2026-07-27T10:35:57.228Z', parts: [{ t: 'text', text: 'PARTIAL-KEEP half-written answer' }] });
    return { history: h, sync: sync_(h, { agent: 'claude' }), expect: {
      promptCopies: 1, contains: ['PARTIAL-KEEP', PRIOR_ANSWER], absent: [] } };
  },
  // Sidecar-backed history (gemini/mac + codex-without-rollout) DOES flag its in-flight row
  // `live`; that row is the removable placeholder and must still be swapped for the snapshot.
  'gemini-live-row': () => {
    const h = base('gemini', { role: 'assistant', ts: '2026-07-27T10:35:57.228Z', live: true, parts: [{ t: 'text', text: 'LIVE-ROW-OLD placeholder' }] });
    return { history: h, sync: sync_(h, { agent: 'gemini', curParts: [{ t: 'text', text: 'SNAPSHOT-NEW full in-flight answer' }] }), expect: {
      promptCopies: 1, contains: ['SNAPSHOT-NEW', PRIOR_ANSWER], absent: ['LIVE-ROW-OLD'] } };
  },
  // Reconnect race: sync describes a NEWER turn than history has. The new prompt must be
  // appended and the previous completed answer left intact.
  'race-new-turn': () => {
    const h = base('codex', rolloutTail);
    return { history: h, sync: sync_(h, { curUser: 'A brand new question that history has not persisted yet', curParts: [{ t: 'text', text: 'SNAPSHOT-NEW answering the new question' }] }), expect: {
      promptCopies: 1, contains: [RUNNING_ANSWER, 'SNAPSHOT-NEW', 'A brand new question'], absent: [] } };
  },
};

const SCENARIO = process.env.SCENARIO || 'codex-inflight';
let history, sync, expected;
if (FIXTURE_DIR) {
  history = JSON.parse(readFileSync(join(FIXTURE_DIR, 'history.json'), 'utf8'));
  sync = JSON.parse(readFileSync(join(FIXTURE_DIR, 'sync.json'), 'utf8'));
  expected = { promptCopies: 1, contains: [], absent: [], answerBelowPrompt: true, noPromptBelowAnswer: true };
} else {
  if (!SCENARIOS[SCENARIO]) { console.error(`unknown SCENARIO "${SCENARIO}" — one of: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(2); }
  ({ history, sync, expect: expected } = SCENARIOS[SCENARIO]());
}
const CUR_USER = sync.curUser;
const SESSION_ID = sync.sessionId || SID;

// ---- stub server --------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const sessionCard = {
  id: SESSION_ID, key: SESSION_ID, title: sync.title || 'AI Voice Agent Development', agent: 'codex',
  cwd: history.cwd || '/home/factory/development', preview: LATEST_LINE, state: 'working',
  running: true, updatedAt: Date.now(), archived: false, favorite: false,
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === `/api/sessions/${SESSION_ID}/history`) return send(history);
  if (url.pathname === '/api/sessions') return send({ sessions: [sessionCard], counts: { all: 1 }, defaultCwd: sessionCard.cwd, defaultAgent: 'codex' });
  if (url.pathname.startsWith('/api/')) return send({});          // everything else the app probes
  // static: serve app.js from APP_JS so an old build can be tested against the same fixture
  let file = url.pathname === '/' || !extname(url.pathname) ? join(PUBLIC, 'index.html') : join(PUBLIC, url.pathname);
  if (url.pathname === '/app.js') file = APP_JS;
  if (!existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

new WebSocketServer({ server, path: '/ws' }).on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'subscribe') ws.send(JSON.stringify(sync));    // the empty-snapshot sync
  });
});

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const BASE = `http://127.0.0.1:${port}`;

// ---- drive a real browser -----------------------------------------------------
const PW_DIR = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
const { chromium } = createRequire(join(PW_DIR, 'package.json'))('@playwright/test');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 552, height: 1200 } });
await page.addInitScript((t) => localStorage.setItem('cc_token', t), TOKEN);
await page.goto(`${BASE}/sessions/${SESSION_ID}`, { waitUntil: 'networkidle' });
await page.waitForSelector('#messages .msg', { timeout: 15000 });
await page.waitForTimeout(1500);                                   // let sync land + render settle

const seen = await page.evaluate(({ prompt, contains, absent, answerMarker, latestMarker }) => {
  const kids = [...document.querySelectorAll('#messages > .msg')];
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const idxs = kids.map((el, i) => [el, i]).filter(([el]) => el.classList.contains('user') && norm(el.dataset.rawText) === norm(prompt)).map(([, i]) => i);
  const body = norm(document.querySelector('#messages').textContent);
  return {
    order: kids.map((el) => (el.classList.contains('user') ? 'user' : 'assistant')),
    userCopies: idxs.length,
    promptIdx: idxs.length ? idxs[0] : -1,
    lastPromptIdx: idxs.length ? idxs[idxs.length - 1] : -1,
    answerIdx: kids.findIndex((el) => el.classList.contains('assistant') && norm(el.textContent).includes(answerMarker)),
    latestIdx: kids.findIndex((el) => el.classList.contains('assistant') && norm(el.textContent).includes(latestMarker)),
    missing: contains.filter((t) => !body.includes(norm(t))),
    leaked: absent.filter((t) => body.includes(norm(t))),
    dupes: contains.filter((t) => body.split(norm(t)).length - 1 > 1),
  };
}, { prompt: CUR_USER, contains: expected.contains || [], absent: expected.absent || [], answerMarker: 'authoritative for any values', latestMarker: 'Still waiting for the 5:00 AM Pacific' });

await page.screenshot({ path: SHOT, fullPage: false });
await browser.close(); server.close();

// ---- assertions ---------------------------------------------------------------
const fails = [];
const wantCopies = expected.promptCopies == null ? 1 : expected.promptCopies;
if (seen.userCopies !== wantCopies) fails.push(`prompt rendered ${seen.userCopies}x (expected ${wantCopies} — a duplicate means onSync re-added it)`);
for (const t of seen.missing) fails.push(`missing from the transcript: "${t.slice(0, 60)}"`);
for (const t of seen.leaked) fails.push(`stale row NOT replaced: "${t.slice(0, 60)}"`);
for (const t of seen.dupes) fails.push(`rendered twice: "${t.slice(0, 60)}"`);
if (expected.answerBelowPrompt) {
  if (seen.answerIdx < 0) fails.push("the running turn's answer is not rendered at all");
  if (seen.latestIdx < 0) fails.push("the running turn's LATEST line is not rendered");
  if (seen.answerIdx >= 0 && seen.answerIdx < seen.promptIdx) fails.push('the running answer renders ABOVE its own prompt');
}
if (expected.noPromptBelowAnswer && seen.lastPromptIdx > seen.answerIdx) fails.push('a prompt bubble renders BELOW the running answer (the duplicate)');

console.log(`scenario: ${FIXTURE_DIR ? 'real-fixture' : SCENARIO}   app.js: ${APP_JS}`);
console.log(`rendered order: ${seen.order.join(' → ')}`);
console.log(`prompt copies=${seen.userCopies} promptIdx=${seen.promptIdx} answerIdx=${seen.answerIdx} latestIdx=${seen.latestIdx}`);
console.log(`screenshot: ${SHOT}`);
if (fails.length) { console.error('\nFAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('\nPASS');
