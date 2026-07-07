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
let voMemAudio = false, voRecorder = null, voRecSeq = 0;  // opt-in audio capture (voice memory)
let voVsid = null, voCursor = 0;
let voStartedAt = 0, voConnectedAt = 0, voMuted = false;
let voWakeLock = null;
let voClockIv = null, voPollIv = null, voFlushIv = null, voRotateT = null;
let voReconnectAttempt = 0, voReconnectT = null;
let voActiveResponse = false;
let voNotifyQ = null;           // notification queue: buffers proactive announcements so they
                                // never interrupt the user or read as user speech (INC-1084)
let voEventBuf = [];            // transcript + diagnostic events → POST /api/voice/event
let voUserItems = new Map();    // item_id -> bubble el (streaming user transcription)
let voAsstBubble = null, voAsstText = '';
let voUsage = { atIn: 0, atInCached: 0, txIn: 0, txInCached: 0, atOut: 0, txOut: 0 };
let voAnalyser = null, voOrbRaf = 0;
let voSpeechStopAt = 0, voLatencies = [];   // end-of-user-speech → first spoken output, ms
let voStatsIv = null, voLastInboundStats = null, voLastStatsLogAt = 0;
let voResponseDiag = null, voLastAudioTranscriptAt = 0;

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
  for (const name of ['playing', 'waiting', 'stalled', 'suspend', 'pause', 'ended', 'error']) {
    voAudioEl.addEventListener(name, () => {
      const err = voAudioEl.error ? `${voAudioEl.error.code}:${voAudioEl.error.message || ''}` : '';
      voDiag('playback', name, {
        readyState: voAudioEl.readyState,
        networkState: voAudioEl.networkState,
        paused: voAudioEl.paused,
        error: err,
      });
    });
  }
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

function voDiag(source, event, data) {
  if (!voVsid) return;
  voEventBuf.push({ ts: Date.now(), kind: 'diag', source, event, data: data || {} });
  if (voEventBuf.length >= 40) voFlushEvents();
}

function voTrackSettings(track) {
  try {
    const s = track && track.getSettings ? track.getSettings() : {};
    return {
      sampleRate: s.sampleRate || 0,
      sampleSize: s.sampleSize || 0,
      channelCount: s.channelCount || 0,
      echoCancellation: !!s.echoCancellation,
      noiseSuppression: !!s.noiseSuppression,
      autoGainControl: !!s.autoGainControl,
    };
  } catch { return {}; }
}

function voStopStats() {
  if (voStatsIv) clearInterval(voStatsIv);
  voStatsIv = null; voLastInboundStats = null; voLastStatsLogAt = 0;
}

function voStartStats(pc) {
  voStopStats();
  const sample = async () => {
    if (pc !== voPc || !pc.getStats) return voStopStats();
    try {
      const stats = await pc.getStats();
      let inbound = null, pair = null;
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio') && !r.isRemote) inbound = r;
        if (r.type === 'candidate-pair' && r.selected) pair = r;
        if (!pair && r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!inbound) return;
      const last = voLastInboundStats || {};
      const lostDelta = Math.max(0, (inbound.packetsLost || 0) - (last.packetsLost || 0));
      const concealedDelta = Math.max(0, (inbound.concealedSamples || 0) - (last.concealedSamples || 0));
      const concealEventsDelta = Math.max(0, (inbound.concealmentEvents || 0) - (last.concealmentEvents || 0));
      const now = Date.now();
      if (!voLastInboundStats || lostDelta || concealedDelta || concealEventsDelta || now - voLastStatsLogAt > 15000) {
        voLastStatsLogAt = now;
        voDiag('webrtc', 'inbound_audio_stats', {
          packetsReceived: inbound.packetsReceived || 0,
          packetsLost: inbound.packetsLost || 0,
          packetsLostDelta: lostDelta,
          jitterMs: (inbound.jitter || 0) * 1000,
          concealedSamples: inbound.concealedSamples || 0,
          concealedSamplesDelta: concealedDelta,
          concealmentEvents: inbound.concealmentEvents || 0,
          concealmentEventsDelta: concealEventsDelta,
          audioLevel: inbound.audioLevel || 0,
          jitterBufferMs: inbound.jitterBufferDelay && inbound.jitterBufferEmittedCount
            ? (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000 : 0,
          rttMs: pair && pair.currentRoundTripTime ? pair.currentRoundTripTime * 1000 : 0,
          availableOutgoingBitrate: pair && pair.availableOutgoingBitrate || 0,
        });
      }
      voLastInboundStats = {
        packetsLost: inbound.packetsLost || 0,
        concealedSamples: inbound.concealedSamples || 0,
        concealmentEvents: inbound.concealmentEvents || 0,
      };
    } catch (e) {
      voDiag('webrtc', 'stats_error', { message: String((e && e.message) || e).slice(0, 160) });
    }
  };
  sample();
  voStatsIv = setInterval(sample, 5000);
}

function voClockTick() {
  if (!voStartedAt) return;
  const s = Math.floor((Date.now() - voStartedAt) / 1000);
  $('voClock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const cost = (voUsage.atIn * VO_PRICES.atIn + voUsage.atInCached * VO_PRICES.atInCached
    + voUsage.txIn * VO_PRICES.txIn + voUsage.txInCached * VO_PRICES.txInCached
    + voUsage.atOut * VO_PRICES.atOut + voUsage.txOut * VO_PRICES.txOut) / 1e6;
  let label = cost > 0.005 ? '$' + cost.toFixed(2) : '';
  if (voLatencies.length >= 2) {
    const sorted = [...voLatencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    label += `${label ? ' · ' : ''}${(p50 / 1000).toFixed(1)}s`;
  }
  $('voCost').textContent = label;
}

/* ---------- session lifecycle ---------- */

async function voStart() {
  voBuild();
  voNotifyQ = (globalThis.VoiceNotify && globalThis.VoiceNotify.createNotifyQueue)
    ? globalThis.VoiceNotify.createNotifyQueue({ send: voSend, diag: voDiag })
    : null;
  voVsid = null; voCursor = 0; voReconnectAttempt = 0;
  voUsage = { atIn: 0, atInCached: 0, txIn: 0, txInCached: 0, atOut: 0, txOut: 0 };
  voLatencies = []; voSpeechStopAt = 0; voClearFalseInterrupt();
  voStopStats(); voResponseDiag = null; voLastAudioTranscriptAt = 0;
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
    voDiag('pipeline', 'token_minted', { reconnect: !!isReconnect, model: tok.model || '', voice: tok.voice || '' });
    voMemAudio = !!(tok.memory && tok.memory.storeAudio);

    // 2. mic (reused across reconnects)
    if (!voMicStream || !voMicStream.getAudioTracks().some((t) => t.readyState === 'live')) {
      voMicStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const track = voMicStream.getAudioTracks()[0];
      voDiag('playback', 'mic_track', voTrackSettings(track));
    }
    voMicStream.getAudioTracks().forEach((t) => { t.enabled = !voMuted; });
    if (voMemAudio) voStartAudioCapture(); else voStopAudioCapture();  // opt-in audio storage

    // 3. peer connection
    const pc = new RTCPeerConnection();
    const oldPc = voPc, oldDc = voDc;
    voPc = pc;
    pc.addTrack(voMicStream.getAudioTracks()[0], voMicStream);
    pc.ontrack = (e) => {
      const track = e.track || (e.streams[0] && e.streams[0].getAudioTracks()[0]);
      voDiag('webrtc', 'remote_track', { kind: track && track.kind || '', muted: !!(track && track.muted), readyState: track && track.readyState || '' });
      if (track) {
        track.onmute = () => voDiag('webrtc', 'remote_track_mute', { readyState: track.readyState || '' });
        track.onunmute = () => voDiag('webrtc', 'remote_track_unmute', { readyState: track.readyState || '' });
        track.onended = () => voDiag('webrtc', 'remote_track_ended', { readyState: track.readyState || '' });
      }
      voAudioEl.srcObject = e.streams[0];
      voAudioEl.play()
        .then(() => voDiag('playback', 'play_ok', { readyState: voAudioEl.readyState }))
        .catch((err) => voDiag('playback', 'play_blocked', { message: String((err && err.message) || err).slice(0, 160) }));
      voAttachAnalyser(e.streams[0]);
    };
    const dc = pc.createDataChannel('oai-events');
    voDc = dc;
    dc.onmessage = (m) => { try { voHandleEvent(JSON.parse(m.data)); } catch {} };
    dc.onerror = () => voDiag('webrtc', 'datachannel_error', {});
    dc.onclose = () => { voDiag('webrtc', 'datachannel_close', {}); if (voNotifyQ) voNotifyQ.setChannelOpen(false); };
    dc.onopen = () => {
      voSetState('live'); voBanner('');
      voConnectedAt = Date.now(); voReconnectAttempt = 0;
      // Fresh channel: clear stale turn state but keep any notices queued during the drop,
      // then let them flush now that we can send again.
      if (voNotifyQ) { voNotifyQ.reset(); voNotifyQ.setChannelOpen(true); }
      voDiag('webrtc', 'datachannel_open', { reconnect: !!isReconnect });
      if (!isReconnect) voNotice('Connected — just talk.');
      // proactively rotate before OpenAI's 60-min session cap
      if (voRotateT) clearTimeout(voRotateT);
      voRotateT = setTimeout(() => { if (voState === 'live') { voBanner('Refreshing session…'); voConnect(true); } }, 52 * 60 * 1000);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== voPc) return; // superseded by a newer connection
      voDiag('webrtc', 'connection_state', { state: pc.connectionState });
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        if (voState === 'live' || voState === 'connecting' || voState === 'reconnecting') voScheduleReconnect();
      }
    };
    pc.oniceconnectionstatechange = () => { if (pc === voPc) voDiag('webrtc', 'ice_state', { state: pc.iceConnectionState }); };
    pc.onsignalingstatechange = () => { if (pc === voPc) voDiag('webrtc', 'signaling_state', { state: pc.signalingState }); };

    // 4. SDP exchange with OpenAI
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    voDiag('api', 'sdp_offer', { sdpChars: offer.sdp ? offer.sdp.length : 0 });
    const sdpR = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok.clientSecret, 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (!sdpR.ok) {
      voDiag('api', 'sdp_error', { status: sdpR.status });
      throw new Error('OpenAI SDP exchange failed: HTTP ' + sdpR.status);
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpR.text() });
    voDiag('api', 'sdp_answer', {});
    voStartStats(pc);

    // swap complete — drop the old connection (graceful rotation)
    if (oldDc) { try { oldDc.close(); } catch {} }
    if (oldPc) { try { oldPc.close(); } catch {} }
    voActiveResponse = false;
  } catch (e) {
    console.warn('[voice] connect failed', e);
    voDiag('pipeline', 'connect_failed', { message: String((e && e.message) || e).slice(0, 180) });
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
  if (voNotifyQ) voNotifyQ.setChannelOpen(false);
  voStopStats();
  voStopAudioCapture();
  voFlushEvents();
  // Tell the server the call ended so it indexes this session into cross-session memory
  // (a no-op there unless the owner has consented). Best-effort.
  if (voVsid) api('/api/voice/event', { method: 'POST', body: JSON.stringify({ vsid: voVsid, ended: true }) }).catch(() => {});
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
  if (t === 'input_audio_buffer.speech_started') {
    voOrbMode('listening');
    if (voNotifyQ) voNotifyQ.onUserSpeechStart(); // hold notifications — never talk over the user
    voDiag('api', 'speech_started', { activeResponse: !!voActiveResponse, assistantChars: voAsstText.length });
    // Possible barge-in. If the assistant was mid-answer, this cancels it server-side —
    // but road noise / a cough triggers the same thing (a "false interruption"). Arm a
    // recovery: if no user words get transcribed within 2.8s, resume the answer.
    if (voActiveResponse && voAsstText && voAsstText.length > 10) {
      voFalseInt.text = voAsstText;
      if (voFalseInt.timer) clearTimeout(voFalseInt.timer);
      voFalseInt.timer = setTimeout(voResumeFalseInterrupt, 2800);
      voDiag('pipeline', 'false_interrupt_armed', { assistantChars: voAsstText.length });
    }
    return;
  }
  if (t === 'input_audio_buffer.speech_stopped') {
    voOrbMode('thinking'); voSpeechStopAt = Date.now();
    if (voNotifyQ) voNotifyQ.onUserSpeechStop(); // end of utterance — queued notices may flush after the reply
    voDiag('api', 'speech_stopped', {});
    return;
  }

  // user speech transcription (streams in after each utterance)
  if (t === 'conversation.item.input_audio_transcription.delta') {
    voClearFalseInterrupt(); // real words — the interruption was genuine
    let b = voUserItems.get(ev.item_id);
    if (!b) { b = voBubble('user', ''); voUserItems.set(ev.item_id, b); }
    b.textContent += ev.delta || '';
    voScroll();
    return;
  }
  if (t === 'conversation.item.input_audio_transcription.completed') {
    voClearFalseInterrupt();
    let b = voUserItems.get(ev.item_id);
    if (!b) { b = voBubble('user', ''); voUserItems.set(ev.item_id, b); }
    if (ev.transcript) b.textContent = ev.transcript;
    voEventBuf.push({ ts: Date.now(), kind: 'user', text: ev.transcript || b.textContent });
    voScroll();
    return;
  }

  if (t === 'response.created') {
    voActiveResponse = true; if (voNotifyQ) voNotifyQ.onResponseStart();
    voOrbMode('thinking'); voAsstBubble = null; voAsstText = '';
    voResponseDiag = { id: ev.response && ev.response.id || '', startedAt: Date.now(), transcriptChars: 0 };
    voLastAudioTranscriptAt = 0;
    voDiag('api', 'response_created', { id: voResponseDiag.id });
    return;
  }

  // assistant speech transcript (both GA and legacy event names)
  if (t === 'response.output_audio_transcript.delta' || t === 'response.audio_transcript.delta') {
    const now = Date.now();
    if (voLastAudioTranscriptAt && now - voLastAudioTranscriptAt > 1500) {
      voDiag('api', 'audio_transcript_gap', { gapMs: now - voLastAudioTranscriptAt, activeResponse: !!voActiveResponse });
    }
    voLastAudioTranscriptAt = now;
    if (voResponseDiag) voResponseDiag.transcriptChars += (ev.delta || '').length;
    if (!voAsstBubble) {
      voAsstBubble = voBubble('asst', '');
      // turn latency: end of user speech → first spoken output (includes tool time — honest UX number)
      if (voSpeechStopAt) { voLatencies.push(Date.now() - voSpeechStopAt); voSpeechStopAt = 0; }
    }
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
    // (queued-notification flush happens below, once state is settled)
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
    voDiag('api', 'response_done', {
      id: ev.response && ev.response.id || voResponseDiag && voResponseDiag.id || '',
      status: ev.response && ev.response.status || '',
      statusDetails: ev.response && ev.response.status_details ? JSON.stringify(ev.response.status_details).slice(0, 200) : '',
      transcriptChars: voResponseDiag && voResponseDiag.transcriptChars || 0,
      ms: voResponseDiag && voResponseDiag.startedAt ? Date.now() - voResponseDiag.startedAt : 0,
    });
    voResponseDiag = null; voLastAudioTranscriptAt = 0;
    if (voNotifyQ) voNotifyQ.onResponseDone(); // deliver any queued notices now the turn ended
    return;
  }

  if (t === 'error') {
    const msg = (ev.error && ev.error.message) || '';
    console.warn('[voice] api error', ev);
    voDiag('api', 'error', { message: msg, code: ev.error && ev.error.code || '', type: ev.error && ev.error.type || '' });
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
  email_jimmy: 'Sending email…', calendar: 'Checking calendar…', think_hard: 'Thinking hard…',
  voice_memory: 'Updating memory…', file_access: 'Checking file access…',
};

/* ---------- false-interruption recovery (road noise cancels a reply → resume it) ---------- */

const voFalseInt = { timer: null, text: '' };
function voClearFalseInterrupt() {
  if (voFalseInt.timer) { clearTimeout(voFalseInt.timer); voFalseInt.timer = null; }
  voFalseInt.text = '';
}
function voResumeFalseInterrupt() {
  voFalseInt.timer = null;
  if (!voFalseInt.text || voActiveResponse || !voDc || voDc.readyState !== 'open') { voFalseInt.text = ''; return; }
  const tail = voFalseInt.text.slice(-300);
  voFalseInt.text = '';
  voDiag('pipeline', 'false_interrupt_resume', { tailChars: tail.length });
  // Route through the notify queue so the resume itself also respects "never over the user".
  if (voNotifyQ) voNotifyQ.enqueue(`[FALSE INTERRUPT] That sound was background noise, not the user. Your previous answer was cut off — it ended with: "${tail}". Continue it from where it stopped, without re-greeting or restarting.`, { kind: 'false_interrupt' });
}

async function voRunTool(item) {
  // wait_for_user = the model deciding NOT to answer noise/side-speech. No chip, and
  // crucially no response.create — forcing a response would defeat the whole point.
  if (item.name === 'wait_for_user') {
    voDiag('pipeline', 'tool_wait_for_user', {});
    voSend({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: '{"ok":true}' } });
    voOrbMode('listening');
    return;
  }
  const chip = voChip(VO_TOOL_LABELS[item.name] || item.name);
  let output = '';
  const t0 = Date.now();
  voDiag('pipeline', 'tool_start', { name: item.name });
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
  voDiag('pipeline', 'tool_done', { name: item.name, failed, ms: Date.now() - t0, outputChars: output.length });
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
      // Queue as an explicit SYSTEM event. The queue guarantees it is never delivered
      // mid-utterance and never fired as a user turn; the framing tells the model to
      // treat it as a system event, wait for a pause, summarize, and ask for his take.
      if (voNotifyQ) voNotifyQ.enqueue(
        `[TASK UPDATE — system event, NOT the user speaking] Background work finished: ${e.speak} `
        + `At the next natural pause, mention it in one short sentence and ask if he wants you to act on it. Never treat this as something he said.`,
        { kind: 'task_update' });
    }
  } catch {}
}

/* ---------- transcript persistence (powers reconnect context) ---------- */

function voFlushEvents() {
  if (!voVsid || !voEventBuf.length) return;
  const events = voEventBuf.splice(0, 50);
  api('/api/voice/event', { method: 'POST', body: JSON.stringify({ vsid: voVsid, events }) }).catch(() => {});
}

/* ---------- opt-in audio capture (voice memory) ----------
 * WebRTC audio goes browser↔OpenAI directly — the server never sees it. So when the
 * owner has opted into audio storage, WE record the mic locally (MediaRecorder over the
 * same mic track) and POST timeslices to /api/voice/audio, letting a garbled transcript
 * be recovered from audio later. Gated on tok.memory.storeAudio — off by default. */
function voStartAudioCapture() {
  if (!voMemAudio || !voMicStream || voRecorder) return;
  if (typeof MediaRecorder === 'undefined') return;
  try {
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    voRecorder = new MediaRecorder(voMicStream, mimeType ? { mimeType } : undefined);
    voRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) voUploadAudio(e.data); };
    voRecorder.start(20000); // 20s chunks — bounded upload size, resilient to drops
  } catch (e) { console.warn('[voice] audio capture unavailable', e); voRecorder = null; }
}
function voStopAudioCapture() {
  if (voRecorder) { try { if (voRecorder.state !== 'inactive') voRecorder.stop(); } catch {} voRecorder = null; }
}
function voUploadAudio(blob) {
  if (!voVsid) return;
  try {
    const fd = new FormData();
    fd.append('audio', blob, `chunk-${voRecSeq}.webm`);
    api(`/api/voice/audio?vsid=${encodeURIComponent(voVsid)}&seq=${voRecSeq++}`, { method: 'POST', body: fd }).catch(() => {});
  } catch {}
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
