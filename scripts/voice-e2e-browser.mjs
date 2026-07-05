#!/usr/bin/env node
// Full-stack browser E2E for the voice assistant: a real Chromium with a FAKE MICROPHONE
// that "speaks" a generated question (Deepgram TTS wav) into the live WebRTC session.
// Passes when the page shows (1) the user's transcribed question, (2) an assistant reply
// (and reports whether a tool chip appeared). This exercises: login → voice screen →
// token mint → WebRTC/SDP → server VAD → tool relay → TTS answer + transcript render.
//
// Usage:
//   VO_BASE=http://127.0.0.1:7461 VO_TOKEN=votest [PW_DIR=~/development/tools/playwright] \
//     node scripts/voice-e2e-browser.mjs
//
// Costs a few cents of realtime audio tokens. Needs DEEPGRAM_API_KEY (or a prebuilt
// VO_WAV=/path/to/question.wav) for the fake-mic clip.

import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = process.env.VO_BASE || 'http://127.0.0.1:7461';
const TOKEN = process.env.VO_TOKEN || 'votest';
const PW_DIR = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
const WAV = process.env.VO_WAV || '/tmp/vo-question.wav';
const SHOT = process.env.VO_SHOT || '/tmp/vo-e2e.png';
const QUESTION = process.env.VO_QUESTION || 'Hey, quick check. What agent sessions are active on the box right now?';

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
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)); });
await page.addInitScript((tok) => localStorage.setItem('cc_token', tok), TOKEN);
await page.context().grantPermissions(['microphone'], { origin: BASE });

let failed = 0;
const step = (name, okd, extra = '') => { console.log(`  ${okd ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!okd) failed++; };

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#voiceBtn:not(.hidden)', { timeout: 20000 }).catch(() => {});
step('voice button revealed', await page.$('#voiceBtn:not(.hidden)') != null);
await page.click('#voiceBtn');
await page.waitForSelector('#voMain', { timeout: 5000 });
step('voice screen open', true);
await page.click('#voMain');

// wait for live connection
const live = await page.waitForFunction(() => {
  const s = document.getElementById('voStatus');
  return s && s.textContent === 'live';
}, { timeout: 30000 }).then(() => true).catch(() => false);
step('webrtc connected (live)', live, live ? '' : await page.$eval('#voStatus', (e) => e.textContent).catch(() => '?'));

if (live) {
  // the fake mic is now feeding the question (after its 5s lead-in). Wait for transcripts.
  const gotUser = await page.waitForSelector('.voBub.user', { timeout: 45000 }).then(() => true).catch(() => false);
  step('user speech transcribed', gotUser, gotUser ? (await page.$eval('.voBub.user', (e) => e.textContent)).slice(0, 80) : '');
  // wait for the reply to FINISH: text present and stable for 2.5s (or 75s cap)
  let asstText = '', stableSince = 0, t0 = Date.now();
  while (Date.now() - t0 < 75000) {
    const cur = await page.$$eval('.voBub.asst', (els) => els.length ? els[els.length - 1].textContent.trim() : '').catch(() => '');
    if (cur !== asstText) { asstText = cur; stableSince = Date.now(); }
    else if (asstText.length > 12 && Date.now() - stableSince > 2500) break;
    await page.waitForTimeout(400);
  }
  step('assistant replied (complete)', asstText.length > 12, `"${asstText.slice(0, 160)}"`);
  const chips = await page.$$eval('.voToolChip', (els) => els.map((e) => e.textContent.trim()));
  console.log(`  (tool chips: ${chips.length ? chips.join(' | ') : 'none — model answered from snapshot context'})`);
  const cost = await page.$eval('#voCost', (e) => e.textContent).catch(() => '');
  const clock = await page.$eval('#voClock', (e) => e.textContent).catch(() => '');
  console.log(`  (elapsed ${clock || '?'}  cost ${cost || '<1¢'})`);
}

await page.screenshot({ path: SHOT, fullPage: true });
console.log(`  screenshot → ${SHOT}`);
await page.evaluate(() => { const b = document.getElementById('voEnd'); if (b && !b.disabled) b.click(); });
await page.waitForTimeout(800);
await browser.close();
console.log(failed ? `\nE2E FAILED (${failed})\n` : '\nE2E PASSED\n');
process.exit(failed ? 1 : 0);
