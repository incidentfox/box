#!/usr/bin/env node
// Browser E2E for GPT-Live voice (VOICE_ASSISTANT_MODE=live): real Chromium, a FAKE MIC that
// speaks a Deepgram-TTS question into a real gpt-live-1 WebRTC session.
//   LV_SCENARIO=global  Voice screen → Responses delegation → box tool via /api/voice/tool
//                       (run the server with VOICE_TOOLS_DRYRUN=1) → spoken answer.
//   LV_SCENARIO=thread  a chat thread → full-screen voice → Responses delegation: one direct
//                       read-only box tool (calendar/email question) + one ask_thread_agent
//                       hand-off, sent INTO the thread (enqueueText is intercepted so no agent
//                       launches); a synthetic agent reply is fed back and must be spoken.
//                       Screenshots the full-screen view expanded and minimized.
// Safe against prod: every /api/voice/tool call is routed through a guard that only lets
// read-only tools reach the server; anything that would write gets a fake dry-run result.
// Usage: VO_BASE=http://127.0.0.1:17321 VO_TOKEN=… LV_SCENARIO=thread node scripts/live-voice-e2e-browser.mjs
// Costs a few cents (gpt-live-1 is $0.05/min plus backend tokens). Needs DEEPGRAM_API_KEY or VO_WAV.

import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = process.env.VO_BASE || 'http://127.0.0.1:7461';
const TOKEN = process.env.VO_TOKEN || 'votest';
const PW_DIR = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
const SCENARIO = process.env.LV_SCENARIO === 'global' ? 'global' : 'thread';
const WAV = process.env.VO_WAV || `/tmp/lv-question-${SCENARIO}.wav`;
const SHOT = process.env.VO_SHOT || `/tmp/lv-e2e-${SCENARIO}.png`;
const shotAs = (tag) => SHOT.replace(/\.png$/, `-${tag}.png`);
// Thread: a quick lookup first (direct tool), then real work for the thread's agent.
const QUESTIONS = process.env.VO_QUESTION ? [process.env.VO_QUESTION] : SCENARIO === 'global'
  ? ['Hey, quick check. What agent sessions are active on the box right now?']
  : ["Quick one first. What's on my calendar tomorrow?", 'Thanks. Now have the agent in this chat run the unit tests for the voice module, and tell me if they pass.'];
const GAP_S = Number(process.env.VO_GAP_S || 16); // silence between questions (room for the answer)
const READ_ONLY_TOOLS = new Set(['calendar', 'gmail_search', 'gmail_read', 'list_sessions', 'check_session', 'get_overview',
  'linear_board', 'linear_issue', 'needs_jimmy', 'brain_search', 'brain_read', 'get_briefing', 'read_notes', 'check_tasks',
  'read_session_output', 'read_session_history', 'slack_recent', 'slack_search']);

const require_ = createRequire(join(PW_DIR, 'package.json'));
const { chromium } = require_('@playwright/test');

// ---- 1. build the fake-mic clip: 5s silence + question (+ gap + question…) + 4s silence ----
async function tts(key, text) {
  const r = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=24000', {
    method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error('deepgram tts failed: ' + r.status);
  const raw = Buffer.from(await r.arrayBuffer());
  // strip WAV container if present (find the data chunk), else treat as raw PCM
  if (raw.slice(0, 4).toString() === 'RIFF') {
    let off = 12;
    while (off < raw.length - 8) {
      const id = raw.slice(off, off + 4).toString();
      const sz = raw.readUInt32LE(off + 4);
      if (id === 'data') return raw.slice(off + 8, off + 8 + sz);
      off += 8 + sz + (sz % 2);
    }
  }
  return raw;
}
async function buildWav() {
  if (process.env.VO_WAV && existsSync(WAV)) return;
  const key = process.env.DEEPGRAM_API_KEY || (() => {
    try { return (readFileSync('/run/software-factory/secrets.env', 'utf8').match(/^DEEPGRAM_API_KEY=(.+)$/m) || [])[1]; } catch { return ''; }
  })();
  if (!key) throw new Error('no DEEPGRAM_API_KEY and no VO_WAV provided');
  const rate = 24000, sil = (s) => Buffer.alloc(rate * 2 * s);
  const parts = [sil(5)];
  for (const [i, q] of QUESTIONS.entries()) { if (i) parts.push(sil(GAP_S)); parts.push(await tts(key, q)); }
  parts.push(sil(4));
  const data = Buffer.concat(parts);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  writeFileSync(WAV, Buffer.concat([hdr, data]));
  console.log(`built ${WAV} (${((44 + data.length) / 1024).toFixed(0)} KB, ~${(data.length / rate / 2).toFixed(1)}s)`);
}

// ---- 2. drive the app ------------------------------------------------------------
await buildWav();
const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
page.on('console', (m) => { if (m.type() === 'error' || /thread-voice/.test(m.text())) console.log('  [console]', m.text().slice(0, 200)); });
await page.addInitScript((tok) => localStorage.setItem('cc_token', tok), TOKEN);
await page.context().grantPermissions(['microphone'], { origin: BASE });
// Tool guard: read-only tools reach the box; anything else gets a fake dry-run result.
const toolCalls = [];
await page.route('**/api/voice/tool', async (route) => {
  let body = {};
  try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
  const name = String(body.name || '');
  const allowed = READ_ONLY_TOOLS.has(name);
  toolCalls.push(`${name}${allowed ? '' : ' (blocked)'}`);
  if (allowed) return route.continue();
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ call_id: body.call_id, output: JSON.stringify({ ok: true, dry_run: true, note: 'e2e: not executed' }) }) });
});
let failed = 0;
const step = (name, okd, extra = '') => { console.log(`  ${okd ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!okd) failed++; };
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#voiceBtn:not(.hidden)', { timeout: 20000 }).catch(() => {});

if (SCENARIO === 'global') {
  await page.evaluate(() => openVoice());
  await page.waitForSelector('#voMain', { timeout: 5000 });
  await page.click('#voMain');
  const live = await page.waitForFunction(() => document.getElementById('voStatus')?.textContent === 'live', { timeout: 30000 }).then(() => true).catch(() => false);
  step('GPT-Live connected', live);
  const notice = await page.$$eval('.voBub.notice', (els) => els.map((e) => e.textContent).join(' | ')).catch(() => '');
  step('session is gpt-live-1', /gpt-live-1/.test(notice), notice.slice(0, 120));
  const gotUser = await page.waitForSelector('.voBub.user', { timeout: 45000 }).then(() => true).catch(() => false);
  step('user speech transcribed', gotUser, gotUser ? (await page.$eval('.voBub.user', (e) => e.textContent)).slice(0, 90) : '');
  const chip = await page.waitForSelector('.voToolChip.ok, .voToolChip.fail', { timeout: 60000 }).then(() => true).catch(() => false);
  const chips = await page.$$eval('.voToolChip', (els) => els.map((e) => e.className + ':' + e.textContent.trim()));
  step('backend ran a box tool', chip, chips.join(' | '));
  let asst = '', stable = 0; const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const all = await page.$$eval('.voBub.asst', (els) => els.map((e) => e.textContent.trim()).join(' ¶ ')).catch(() => '');
    if (all !== asst) { asst = all; stable = Date.now(); } else if (chip && asst.length > 40 && Date.now() - stable > 4000) break;
    await page.waitForTimeout(400);
  }
  step('assistant spoke an answer', asst.length > 20, `"${asst.slice(-260)}"`);
} else {
  await page.evaluate(() => openChat({ id: null, title: 'Voice module tests', agent: 'claude' }));
  await page.waitForSelector('#threadVoiceBtn:not(.hidden)', { timeout: 10000 });
  step('thread voice button visible in the chat composer', true);
  // Intercept the hand-off so no real agent launches (and no real thread gets a message).
  await page.evaluate(() => { window.__sent = []; window.enqueueText = (text, opts) => { window.__sent.push({ text, opts }); }; });
  await page.click('#threadVoiceBtn');
  const full = await page.waitForSelector('#tvFull:not(.hidden)', { timeout: 5000 }).then(() => true).catch(() => false);
  step('full-screen voice view opened', full, await page.$eval('#tvTitle', (e) => e.textContent).catch(() => '?'));
  const live = await page.waitForFunction(() => { const s = document.getElementById('tvFullStatus'); return s && /Listening|Sent|working/i.test(s.textContent); }, { timeout: 30000 }).then(() => true).catch(() => false);
  step('GPT-Live connected in the thread', live, await page.$eval('#tvFullStatus', (e) => e.textContent).catch(() => '?'));
  // 1) the quick lookup runs as a direct box tool (chip in the full view), not via the thread
  const direct = await page.waitForFunction(() => [...document.querySelectorAll('#tvFeed .voToolChip.ok')].some((c) => /calendar|email/i.test(c.textContent)), { timeout: 60000 }).then(() => true).catch(() => false);
  const chipsNow = await page.$$eval('#tvFeed .voToolChip', (els) => els.map((e) => e.className.replace('voToolChip', '').trim() + ':' + e.textContent.trim()));
  step('direct read-only tool ran (calendar/email)', direct, chipsNow.join(' | '));
  // 2) the work request goes to the thread's agent via ask_thread_agent
  const sent = await page.waitForFunction(() => window.__sent.some((s) => /unit tests|tests/i.test(s.text)), { timeout: 75000 }).then(() => true).catch(() => false);
  const handoff = sent ? await page.evaluate(() => window.__sent.find((s) => /unit tests|tests/i.test(s.text))) : null;
  console.log('  transcript so far:\n    ' + (await page.evaluate(() => ThreadVoice.transcript())).split('\n').join('\n    '));
  step('ask_thread_agent sent the request into the thread', sent, handoff ? handoff.opts.displayText : '');
  step('the calendar lookup did not go into the thread', !(await page.evaluate(() => window.__sent.some((s) => /calendar/i.test(s.text)))));
  if (sent) {
    // The thread's agent "runs" and replies; ThreadVoice must voice it. Only speech that starts
    // AFTER the synthetic reply lands counts (not the "on it" acknowledgement).
    await page.evaluate((display) => {
      const ev = (o) => onServer({ key: cur.key, ...o });
      ev({ type: 'turn_start', text: display });
      ev({ type: 'text', delta: 'Running the voice tests now.' });
      ev({ type: 'tool', name: 'Bash', input: 'npm test' });
      setTimeout(() => {
        window.__asst = () => ThreadVoice.transcript().split('\n').filter((l) => l.startsWith('assistant:')).map((l) => l.slice(10)).join(' ¶ ');
        window.__doneAt = window.__asst().length; // a reply can continue the ack's caption segment
        ev({ type: 'text', delta: 'All forty-two voice tests pass, and the live-voice suite is green.' }); ev({ type: 'done' });
      }, 2500);
    }, handoff.opts.displayText);
    let said = ''; const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      said = await page.evaluate(() => (window.__doneAt == null ? '' : window.__asst().slice(window.__doneAt)));
      if (/forty|42|green|pass/i.test(said)) break;
      await page.waitForTimeout(400);
    }
    step('agent reply was spoken back', /forty|42|green|pass/i.test(said), `"${said.slice(0, 200)}"`);
    console.log('  final transcript:\n    ' + (await page.evaluate(() => ThreadVoice.transcript())).split('\n').join('\n    '));
  }
  // 3) full-screen view: expanded → minimize to the bar → tap the bar to re-expand
  await page.screenshot({ path: shotAs('expanded'), fullPage: false });
  console.log(`  screenshot → ${shotAs('expanded')}`);
  await page.click('#tvMin');
  const mini = await page.waitForFunction(() => document.getElementById('tvFull').classList.contains('hidden') && !document.getElementById('tvBar').classList.contains('hidden'), { timeout: 3000 }).then(() => true).catch(() => false);
  step('minimize shows the bar over the chat', mini && await page.evaluate(() => ThreadVoice.active));
  await page.screenshot({ path: shotAs('minimized'), fullPage: false });
  console.log(`  screenshot → ${shotAs('minimized')}`);
  await page.click('#tvExpand');
  const again = await page.waitForSelector('#tvFull:not(.hidden)', { timeout: 3000 }).then(() => true).catch(() => false);
  step('tapping the bar re-expands', again);
}
console.log(`  tool calls: ${toolCalls.join(', ') || 'none'}`);
await page.screenshot({ path: SHOT, fullPage: false });
console.log(`  screenshot → ${SHOT}`);
await page.evaluate(() => { document.getElementById('voEnd')?.click(); document.getElementById('tvEnd')?.click(); });
await page.waitForTimeout(1500);
await browser.close();
console.log(failed ? `\nE2E FAILED (${failed})\n` : '\nE2E PASSED\n');
process.exit(failed ? 1 : 0);
