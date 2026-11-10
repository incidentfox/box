#!/usr/bin/env node
// Browser E2E for GPT-Live voice (VOICE_ASSISTANT_MODE=live): real Chromium, a FAKE MIC that
// speaks a Deepgram-TTS question into a real gpt-live-1 WebRTC session.
//   LV_SCENARIO=global  Voice screen → Responses delegation → box tool via /api/voice/tool
//                       (run the server with VOICE_TOOLS_DRYRUN=1) → spoken answer.
//   LV_SCENARIO=thread  a chat thread → voice mode → client delegation → the request is sent
//                       INTO the thread (enqueueText is intercepted so no agent launches);
//                       a synthetic agent reply is fed back and must be spoken.
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
const QUESTION = process.env.VO_QUESTION || (SCENARIO === 'global'
  ? 'Hey, quick check. What agent sessions are active on the box right now?'
  : 'Please run the unit tests for the voice module and tell me if they pass.');

const require_ = createRequire(join(PW_DIR, 'package.json'));
const { chromium } = require_('@playwright/test');

// ---- 1. build the fake-mic clip: 5s silence + question + 4s silence ------------
async function buildWav() {
  if (process.env.VO_WAV && existsSync(WAV)) return;
  const key = process.env.DEEPGRAM_API_KEY || (() => {
    try { return (readFileSync('/run/software-factory/secrets.env', 'utf8').match(/^DEEPGRAM_API_KEY=(.+)$/m) || [])[1]; } catch { return ''; }
  })();
  if (!key) throw new Error('no DEEPGRAM_API_KEY and no VO_WAV provided');
  const r = await fetch('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=24000', {
    method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: QUESTION }),
  });
  if (!r.ok) throw new Error('deepgram tts failed: ' + r.status);
  const raw = Buffer.from(await r.arrayBuffer());
  // strip WAV container if present (find the data chunk), else treat as raw PCM
  let pcm = raw;
  if (raw.slice(0, 4).toString() === 'RIFF') {
    let off = 12;
    while (off < raw.length - 8) {
      const id = raw.slice(off, off + 4).toString();
      const sz = raw.readUInt32LE(off + 4);
      if (id === 'data') { pcm = raw.slice(off + 8, off + 8 + sz); break; }
      off += 8 + sz + (sz % 2);
    }
  }
  const rate = 24000, pre = Buffer.alloc(rate * 2 * 5), post = Buffer.alloc(rate * 2 * 4);
  const data = Buffer.concat([pre, pcm, post]);
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
  // A real thread with history, so the voice model is seeded with it.
  await page.evaluate(() => openChat({ id: null, title: 'Voice module tests', agent: 'claude' }));
  await page.waitForSelector('#threadVoiceBtn:not(.hidden)', { timeout: 10000 });
  step('thread voice button visible in the chat composer', true);
  // Intercept the hand-off so no real agent launches on the test box.
  await page.evaluate(() => { window.__sent = []; window.enqueueText = (text, opts) => { window.__sent.push({ text, opts }); }; });
  await page.click('#threadVoiceBtn');
  const live = await page.waitForFunction(() => { const s = document.getElementById('tvStatus'); return s && /Listening|Sent|working/i.test(s.textContent); }, { timeout: 30000 }).then(() => true).catch(() => false);
  step('GPT-Live connected in the thread', live, await page.$eval('#tvStatus', (e) => e.textContent).catch(() => '?'));
  const sent = await page.waitForFunction(() => window.__sent.length > 0, { timeout: 60000 }).then(() => true).catch(() => false);
  const handoff = sent ? await page.evaluate(() => window.__sent[0]) : null;
  console.log('  transcript so far:\n    ' + (await page.evaluate(() => ThreadVoice.transcript())).split('\n').join('\n    '));
  step('delegation sent the request into the thread', sent && /unit tests/i.test(handoff.text), handoff ? handoff.opts.displayText : '');
  if (sent) {
    // The thread's agent "runs" and replies; ThreadVoice must voice it.
    await page.evaluate((display) => {
      const ev = (o) => onServer({ key: cur.key, ...o });
      ev({ type: 'turn_start', text: display });
      ev({ type: 'text', delta: 'Running the voice tests now.' });
      ev({ type: 'tool', name: 'Bash', input: 'npm test' });
      setTimeout(() => { ev({ type: 'text', delta: 'All forty-two voice tests pass, and the live-voice suite is green.' }); ev({ type: 'done' }); }, 2500);
    }, handoff.opts.displayText);
    let said = ''; const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      said = await page.evaluate(() => (window.ThreadVoice ? ThreadVoice.transcript() : '').split('\n').filter((l) => l.startsWith('assistant:')).slice(-3).join(' ¶ '));
      if (/forty|42|pass/i.test(said)) break;
      await page.waitForTimeout(400);
    }
    step('agent reply was spoken back', /forty|42|pass/i.test(said), `"${said.slice(0, 200)}"`);
  }
}
await page.screenshot({ path: SHOT, fullPage: false });
console.log(`  screenshot → ${SHOT}`);
await page.evaluate(() => { document.getElementById('voEnd')?.click(); document.getElementById('tvEnd')?.click(); });
await page.waitForTimeout(1500);
await browser.close();
console.log(failed ? `\nE2E FAILED (${failed})\n` : '\nE2E PASSED\n');
process.exit(failed ? 1 : 0);
