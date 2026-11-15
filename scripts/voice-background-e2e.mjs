#!/usr/bin/env node
// Browser E2E for the screen-off / app-switch lifecycle of GPT-Live voice (thread + Voice screen).
// iOS stops a web page's mic and WebRTC audio when the screen locks or the app is backgrounded;
// the app must PAUSE the call (not burn reconnects or end it) and RESUME the same conversation when
// the page is visible again. Chromium can't lock a screen, so this simulates what iOS does:
//   1. page visibility → hidden (visibilityState override + visibilitychange)
//   2. the connection dies while hidden (the data channel closes)
//   3. assert "Paused", and that NOTHING reconnects while hidden
//   4. visibility → visible: a new session connects and the call resumes ("Resumed.")
// Plus, on a live session: the mic track ends while hidden (iOS can end capture without killing
// the session) → on return the engine re-acquires the mic and swaps it into the same sender.
// Uses a real gpt-live-1 session (a few cents). Run against an ISOLATED test server (repo CLAUDE.md):
//   VO_BASE=http://127.0.0.1:17331 VO_TOKEN=… node scripts/voice-background-e2e.mjs
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.VO_BASE || 'http://127.0.0.1:17331';
const TOKEN = process.env.VO_TOKEN || 'bgtest';
const PW_DIR = process.env.PW_DIR || join(homedir(), 'development', 'tools', 'playwright');
const SHOT = process.env.VO_SHOT || '/tmp/voice-background-e2e.png';
const require_ = createRequire(join(PW_DIR, 'package.json'));
const { chromium } = require_('@playwright/test');

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
let failed = 0;
const step = (name, ok, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200)); });
  await page.addInitScript((tok) => {
    localStorage.setItem('cc_token', tok);
    // Controllable page visibility (what iOS flips when the screen locks).
    window.__vis = 'visible';
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__vis; } });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return window.__vis === 'hidden'; } });
    window.__setVis = (v) => { window.__vis = v; document.dispatchEvent(new Event('visibilitychange')); };
    // Record peer connections + data channels + mic grabs so the test can play the OS's part.
    const PC = window.RTCPeerConnection;
    window.__pcs = []; window.__dcs = []; window.__gum = 0;
    window.RTCPeerConnection = function (...a) {
      const pc = new PC(...a); window.__pcs.push(pc);
      const cdc = pc.createDataChannel.bind(pc);
      pc.createDataChannel = (...b) => { const dc = cdc(...b); window.__dcs.push(dc); return dc; };
      return pc;
    };
    window.RTCPeerConnection.prototype = PC.prototype;
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { window.__gum++; return gum(c); };
  }, TOKEN);
  await page.context().grantPermissions(['microphone'], { origin: BASE });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- thread voice ----
{
  console.log('thread voice:');
  const page = await newPage();
  await page.waitForSelector('#threadVoiceBtn', { state: 'attached', timeout: 20000 }).catch(() => {});
  await page.evaluate(() => openChat({ id: null, title: 'Background test', agent: 'claude' }));
  await page.waitForSelector('#threadVoiceBtn:not(.hidden)', { timeout: 10000 });
  await page.evaluate(() => { window.enqueueText = () => {}; }); // never launch an agent
  await page.click('#threadVoiceBtn');
  const status = () => page.$eval('#tvFullStatus', (e) => e.textContent).catch(() => '');
  const live = await page.waitForFunction(() => /Listening|Sent|working/i.test(document.getElementById('tvFullStatus')?.textContent || ''), { timeout: 30000 }).then(() => true).catch(() => false);
  step('connected', live, await status());
  // (a) mic track ends while hidden, session survives → replaced on return
  await page.evaluate(() => { window.__setVis('hidden'); const s = window.__pcs.at(-1).getSenders().find((x) => x.track && x.track.kind === 'audio'); window.__oldTrack = s.track; s.track.stop(); });
  await sleep(500);
  const gumBefore = await page.evaluate(() => window.__gum);
  await page.evaluate(() => window.__setVis('visible'));
  const swapped = await page.waitForFunction(() => { const s = window.__pcs.at(-1).getSenders().find((x) => x.track && x.track.kind === 'audio'); return s && s.track !== window.__oldTrack && s.track.readyState === 'live'; }, { timeout: 8000 }).then(() => true).catch(() => false);
  step('ended mic re-acquired + swapped into the same sender (no new session)', swapped && (await page.evaluate(() => window.__gum)) === gumBefore + 1 && (await page.evaluate(() => window.__pcs.length)) === 1);
  // (b) connection dies while hidden → paused, no reconnect while hidden
  await page.evaluate(() => { window.__setVis('hidden'); window.__dcs.at(-1).close(); });
  const paused = await page.waitForFunction(() => /Paused/.test(document.getElementById('tvFullStatus')?.textContent || ''), { timeout: 8000 }).then(() => true).catch(() => false);
  step('drop while hidden → paused (call kept)', paused, await status());
  await sleep(4000);
  const pcsHidden = await page.evaluate(() => window.__pcs.length);
  step('no reconnect attempts while hidden', pcsHidden === 1, `peer connections: ${pcsHidden}`);
  await page.screenshot({ path: SHOT.replace(/\.png$/, '-thread-paused.png') });
  await page.evaluate(() => window.__setVis('visible'));
  const resumed = await page.waitForFunction(() => window.__pcs.length === 2 && /Listening|Sent|working/i.test(document.getElementById('tvFullStatus')?.textContent || ''), { timeout: 30000 }).then(() => true).catch(() => false);
  const feed = await page.$$eval('#tvFeed *', (els) => els.map((e) => e.textContent).join(' ')).catch(() => '');
  step('visible again → resumed on a new session', resumed && /Resumed\./.test(feed), await status());
  await page.screenshot({ path: SHOT.replace(/\.png$/, '-thread-resumed.png') });
  await page.evaluate(() => document.getElementById('tvEnd')?.click());
  await page.close();
}

// ---- Voice screen (global) ----
{
  console.log('Voice screen:');
  const page = await newPage();
  await page.waitForSelector('#voiceBtn:not(.hidden)', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => openVoice());
  await page.waitForSelector('#voMain', { timeout: 5000 });
  await page.click('#voMain');
  const live = await page.waitForFunction(() => document.getElementById('voStatus')?.textContent === 'live', { timeout: 30000 }).then(() => true).catch(() => false);
  step('connected', live);
  await page.evaluate(() => { window.__setVis('hidden'); window.__dcs.at(-1).close(); });
  const paused = await page.waitForFunction(() => /Paused/.test(document.body.textContent || ''), { timeout: 8000 }).then(() => true).catch(() => false);
  step('drop while hidden → paused (call kept)', paused, await page.$eval('#voStatus', (e) => e.textContent).catch(() => ''));
  await sleep(4000);
  step('no reconnect attempts while hidden', (await page.evaluate(() => window.__pcs.length)) === 1);
  await page.evaluate(() => window.__setVis('visible'));
  const resumed = await page.waitForFunction(() => window.__pcs.length === 2 && document.getElementById('voStatus')?.textContent === 'live', { timeout: 30000 }).then(() => true).catch(() => false);
  step('visible again → resumed (same conversation)', resumed && /Resumed\./.test(await page.evaluate(() => document.body.textContent)));
  await page.screenshot({ path: SHOT.replace(/\.png$/, '-global-resumed.png') });
  await page.evaluate(() => document.getElementById('voEnd')?.click());
  await page.close();
}

await browser.close();
console.log(failed ? `\nE2E FAILED (${failed})\n` : '\nE2E PASSED\n');
process.exit(failed ? 1 : 0);
