/* Voice assistant — a realtime, hands-free voice call with the box.
 *
 * Audio path: browser ↔ OpenAI Realtime over WebRTC (mic track up, TTS track down,
 * JSON events on the 'oai-events' data channel). The box server never touches audio —
 * it mints the ephemeral token (with live-context instructions + tool schemas) and
 * executes every tool call the model makes (POST /api/voice/tool).
 *
 * Long-running work (deep research, delegated agents) completes in the background;
 * we poll /api/voice/updates and inject completions as system messages so the
 * assistant announces them mid-conversation.
 *
 * Realtime sessions hard-cap at 60 min and can't resume, so at ~52 min (or on any
 * drop — tunnels, dead zones) we mint a fresh token flagged as a reconnect: the
 * server folds the recent transcript into the new instructions and the conversation
 * continues seamlessly. Designed for long drives on flaky cellular.
 */

/* global $, api, show, toast, esc, paintIcons, navTo */

let voState = 'off';            // off | connecting | live | reconnecting | ended
let voPc = null, voDc = null, voMicStream = null, voAudioEl = null;
let voVsid = null, voCursor = 0;
let voStartedAt = 0, voConnectedAt = 0, voMuted = false;
let voWakeLock = null;
let voClockIv = null, voPollIv = null, voFlushIv = null, voRotateT = null;
let voReconnectAttempt = 0, voReconnectT = null;
let voActiveResponse = false;
let voPendingInjections = [];   // system messages waiting for the current response to finish
let voEventBuf = [];            // transcript events → POST /api/voice/event
let voUserItems = new Map();    // item_id -> bubble el (streaming user transcription)
let voAsstBubble = null, voAsstText = '';
let voUsage = { atIn: 0, atInCached: 0, txIn: 0, txInCached: 0, atOut: 0, txOut: 0 };
let voAnalyser = null, voOrbRaf = 0;

const VO_PRICES = { atIn: 32, atInCached: 0.4, txIn: 4, txInCached: 0.4, atOut: 64, txOut: 24 }; // $/1M tok (gpt-realtime-2)

function voBuild() {
  const root = $('voice');
  if (root.dataset.built) return;
  root.dataset.built = '1';
  root.innerHTML = `
  <header class="bar">
    <button id="voBack" class="iconbtn ghost" data-icon="back"></button>
    <strong class="ctitle">Voice</strong>
    <span id="voStatus" class="voStatus off">off</span>
    <div class="spacer"></div>
    <span id="voCost" class="voCost" title="session cost estimate"></span>
    <span id="voClock" class="voClock"></span>
  </header>
  <div id="voBanner" class="voBanner hidden"></div>
  <div id="voFeed" class="voFeed">
    <div class="voHint">Talk to your box like a colleague on a call.<br>
    It sees your agents, the board, research, the brain — and it can start work while you drive.</div>
  </div>
  <div class="voDock">
    <button id="voMute" class="voCtl" title="mute"><span data-icon="mic"></span></button>
    <button id="voMain" class="voOrbBtn"><span id="voOrb" class="voOrb"></span><span id="voOrbLabel" class="voOrbLabel">Start</span></button>
    <button id="voEnd" class="voCtl voEndBtn" title="end" disabled><span data-icon="close"></span></button>
  </div>`;
  paintIcons(root);
  $('voBack').onclick = () => history.back();
  $('voMain').onclick = () => { if (voState === 'off' || voState === 'ended') voStart(); };
  $('voEnd').onclick = () => voEnd('ended');
  $('voMute').onclick = voToggleMute;
  voAudioEl = new Audio();
  voAudioEl.autoplay = true;
  voAudioEl.setAttribute('playsinline', '');
}

function openVoice() {
  navTo({ view: 'voice' });
  voBuild();
  show('voice');
  paintIcons($('voice'));
}

/* ---------- UI helpers ---------- */

function voSetState(st) {
  voState = st;
  const pill = $('voStatus');
  pill.textContent = st === 'live' ? (voMuted ? 'muted' : 'live') : st;
  pill.className = 'voStatus ' + st + (voMuted && st === 'live' ? ' muted' : '');
  const orb = $('voOrb');
  orb.className = 'voOrb ' + (st === 'live' ? 'listening' : st);
  $('voOrbLabel').textContent = st === 'off' ? 'Start' : st === 'ended' ? 'Restart' : st === 'connecting' ? '…' : st === 'reconnecting' ? '…' : '';
  $('voEnd').disabled = !(st === 'live' || st === 'connecting' || st === 'reconnecting');
  $('voMain').classList.toggle('clickable', st === 'off' || st === 'ended');
}
function voOrbMode(mode) { // listening | thinking | speaking (only while live)
  if (voState !== 'live') return;
  $('voOrb').className = 'voOrb ' + mode;
}
function voBanner(msg) {
  const b = $('voBanner');
  if (!msg) { b.classList.add('hidden'); return; }
  b.textContent = msg; b.classList.remove('hidden');
}
function voFeedEl() { return $('voFeed'); }
function voScroll() { const f = voFeedEl(); f.scrollTop = f.scrollHeight; }
function voBubble(cls, text) {
  const d = document.createElement('div');
  d.className = 'voBub ' + cls;
  d.textContent = text || '';
  voFeedEl().appendChild(d); voScroll();
  return d;
}
function voChip(label) {
  const d = document.createElement('div');
  d.className = 'voToolChip';
  d.innerHTML = `<span class="voSpin"></span><span class="voToolName">${esc(label)}</span>`;
  voFeedEl().appendChild(d); voScroll();
  return d;
}
function voNotice(text) { voBubble('notice', text); }

function voClockTick() {
  if (!voStartedAt) return;
  const s = Math.floor((Date.now() - voStartedAt) / 1000);
  $('voClock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const cost = (voUsage.atIn * VO_PRICES.atIn + voUsage.atInCached * VO_PRICES.atInCached
    + voUsage.txIn * VO_PRICES.txIn + voUsage.txInCached * VO_PRICES.txInCached
    + voUsage.atOut * VO_PRICES.atOut + voUsage.txOut * VO_PRICES.txOut) / 1e6;
  $('voCost').textContent = cost > 0.005 ? '$' + cost.toFixed(2) : '';
}

/* ---------- session lifecycle ---------- */

async function voStart() {
  voBuild();
  voVsid = null; voCursor = 0; voReconnectAttempt = 0;
  voUsage = { atIn: 0, atInCached: 0, txIn: 0, txInCached: 0, atOut: 0, txOut: 0 };
  voStartedAt = Date.now();
  voFeedEl().innerHTML = '';
  await voConnect(false);
  if (voClockIv) clearInterval(voClockIv);
  voClockIv = setInterval(voClockTick, 1000);
  if (voFlushIv) clearInterval(voFlushIv);
  voFlushIv = setInterval(voFlushEvents, 4000);
  if (voPollIv) clearInterval(voPollIv);
  voPollIv = setInterval(voPollUpdates, 5000);
  voKeepAwake();
}

async function voConnect(isReconnect) {
  voSetState(isReconnect ? 'reconnecting' : 'connecting');
  try {
    // 1. ephemeral token (server builds instructions + tools, folds in transcript on reconnect)
    const tr = await api('/api/voice/token', { method: 'POST', body: JSON.stringify({ vsid: isReconnect ? voVsid : undefined }) });
    const tok = await tr.json();
    if (!tr.ok) throw new Error(tok.error || 'token mint failed');
    voVsid = tok.vsid;
    if (!isReconnect) voCursor = tok.cursor || 0;

    // 2. mic (reused across reconnects)
    if (!voMicStream || !voMicStream.getAudioTracks().some((t) => t.readyState === 'live')) {
      voMicStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
    voMicStream.getAudioTracks().forEach((t) => { t.enabled = !voMuted; });

    // 3. peer connection
    const pc = new RTCPeerConnection();
    const oldPc = voPc, oldDc = voDc;
    voPc = pc;
    pc.addTrack(voMicStream.getAudioTracks()[0], voMicStream);
    pc.ontrack = (e) => { voAudioEl.srcObject = e.streams[0]; voAudioEl.play().catch(() => {}); voAttachAnalyser(e.streams[0]); };
    const dc = pc.createDataChannel('oai-events');
    voDc = dc;
    dc.onmessage = (m) => { try { voHandleEvent(JSON.parse(m.data)); } catch {} };
    dc.onopen = () => {
      voSetState('live'); voBanner('');
      voConnectedAt = Date.now(); voReconnectAttempt = 0;
      if (!isReconnect) voNotice('Connected — just talk.');
      // proactively rotate before OpenAI's 60-min session cap
      if (voRotateT) clearTimeout(voRotateT);
      voRotateT = setTimeout(() => { if (voState === 'live') { voBanner('Refreshing session…'); voConnect(true); } }, 52 * 60 * 1000);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== voPc) return; // superseded by a newer connection
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        if (voState === 'live' || voState === 'connecting' || voState === 'reconnecting') voScheduleReconnect();
      }
    };

    // 4. SDP exchange with OpenAI
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpR = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok.clientSecret, 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (!sdpR.ok) throw new Error('OpenAI SDP exchange failed: HTTP ' + sdpR.status);
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpR.text() });

    // swap complete — drop the old connection (graceful rotation)
    if (oldDc) { try { oldDc.close(); } catch {} }
    if (oldPc) { try { oldPc.close(); } catch {} }
    voActiveResponse = false;
  } catch (e) {
    console.warn('[voice] connect failed', e);
    if (String(e && e.message).includes('getUserMedia') || (e && e.name === 'NotAllowedError')) {
      voSetState('off'); voBanner(''); toast('Microphone permission needed');
      return;
    }
    voScheduleReconnect(String((e && e.message) || e));
  }
}

function voScheduleReconnect(why) {
  if (voState === 'ended' || voState === 'off') return;
  voSetState('reconnecting');
  const delay = Math.min(30000, 1000 * Math.pow(2, voReconnectAttempt++));
  voBanner(`Connection lost${why ? '' : ' (coverage?)'} — reconnecting in ${Math.round(delay / 1000)}s…`);
  if (voReconnectT) clearTimeout(voReconnectT);
  voReconnectT = setTimeout(() => { if (voState === 'reconnecting') voConnect(true); }, delay);
}

function voEnd(finalState) {
  voSetState(finalState || 'ended');
  voBanner('');
  for (const t of [voReconnectT, voRotateT]) if (t) clearTimeout(t);
  for (const iv of [voClockIv, voPollIv, voFlushIv]) if (iv) clearInterval(iv);
  voReconnectT = voRotateT = voClockIv = voPollIv = voFlushIv = null;
  voFlushEvents();
  if (voDc) { try { voDc.close(); } catch {} voDc = null; }
  if (voPc) { try { voPc.close(); } catch {} voPc = null; }
  if (voMicStream) { voMicStream.getTracks().forEach((t) => t.stop()); voMicStream = null; }
  if (voWakeLock) { try { voWakeLock.release(); } catch {} voWakeLock = null; }
  if (voOrbRaf) cancelAnimationFrame(voOrbRaf);
  if (voStartedAt) voNotice('Call ended.');
}

function voToggleMute() {
  voMuted = !voMuted;
  if (voMicStream) voMicStream.getAudioTracks().forEach((t) => { t.enabled = !voMuted; });
  $('voMute').classList.toggle('active', voMuted);
  voSetState(voState);
}

let voWakeHooked = false;
async function voKeepAwake() {
  try { voWakeLock = await navigator.wakeLock.request('screen'); } catch {}
  if (voWakeHooked) return;
  voWakeHooked = true;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && (voState === 'live' || voState === 'reconnecting')) {
      try { voWakeLock = await navigator.wakeLock.request('screen'); } catch {}
    }
  });
}

/* ---------- OpenAI realtime events ---------- */

function voSend(obj) { if (voDc && voDc.readyState === 'open') { try { voDc.send(JSON.stringify(obj)); return true; } catch {} } return false; }

function voHandleEvent(ev) {
  const t = ev.type || '';
  if (t === 'input_audio_buffer.speech_started') { voOrbMode('listening'); return; }
  if (t === 'input_audio_buffer.speech_stopped') { voOrbMode('thinking'); return; }

  // user speech transcription (streams in after each utterance)
  if (t === 'conversation.item.input_audio_transcription.delta') {
    let b = voUserItems.get(ev.item_id);
    if (!b) { b = voBubble('user', ''); voUserItems.set(ev.item_id, b); }
    b.textContent += ev.delta || '';
    voScroll();
    return;
  }
  if (t === 'conversation.item.input_audio_transcription.completed') {
    let b = voUserItems.get(ev.item_id);
    if (!b) { b = voBubble('user', ''); voUserItems.set(ev.item_id, b); }
    if (ev.transcript) b.textContent = ev.transcript;
    voEventBuf.push({ ts: Date.now(), kind: 'user', text: ev.transcript || b.textContent });
    voScroll();
    return;
  }

  if (t === 'response.created') { voActiveResponse = true; voOrbMode('thinking'); voAsstBubble = null; voAsstText = ''; return; }

  // assistant speech transcript (both GA and legacy event names)
  if (t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta') {
    if (!voAsstBubble) voAsstBubble = voBubble('asst', '');
    voAsstText += ev.delta || '';
    voAsstBubble.textContent = voAsstText;
    voOrbMode('speaking'); voScroll();
    return;
  }
  if (t === 'response.output_audio_transcript.done' || t === 'response.audio_transcript.done') {
    if (ev.transcript && voAsstBubble) { voAsstText = ev.transcript; voAsstBubble.textContent = ev.transcript; }
    return;
  }

  if (t === 'response.output_item.done' && ev.item && ev.item.type === 'function_call') {
    voRunTool(ev.item);
    return;
  }

  if (t === 'response.done') {
    voActiveResponse = false;
    voOrbMode('listening');
    if (voAsstText) { voEventBuf.push({ ts: Date.now(), kind: 'assistant', text: voAsstText }); voAsstText = ''; voAsstBubble = null; }
    const u = ev.response && ev.response.usage;
    if (u) {
      const ind = u.input_token_details || {}, outd = u.output_token_details || {};
      const cached = (ind.cached_tokens_details || {});
      voUsage.atIn += Math.max(0, (ind.audio_tokens || 0) - (cached.audio_tokens || 0));
      voUsage.atInCached += cached.audio_tokens || 0;
      voUsage.txIn += Math.max(0, (ind.text_tokens || 0) - (cached.text_tokens || 0));
      voUsage.txInCached += cached.text_tokens || 0;
      voUsage.atOut += outd.audio_tokens || 0;
      voUsage.txOut += outd.text_tokens || 0;
    }
    voFlushInjections();
    return;
  }

  if (t === 'error') {
    const msg = (ev.error && ev.error.message) || '';
    console.warn('[voice] api error', ev);
    // benign: racing response.create while one is active
    if (/already has an active response/i.test(msg)) return;
    if (/session.*(expired|maximum duration)/i.test(msg)) { voBanner('Session refresh…'); voConnect(true); return; }
  }
}

/* ---------- tools ---------- */

const VO_TOOL_LABELS = {
  get_overview: 'Checking the box…', list_sessions: 'Listing sessions…', check_session: 'Checking session…',
  send_to_session: 'Messaging agent…', start_agent: 'Starting agent…', delegate_ticket: 'Delegating ticket…',
  linear_board: 'Reading board…', linear_create: 'Creating issue…', linear_update: 'Updating issue…',
  needs_jimmy: 'Checking decisions…', web_search: 'Searching the web…', deep_research: 'Launching research…',
  check_tasks: 'Checking tasks…', brain_search: 'Searching the brain…', brain_read: 'Reading the brain…',
  get_briefing: 'Opening briefing…', take_note: 'Noting…', read_notes: 'Reading notes…',
  email_jimmy: 'Sending email…', calendar: 'Checking calendar…',
};

async function voRunTool(item) {
  const chip = voChip(VO_TOOL_LABELS[item.name] || item.name);
  let output = '';
  try {
    const r = await api('/api/voice/tool', {
      method: 'POST',
      body: JSON.stringify({ name: item.name, args: item.arguments, call_id: item.call_id, vsid: voVsid }),
    });
    const j = await r.json();
    output = j.output || '{"error":"empty tool result"}';
  } catch (e) {
    output = JSON.stringify({ error: 'box unreachable: ' + String((e && e.message) || e).slice(0, 120) });
  }
  const failed = /"error"/.test(output.slice(0, 60));
  chip.classList.add(failed ? 'fail' : 'ok');
  chip.querySelector('.voSpin').remove();
  voSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output } });
  voSend({ type: 'response.create' });
}

/* ---------- background-task updates → proactive announcements ---------- */

async function voPollUpdates() {
  if (!voVsid || !voDc || voDc.readyState !== 'open') return;
  try {
    const r = await api(`/api/voice/updates?cursor=${voCursor}`);
    const j = await r.json();
    for (const e of (j.events || [])) {
      voCursor = Math.max(voCursor, e.seq);
      voNotice('📣 ' + (e.title || e.kind));
      voInjectSystem(`[TASK UPDATE] ${e.speak}`);
    }
  } catch {}
}

function voInjectSystem(text) {
  const msg = { type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } };
  if (voActiveResponse) { voPendingInjections.push(msg); return; }
  if (voSend(msg)) voSend({ type: 'response.create' });
}
function voFlushInjections() {
  if (!voPendingInjections.length || voActiveResponse) return;
  const batch = voPendingInjections.splice(0);
  let any = false;
  for (const m of batch) any = voSend(m) || any;
  if (any) voSend({ type: 'response.create' });
}

/* ---------- transcript persistence (powers reconnect context) ---------- */

function voFlushEvents() {
  if (!voVsid || !voEventBuf.length) return;
  const events = voEventBuf.splice(0, 50);
  api('/api/voice/event', { method: 'POST', body: JSON.stringify({ vsid: voVsid, events }) }).catch(() => {});
}

/* ---------- orb level animation (assistant speech drives the glow) ---------- */

function voAttachAnalyser(stream) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    ac.resume().catch(() => {});
    const src = ac.createMediaStreamSource(stream);
    voAnalyser = ac.createAnalyser();
    voAnalyser.fftSize = 256;
    src.connect(voAnalyser);
    const data = new Uint8Array(voAnalyser.frequencyBinCount);
    const orb = $('voOrb');
    const loop = () => {
      voOrbRaf = requestAnimationFrame(loop);
      if (!voAnalyser) return;
      voAnalyser.getByteFrequencyData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
      const level = Math.min(1, (sum / data.length) / 90);
      orb.style.setProperty('--lvl', (1 + level * 0.35).toFixed(3));
    };
    if (voOrbRaf) cancelAnimationFrame(voOrbRaf);
    loop();
  } catch {}
}

/* ---------- boot: reveal the entry button when the server supports it ---------- */

(function voInit() {
  const btn = $('voiceBtn');
  if (btn) btn.onclick = openVoice;
  let tries = 0;
  const probe = async () => {
    tries++;
    try {
      const r = await api('/api/config');
      if (r.ok) {
        const cfgJson = await r.json();
        if (btn && cfgJson.features && cfgJson.features.voiceAssistant) btn.classList.remove('hidden');
        return;
      }
    } catch {}
    if (tries < 20) setTimeout(probe, 3000); // pre-login 401s → keep trying quietly
  };
  setTimeout(probe, 800);
})();
