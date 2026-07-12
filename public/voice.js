/* Voice assistant — a realtime, hands-free voice call with the box.
 *
 * Audio path: browser ↔ OpenAI Realtime over WebRTC (mic track up, TTS track down,
 * JSON events on the 'oai-events' data channel). The box server never touches audio —
 * it mints the ephemeral token (with live-context instructions + tool schemas) and
 * executes every tool call the model makes (POST /api/voice/tool).
 *
 * Long-running work (deep research, delegated agents) completes in the background.
 * We show all updates in the UI, but only explicitly watched or urgent updates become
 * spoken system messages; routine completions never hijack the active conversation.
 *
 * Realtime sessions hard-cap at 60 min and can't resume, so at ~52 min (or on any
 * drop — tunnels, dead zones) we mint a fresh token flagged as a reconnect: the
 * server folds the recent transcript into the new instructions and the conversation
 * continues seamlessly. Designed for long drives on flaky cellular.
 */

/* global $, api, show, toast, esc, paintIcons, navTo */

let voState = 'off';            // off | connecting | live | reconnecting | ended
let voPc = null, voDc = null, voMicStream = null, voAudioEl = null;
let voLivekitMicWarmup = null;
let voMemAudio = false, voRecorder = null, voRecSeq = 0, voAudioRecorders = [];  // opt-in audio capture (voice memory)
let voVsid = null, voCursor = 0;
let voStartedAt = 0, voConnectedAt = 0, voMuted = false;
let voWakeLock = null;
let voClockIv = null, voPollIv = null, voFlushIv = null, voRotateT = null;
let voReconnectAttempt = 0, voReconnectT = null;
let voActiveResponse = false;
let voNotifyQ = null;           // notification queue: buffers proactive announcements so they
                                // never interrupt the user or read as user speech (INC-1084)
let voEventBuf = [];            // transcript + diagnostic events → POST /api/voice/event
let voFlushInFlight = false;
let voUserItems = new Map();    // item_id -> bubble el (streaming user transcription)
let voAsstBubble = null, voAsstText = '';
let voUsage = { atIn: 0, atInCached: 0, txIn: 0, txInCached: 0, atOut: 0, txOut: 0 };
let voAnalyser = null, voOrbRaf = 0;
let voSpeechStopAt = 0, voLatencies = [];   // end-of-user-speech → first spoken output, ms
let voStatsIv = null, voLastInboundStats = null, voLastStatsLogAt = 0;
let voResponseDiag = null, voLastAudioTranscriptAt = 0;
let voDropCurrentResponse = false; // empty/noise turn: cancel and suppress the model's accidental reply
// Experimental adapter mode: browser VAD records one utterance, server STT routes it
// through a persistent Claude/Codex session, then HTTP TTS plays the returned text.
let voMode = 'realtime', voAdapterCfg = null, voAdapterAudioCtx = null, voAdapterAnalyser = null;
let voAdapterRaf = 0, voAdapterRecorder = null, voAdapterChunks = [], voAdapterSpeechAt = 0;
let voAdapterSilentAt = 0, voAdapterBusy = false, voAdapterSpeaking = false;
let voAdapterManualGraceUntil = 0, voAdapterLastVadDiagAt = 0;
let voAdapterPreviewAt = 0, voAdapterPreviewInFlight = false, voAdapterPreviewSeq = 0, voAdapterUserBubble = null;
let voAdapterSttWs = null, voAdapterSttProc = null, voAdapterSttSource = null, voAdapterSttSink = null;
let voAdapterCommitted = '', voAdapterPartial = '', voAdapterEndpointT = null;
let voAdapterTransport = 'legacy', voLivekitRoom = null, voLivekitTranscript = '', voLivekitBubble = null;
let voLivekitAsstTranscript = '', voLivekitAsstBubble = null;
let voLivekitUserSegments = new Map(), voLivekitAsstSegments = new Map();
let voLivekitCommitBusy = false;
let voLivekitEndpointAt = 0, voLivekitEndpointText = '', voLivekitPlaybackLogged = false;
// Barge-in telemetry is deliberately measured at the caller-visible boundary: the
// first LiveKit event that says the caller is speaking, through the first event
// that says the assistant is no longer audible. This avoids claiming microphone
// onset timing that the browser cannot observe accurately.
let voLivekitBargeAt = 0;
let voLivekitCallerSpeechAt = 0, voLivekitCallerSpeaking = false, voLivekitCallerSpeechEndedAt = 0;
let voLivekitTurnFinalAt = 0, voLivekitSpeechEndLatencyLogged = false, voLivekitFirstAssistantTextLogged = false;

/* ---------- INC-1088: audio-pipeline hardening (half-duplex + self-echo guard) ----------
 * The assistant's TTS plays out the phone/car speaker and the mic hears it. OpenAI's
 * Realtime VAD + transcription run server-side, so the ONLY place we can stop the model
 * from hearing its own voice is here, at the mic: while our TTS is playing we gate the
 * outgoing mic track closed (half-duplex) and re-open it only after playback ends (+ a
 * tail hangover for the WebRTC jitter-buffer drain). A self-echo guard is the second line
 * of defense — a "user" transcript that matches what we just said is dropped and the
 * poisoned item purged from the model's context. Policy is minted by the server
 * (/api/voice/token → audioPolicy); the matcher twins selfEchoMatch() in
 * server/voice-assistant.mjs (regression-tested there — keep the two in sync). */
const VO_AUDIO_POLICY_DEFAULT = { halfDuplex: true, tailMs: 600, maxHoldMs: 20000, echoGuard: true, echoThreshold: 0.8, echoMinTokens: 4 };
let voAudioPolicy = { ...VO_AUDIO_POLICY_DEFAULT };
let voMicGateClosed = false, voMicReopenT = null, voMicMaxHoldT = null;
let voRecentAsst = [];                                   // last few assistant utterances (self-echo compare)
let voIncidents = { selfInterrupt: 0, misattribution: 0 };

const VO_PRICES = { atIn: 32, atInCached: 0.4, txIn: 4, txInCached: 0.4, atOut: 64, txOut: 24 }; // $/1M tok (gpt-realtime-2.1)

// Keep capture negotiation intentionally small. iOS sometimes spends several seconds
// resolving a larger constraint set before it opens the audio session. These three
// standard processing flags retain the echo protection we need without Chrome-only
// `advanced` hints or a redundant channel-count negotiation.
function voMicConstraints() {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

// Start iOS microphone activation while the navigation/call button still owns a
// user gesture. Waiting for /voice/status first loses that activation and Safari
// has repeatedly taken 2.5-6.2 seconds to open the exact same microphone track.
// The resolved track is held briefly and then published by voStartLivekitAdapter.
function voBeginLivekitMicWarmup() {
  if (voLivekitMicWarmup) return voLivekitMicWarmup;
  const LK = globalThis.LivekitClient;
  if (!LK || typeof LK.createLocalAudioTrack !== 'function') return null;
  const warmup = { startedAt: Date.now(), promise: null, timer: null };
  let capture;
  try { capture = LK.createLocalAudioTrack(voMicConstraints()); }
  catch (error) { capture = Promise.reject(error); }
  // Convert rejection into data immediately so a slow status request can never
  // produce an unhandled-rejection event before the adapter awaits the result.
  warmup.promise = Promise.resolve(capture).then((track) => ({ track }), (error) => ({ error }));
  warmup.timer = setTimeout(() => {
    if (voLivekitMicWarmup !== warmup) return;
    voLivekitMicWarmup = null;
    warmup.promise.then(({ track }) => { try { if (track) track.stop(); } catch {} });
  }, 30000);
  voLivekitMicWarmup = warmup;
  return warmup;
}
function voTakeLivekitMicWarmup() {
  const warmup = voLivekitMicWarmup || voBeginLivekitMicWarmup();
  if (!warmup) return null;
  voLivekitMicWarmup = null;
  if (warmup.timer) clearTimeout(warmup.timer);
  warmup.timer = null;
  return warmup;
}
function voStopLivekitMicWarmup(warmup = voLivekitMicWarmup) {
  if (!warmup) return;
  if (voLivekitMicWarmup === warmup) voLivekitMicWarmup = null;
  if (warmup.timer) clearTimeout(warmup.timer);
  warmup.timer = null;
  warmup.promise.then(({ track }) => { try { if (track) track.stop(); } catch {} });
}

// Effective mic state = user hasn't muted AND the half-duplex gate isn't holding it closed.
function voApplyMic() {
  const on = !voMuted && !(voAudioPolicy.halfDuplex && voMicGateClosed);
  if (voMicStream) voMicStream.getAudioTracks().forEach((t) => { if (t.enabled !== on) t.enabled = on; });
  if (voLivekitRoom && voLivekitRoom.localParticipant) {
    voLivekitRoom.localParticipant.setMicrophoneEnabled(on).catch(() => {});
  }
}
function voHalfDuplexClose() {
  if (!voAudioPolicy.halfDuplex || voMicGateClosed) return;
  if (voMicReopenT) { clearTimeout(voMicReopenT); voMicReopenT = null; }
  voMicGateClosed = true;
  voApplyMic();
  voDiag('pipeline', 'half_duplex_gate_closed', {});
  if (voMicMaxHoldT) clearTimeout(voMicMaxHoldT);
  // Safety: a dropped response.done must never wedge the mic shut for the rest of a drive.
  voMicMaxHoldT = setTimeout(() => voHalfDuplexReopen('max_hold'), voAudioPolicy.maxHoldMs);
}
function voHalfDuplexReopen(reason) {
  if (voMicReopenT) { clearTimeout(voMicReopenT); voMicReopenT = null; }
  if (voMicMaxHoldT) { clearTimeout(voMicMaxHoldT); voMicMaxHoldT = null; }
  if (!voMicGateClosed) return;
  voMicGateClosed = false;
  voApplyMic();
  voDiag('pipeline', 'half_duplex_gate_open', { reason: reason || 'tail' });
}
function voHalfDuplexScheduleReopen() {
  if (!voAudioPolicy.halfDuplex || !voMicGateClosed) return;
  if (voMicReopenT) clearTimeout(voMicReopenT);
  voMicReopenT = setTimeout(() => { voMicReopenT = null; voHalfDuplexReopen('tail'); }, voAudioPolicy.tailMs);
}
function voResetAudioGate() {
  if (voMicReopenT) { clearTimeout(voMicReopenT); voMicReopenT = null; }
  if (voMicMaxHoldT) { clearTimeout(voMicMaxHoldT); voMicMaxHoldT = null; }
  voMicGateClosed = false;
}

// twin of selfEchoMatch() in server/voice-assistant.mjs — keep in sync
function voNormTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
// The self-echo comparison set is not just the assistant's COMPLETED utterances
// (voRecentAsst, appended only at response.done) but also the one it is speaking RIGHT
// NOW (voAsstText) and the one a barge-in just cut off (voFalseInt.text). In barge-in
// mode the mic stays hot while the assistant talks, so the utterance most likely to
// echo back and trip the VAD is the *current* sentence — which was absent from the set
// until this fix, causing its echo to be misread as a genuine user interruption and the
// answer to stop mid-sentence with no recovery (INC-1088 follow-up). Keep in sync with
// server twin selfEchoMatch().
function voEchoCompareSet() {
  const set = voRecentAsst.slice();
  if (voAsstText) set.push(voAsstText);
  if (voFalseInt && voFalseInt.text) set.push(voFalseInt.text);
  return set;
}
function voSelfEchoScore(userText) {
  const u = voNormTokens(userText);
  if (u.length < voAudioPolicy.echoMinTokens) return 0;
  let best = 0;
  for (const a of voEchoCompareSet()) {
    const at = voNormTokens(a);
    if (at.length < voAudioPolicy.echoMinTokens) continue;
    const aset = new Set(at);
    let hit = 0; for (const w of u) if (aset.has(w)) hit++;
    best = Math.max(best, hit / u.length);
  }
  return best;
}
function voIsSelfEcho(userText) {
  return !!voAudioPolicy.echoGuard && voSelfEchoScore(userText) >= voAudioPolicy.echoThreshold;
}
function voRememberAsst(text) {
  const t = String(text || '').trim();
  if (t.length < 4) return;
  if (voRecentAsst[voRecentAsst.length - 1] === t) return;
  voRecentAsst.push(t);
  if (voRecentAsst.length > 4) voRecentAsst.shift();
}

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
  $('voBack').onclick = () => {
    if (voState === 'off' || voState === 'ended') voStopLivekitMicWarmup();
    history.back();
  };
  $('voMain').onclick = () => {
    if (voState === 'off' || voState === 'ended') voStart();
    else if (voState === 'live' && voMode === 'adapter') voAdapterManualRecord();
  };
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
  // Opening Voice is itself a user gesture and is the earliest safe point to
  // activate the iPhone microphone. If Start follows immediately, voStart also
  // calls this synchronously before its first network await.
  if (voState === 'off' || voState === 'ended') voBeginLivekitMicWarmup();
}

/* ---------- UI helpers ---------- */

function voSetState(st) {
  voState = st;
  const pill = $('voStatus');
  pill.textContent = st === 'live' ? (voMuted ? 'muted' : 'live') : st;
  pill.className = 'voStatus ' + st + (voMuted && st === 'live' ? ' muted' : '');
  const orb = $('voOrb');
  orb.className = 'voOrb ' + (st === 'live' ? 'listening' : st);
  $('voOrbLabel').textContent = st === 'off' ? 'Start' : st === 'ended' ? 'Restart' : st === 'connecting' ? '…' : st === 'reconnecting' ? '…' : (st === 'live' && voMode === 'adapter' ? 'End turn' : '');
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
  // Timing events are useful only if the agent can see them on its next turn.
  // Push those boundaries immediately; routine diagnostics still batch normally.
  const liveBoundary = new Set([
    'caller_speech_detected', 'caller_speech_ended', 'caller_final_transcript',
    'speech_start_to_final_transcript', 'caller_speech_end_to_final_transcript',
    'endpoint_to_first_assistant_text', 'endpoint_to_playback',
    'assistant_playback_started', 'assistant_playback_stopped',
    'barge_in_detected', 'barge_in_playback_stopped',
  ]);
  if (liveBoundary.has(event) || voEventBuf.length >= 40) voFlushEvents();
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
  // Take (or synchronously begin) microphone capture before /voice/status. This
  // preserves the user gesture on iOS and overlaps capture with all setup I/O.
  const livekitMicWarmup = voTakeLivekitMicWarmup();
  voNotifyQ = (globalThis.VoiceNotify && globalThis.VoiceNotify.createNotifyQueue)
    ? globalThis.VoiceNotify.createNotifyQueue({ send: voSend, diag: voDiag })
    : null;
  // Stop any stale recorder before clearing its session id, so a final buffered
  // chunk can still be uploaded to the call it belongs to.
  voStopAudioCapture();
  voVsid = null; voCursor = 0; voReconnectAttempt = 0; voRecSeq = 0; voMemAudio = false;
  voUsage = { atIn: 0, atInCached: 0, txIn: 0, txInCached: 0, atOut: 0, txOut: 0 };
  voLatencies = []; voSpeechStopAt = 0; voClearFalseInterrupt();
  voStopStats(); voResponseDiag = null; voLastAudioTranscriptAt = 0;
  voResetAudioGate(); voRecentAsst = []; voIncidents = { selfInterrupt: 0, misattribution: 0 }; voDropCurrentResponse = false;
  voStartedAt = Date.now();
  voFeedEl().innerHTML = '';
  try {
    const r = await api('/api/voice/status');
    const st = await r.json();
    if (!r.ok) throw new Error(st.error || 'voice status unavailable');
    // The adapter shares the realtime audio policy. In particular, barge-in
    // requires an open mic while TTS plays; leave echo protection enabled.
    voAudioPolicy = { ...VO_AUDIO_POLICY_DEFAULT, ...(st.audioPolicy || {}) };
    voMemAudio = !!(st.memory && st.memory.storeAudio);
    voMode = st.mode === 'adapter' ? 'adapter' : 'realtime';
    if (voMode === 'adapter') await voStartAdapter(st.adapter || {}, livekitMicWarmup);
    else {
      voStopLivekitMicWarmup(livekitMicWarmup);
      await voConnect(false);
    }
  } catch (e) {
    voStopLivekitMicWarmup(livekitMicWarmup);
    voSetState('off'); toast(String((e && e.message) || e).slice(0, 120)); return;
  }
  if (voClockIv) clearInterval(voClockIv);
  voClockIv = setInterval(voClockTick, 1000);
  if (voFlushIv) clearInterval(voFlushIv);
  voFlushIv = setInterval(voFlushEvents, 4000);
  if (voPollIv) clearInterval(voPollIv);
  voPollIv = setInterval(voPollUpdates, 5000);
  voKeepAwake();
}

function voAdapterId() {
  try { return crypto.randomUUID(); } catch { return `adapter-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}
async function voStartAdapter(cfg, livekitMicWarmup = null) {
  if (!cfg.enabled) throw new Error('adapter mode needs the box STT/TTS and selected CLI agent');
  voSetState('connecting');
  voAdapterCfg = cfg;
  voAdapterTransport = cfg.transport === 'livekit' ? 'livekit' : 'legacy';
  voVsid = voAdapterId();
  if (voAdapterTransport === 'livekit') return voStartLivekitAdapter(cfg, livekitMicWarmup);
  voStopLivekitMicWarmup(livekitMicWarmup);
  if (typeof MediaRecorder === 'undefined') throw new Error('this browser cannot record microphone audio for adapter mode');
  voMicStream = await navigator.mediaDevices.getUserMedia({ audio: voMicConstraints() });
  voApplyMic();
  try { await voAdapterStartStreamingStt(); }
  catch (e) { throw new Error('streaming transcription unavailable: ' + String((e && e.message) || e)); }
  voSetState('live'); voConnectedAt = Date.now(); voBanner(''); voNotice(`Adapter mode — ${cfg.agent || 'agent'} is ready. Speak naturally; the turn hands off after end-of-speech. Tap End turn to hand off sooner.`);
}
function voLivekitMergeSegments(store, segments) {
  for (const segment of (segments || [])) {
    const id = String(segment && segment.id || '');
    const text = String(segment && segment.text || '').trim();
    if (!id || !text) continue;
    // LiveKit updates the same segment as it grows and then marks it final.
    // Keeping it by ID replaces that update instead of rendering a new message.
    store.set(id, { id, text, final: !!segment.final, startTime: Number(segment.startTime) || 0 });
  }
  return [...store.values()].sort((a, b) => a.startTime - b.startTime).map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
}
function voLivekitAppendTranscript(segments) {
  // A new caller segment after an assistant reply starts the next visual turn.
  // Do not use ActiveSpeakersChanged for this: it flickers at sentence pauses.
  const startsNewTurn = (segments || []).some((s) => s && s.id && !voLivekitUserSegments.has(String(s.id)));
  if (startsNewTurn && voLivekitAsstTranscript) {
    voLivekitAsstTranscript = ''; voLivekitAsstBubble = null; voLivekitAsstSegments = new Map();
    voLivekitUserSegments = new Map(); voLivekitTranscript = ''; voLivekitBubble = null;
  }
  voLivekitTranscript = voLivekitMergeSegments(voLivekitUserSegments, segments);
  const finals = (segments || []).filter((s) => s && s.final && String(s.text || '').trim());
  const final = finals[finals.length - 1];
  if (final) {
    voLivekitEndpointAt = Date.now();
    voLivekitTurnFinalAt = voLivekitEndpointAt;
    voLivekitEndpointText = String(final.text || '').slice(0, 160);
    voLivekitPlaybackLogged = false;
    voDiag('livekit', 'caller_final_transcript', { chars: voLivekitEndpointText.length });
    if (voLivekitCallerSpeechAt) {
      // Kept only as a descriptive diagnostic. It includes the duration of the
      // caller's utterance, so it is never used as a latency target.
      voDiag('livekit', 'speech_start_to_final_transcript', { ms: voLivekitEndpointAt - voLivekitCallerSpeechAt });
      voLivekitCallerSpeechAt = 0;
    }
    if (voLivekitCallerSpeechEndedAt && !voLivekitSpeechEndLatencyLogged) {
      voLivekitSpeechEndLatencyLogged = true;
      voDiag('livekit', 'caller_speech_end_to_final_transcript', { ms: Math.max(0, voLivekitEndpointAt - voLivekitCallerSpeechEndedAt) });
    }
    voLivekitFirstAssistantTextLogged = false;
  }
  if (!voLivekitBubble) voLivekitBubble = voBubble('user', 'Listening…');
  voLivekitBubble.textContent = voLivekitTranscript || 'Listening…';
  voScroll();
}
function voLivekitAppendAssistantTranscript(segments) {
  voLivekitAsstTranscript = voLivekitMergeSegments(voLivekitAsstSegments, segments);
  if (voLivekitAsstTranscript && voLivekitEndpointAt && !voLivekitFirstAssistantTextLogged) {
    voLivekitFirstAssistantTextLogged = true;
    voDiag('livekit', 'endpoint_to_first_assistant_text', { ms: Date.now() - voLivekitEndpointAt });
  }
  if (!voLivekitAsstBubble) voLivekitAsstBubble = voBubble('asst', '');
  voLivekitAsstBubble.textContent = voLivekitAsstTranscript;
  if (voLivekitAsstTranscript) { voAsstText = voLivekitAsstTranscript; voRememberAsst(voLivekitAsstTranscript); }
  voScroll();
}
async function voStartLivekitAdapter(cfg, livekitMicWarmup = null) {
  if (!globalThis.LivekitClient) throw new Error('LiveKit client library did not load; refresh once to update the app shell');
  const LK = globalThis.LivekitClient;
  const warmup = livekitMicWarmup || voTakeLivekitMicWarmup();
  if (!warmup) throw new Error('this browser cannot open a LiveKit microphone track');
  const startupAt = warmup.startedAt;
  voDiag('livekit', 'startup_started', { prewarmed_ms: Date.now() - startupAt });
  const micPromise = warmup.promise.then(({ track, error }) => {
    if (error) throw error;
    voDiag('livekit', 'startup_microphone_captured', { ms: Date.now() - startupAt });
    return track;
  });
  const stopPendingMic = () => micPromise.then((track) => { try { track.stop(); } catch {} }).catch(() => {});
  let r;
  try {
    r = await api('/api/voice/livekit/token', { method: 'POST', body: JSON.stringify({ vsid: voVsid }) });
  } catch (error) {
    stopPendingMic();
    throw error;
  }
  const join = await r.json();
  if (!r.ok) { stopPendingMic(); throw new Error(join.error || 'LiveKit voice token failed'); }
  voDiag('livekit', 'startup_token_ready', { ms: Date.now() - startupAt });
  voVsid = join.vsid || voVsid;
  const room = new LK.Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: voMicConstraints() });
  voLivekitRoom = room; voLivekitTranscript = ''; voLivekitBubble = null; voLivekitUserSegments = new Map();
  voLivekitAsstTranscript = ''; voLivekitAsstBubble = null; voLivekitAsstSegments = new Map();
  voLivekitBargeAt = 0; voLivekitCallerSpeechAt = 0; voLivekitCallerSpeaking = false; voLivekitCallerSpeechEndedAt = 0;
  voLivekitTurnFinalAt = 0; voLivekitSpeechEndLatencyLogged = false; voLivekitFirstAssistantTextLogged = false;
  room.on(LK.RoomEvent.TranscriptionReceived, (segments, participant) => {
    if (!participant || participant.identity === room.localParticipant.identity) voLivekitAppendTranscript(segments);
    else voLivekitAppendAssistantTranscript(segments);
  });
  room.on(LK.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== LK.Track.Kind.Audio) return;
    track.attach(voAudioEl);
    voAudioEl.play().catch(() => {});
    // Keep caller and assistant audio as separately timestamped clips. This is
    // more reliable on iOS than trying to mix two MediaStreams in the browser.
    if (track.mediaStreamTrack) voStartAudioCapture(new MediaStream([track.mediaStreamTrack]), 'assistant');
  });
  room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const active = speakers || [];
    const agentSpeaking = active.some((p) => p.identity !== room.localParticipant.identity);
    const callerSpeaking = active.some((p) => p.identity === room.localParticipant.identity);
    if (callerSpeaking && !voLivekitCallerSpeechAt) {
      voLivekitCallerSpeechAt = Date.now();
      voLivekitCallerSpeechEndedAt = 0;
      voLivekitTurnFinalAt = 0;
      voLivekitSpeechEndLatencyLogged = false;
      voDiag('livekit', 'caller_speech_detected', { whileAssistant: !!voAdapterSpeaking });
    }
    if (voLivekitCallerSpeaking && !callerSpeaking) {
      voLivekitCallerSpeechEndedAt = Date.now();
      voDiag('livekit', 'caller_speech_ended', {});
      // If the transcript was already final before LiveKit published the
      // activity transition, the post-speech transcription latency is zero.
      if (voLivekitTurnFinalAt && !voLivekitSpeechEndLatencyLogged) {
        voLivekitSpeechEndLatencyLogged = true;
        voDiag('livekit', 'caller_speech_end_to_final_transcript', { ms: Math.max(0, voLivekitTurnFinalAt - voLivekitCallerSpeechEndedAt) });
      }
    }
    voLivekitCallerSpeaking = callerSpeaking;
    // This is a real barge-in candidate only if the assistant was already
    // speaking. The next no-agent event marks the audible cut-off. Keep the
    // pair even if the candidate later turns out to be a backchannel; that is
    // useful when tuning sensitivity and false-interrupt rates together.
    if (callerSpeaking && voAdapterSpeaking && !voLivekitBargeAt) {
      voLivekitBargeAt = Date.now();
      voDiag('livekit', 'barge_in_detected', {});
    }
    if (!agentSpeaking && voLivekitBargeAt) {
      const ms = Date.now() - voLivekitBargeAt;
      voDiag('livekit', 'barge_in_playback_stopped', { ms });
      voLivekitBargeAt = 0;
    }
    if (agentSpeaking && !voAdapterSpeaking) voDiag('livekit', 'assistant_playback_started', {});
    if (!agentSpeaking && voAdapterSpeaking) voDiag('livekit', 'assistant_playback_stopped', {});
    voAdapterSpeaking = agentSpeaking;
    voOrbMode(agentSpeaking ? 'speaking' : 'listening');
    if (agentSpeaking && voLivekitEndpointAt && !voLivekitPlaybackLogged) {
      const ms = Date.now() - voLivekitEndpointAt;
      voLivekitPlaybackLogged = true;
      voLatencies.push(ms);
      voDiag('livekit', 'endpoint_to_playback', { ms, transcriptChars: voLivekitEndpointText.length });
    }
    // True half-duplex: disable the same long-lived LiveKit mic track while
    // Cartesia plays. Previously this only called voApplyMic(), without ever
    // closing the gate, so TTS/road noise could keep the server VAD "speaking".
    if (agentSpeaking) voHalfDuplexClose();
    else voHalfDuplexScheduleReopen();
  });
  room.on(LK.RoomEvent.Reconnecting, () => { voSetState('reconnecting'); voDiag('livekit', 'reconnecting', {}); });
  room.on(LK.RoomEvent.Reconnected, () => { voSetState('live'); voDiag('livekit', 'reconnected', {}); });
  room.on(LK.RoomEvent.Disconnected, () => {
    if (voLivekitRoom !== room) return;
    voLivekitRoom = null;
    if (voState === 'live' || voState === 'reconnecting') voNotice('Voice connection ended. Tap Restart to reconnect.');
  });
  let localMicTrack = null;
  try {
    await room.connect(join.url, join.token);
    voDiag('livekit', 'startup_room_connected', { ms: Date.now() - startupAt });
    localMicTrack = await micPromise;
    await room.localParticipant.publishTrack(localMicTrack, { source: LK.Track.Source.Microphone });
    voDiag('livekit', 'startup_microphone_published', { ms: Date.now() - startupAt });
  } catch (error) {
    if (localMicTrack) { try { localMicTrack.stop(); } catch {} }
    else stopPendingMic();
    try { room.disconnect(); } catch {}
    throw error;
  }
  const micTrack = localMicTrack && localMicTrack.mediaStreamTrack;
  if (micTrack) {
    micTrack.enabled = !voMuted;
    voMicStream = new MediaStream([micTrack]);
  }
  if (micTrack) voStartAudioCapture(new MediaStream([micTrack]), 'caller');
  voSetState('live'); voConnectedAt = Date.now(); voBanner('');
  voNotice(`LiveKit adapter — ${cfg.agent || 'agent'} is ready. Deepgram transcribes live; pause naturally and it will hand off to Codex.`);
  voDiag('livekit', 'connected', { room: join.room || '', agent: join.agent || '', startup_ms: Date.now() - startupAt });
}
function voAdapterPcm16(f32, fromRate, toRate) {
  let data = f32;
  if (fromRate !== toRate) {
    const ratio = fromRate / toRate, len = Math.floor(f32.length / ratio), out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = f32[Math.floor(i * ratio)] || 0;
    data = out;
  }
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) { const s = Math.max(-1, Math.min(1, data[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return pcm.buffer;
}
function voAdapterNormText(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim(); }
function voAdapterSeal(text) {
  const seg = String(text || '').trim(); if (!seg) return;
  const prev = voAdapterCommitted.trim(), a = voAdapterNormText(prev), b = voAdapterNormText(seg);
  if (prev && b.startsWith(a)) voAdapterCommitted = seg;
  else if (!prev || !a.endsWith(b)) voAdapterCommitted = prev + (prev ? ' ' : '') + seg;
}
function voAdapterLiveTranscript() { return `${voAdapterCommitted} ${voAdapterPartial}`.replace(/\s+/g, ' ').trim(); }
function voAdapterPaintTranscript() {
  const text = voAdapterLiveTranscript();
  if (!voAdapterUserBubble) voAdapterUserBubble = voBubble('user', 'Listening…');
  voAdapterUserBubble.textContent = text || 'Listening…'; voScroll();
}
async function voAdapterStartStreamingStt() {
  if (!voMicStream || voAdapterSttWs || voAdapterBusy || voAdapterSpeaking) return;
  voAdapterCommitted = ''; voAdapterPartial = ''; voAdapterUserBubble = null;
  voAdapterAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  try { await voAdapterAudioCtx.resume(); } catch {}
  const native = voAdapterAudioCtx.sampleRate;
  const rate = [8000, 16000, 22050, 24000, 44100, 48000].includes(native) ? native : 16000;
  voAdapterSttSource = voAdapterAudioCtx.createMediaStreamSource(voMicStream);
  voAdapterAnalyser = voAdapterAudioCtx.createAnalyser(); voAdapterAnalyser.fftSize = 1024;
  voAdapterSttSource.connect(voAdapterAnalyser);
  voAdapterSttProc = voAdapterAudioCtx.createScriptProcessor(4096, 1, 1);
  voAdapterSttSink = voAdapterAudioCtx.createGain(); voAdapterSttSink.gain.value = 0;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/stt?token=${encodeURIComponent(TOKEN)}&rate=${rate}`);
  const pendingPcm = [];
  voAdapterSttWs = ws;
  ws.onopen = () => { while (pendingPcm.length && ws.readyState === WebSocket.OPEN) ws.send(pendingPcm.shift()); };
  ws.onmessage = (e) => {
    let o; try { o = JSON.parse(e.data); } catch { return; }
    if (o.type === 'partial') { voAdapterPartial = o.text || ''; voAdapterPaintTranscript(); return; }
    if (o.type === 'committed') { voAdapterSeal(o.text); voAdapterPartial = ''; voAdapterPaintTranscript(); return; }
    if (o.type === 'endpoint') {
      if (o.text) voAdapterSeal(o.text);
      voAdapterPartial = ''; voAdapterPaintTranscript();
      if (voAdapterEndpointT) clearTimeout(voAdapterEndpointT);
      voAdapterEndpointT = setTimeout(() => { voAdapterEndpointT = null; voAdapterSubmitText(voAdapterLiveTranscript()); }, 80);
      return;
    }
    if (o.type === 'error') voNotice('Streaming transcription error: ' + String(o.msg || '').slice(0, 120));
  };
  ws.onerror = () => voDiag('adapter', 'stream_stt_error', {});
  ws.onclose = () => {
    if (voAdapterSttWs !== ws) return;
    voAdapterSttWs = null;
    try { if (voAdapterSttProc) voAdapterSttProc.disconnect(); } catch {}
    try { if (voAdapterSttSource) voAdapterSttSource.disconnect(); } catch {}
    try { if (voAdapterSttSink) voAdapterSttSink.disconnect(); } catch {}
    voAdapterSttProc = voAdapterSttSource = voAdapterSttSink = null;
    try { if (voAdapterAudioCtx) voAdapterAudioCtx.close(); } catch {}
    voAdapterAudioCtx = null; voAdapterAnalyser = null;
    // Cellular tunnels can drop an idle socket; reconnect the STT side quietly while
    // the call is still in its listening half, never while a CLI turn/TTS is active.
    if (voState === 'live' && !voAdapterBusy && !voAdapterSpeaking) setTimeout(() => voAdapterStartStreamingStt().catch(() => {}), 500);
  };
  voAdapterSttProc.onaudioprocess = (ev) => {
    if (voAdapterBusy || voAdapterSpeaking) return;
    const pcm = voAdapterPcm16(ev.inputBuffer.getChannelData(0), native, rate);
    if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
    else if (ws.readyState === WebSocket.CONNECTING && pendingPcm.length < 25) pendingPcm.push(pcm);
  };
  voAdapterSttSource.connect(voAdapterSttProc); voAdapterSttProc.connect(voAdapterSttSink); voAdapterSttSink.connect(voAdapterAudioCtx.destination);
}
function voAdapterStopStreamingStt() {
  if (voAdapterEndpointT) { clearTimeout(voAdapterEndpointT); voAdapterEndpointT = null; }
  try { if (voAdapterSttWs && voAdapterSttWs.readyState <= WebSocket.OPEN) voAdapterSttWs.close(); } catch {}
  voAdapterSttWs = null;
  try { if (voAdapterSttProc) voAdapterSttProc.disconnect(); } catch {}
  try { if (voAdapterSttSource) voAdapterSttSource.disconnect(); } catch {}
  try { if (voAdapterSttSink) voAdapterSttSink.disconnect(); } catch {}
  voAdapterSttProc = voAdapterSttSource = voAdapterSttSink = null;
  try { if (voAdapterAudioCtx) voAdapterAudioCtx.close(); } catch {}
  voAdapterAudioCtx = null; voAdapterAnalyser = null;
}
function voAdapterLevel() {
  if (!voAdapterAnalyser) return 0;
  const data = new Uint8Array(voAdapterAnalyser.fftSize);
  voAdapterAnalyser.getByteTimeDomainData(data);
  let sum = 0; for (const v of data) { const d = (v - 128) / 128; sum += d * d; }
  return Math.sqrt(sum / data.length);
}
function voAdapterWatch() {
  const tick = () => {
    voAdapterRaf = requestAnimationFrame(tick);
    if (voMode !== 'adapter' || voState !== 'live' || voMuted || voAdapterBusy || voAdapterSpeaking) return;
    const now = Date.now(), vad = (voAdapterCfg && voAdapterCfg.vad) || {};
    const level = voAdapterLevel();
    const threshold = vad.threshold || 0.004;
    if (now - voAdapterLastVadDiagAt > 1000) {
      voAdapterLastVadDiagAt = now;
      voDiag('adapter', 'vad_level', { level: Math.round(level * 10000) / 10000, threshold, recording: !!voAdapterRecorder });
    }
    const loud = level >= threshold;
    if (loud) {
      voAdapterSilentAt = 0;
      if (!voAdapterRecorder) voAdapterBeginRecording();
      voOrbMode('listening');
    } else if (voAdapterRecorder) {
      if (!voAdapterSilentAt) voAdapterSilentAt = now;
      // A manual tap grants time to begin speaking even when the automatic detector
      // has not observed enough amplitude yet.
      if (now < voAdapterManualGraceUntil) return;
      const enough = now - voAdapterSpeechAt >= (vad.minSpeechMs || 350);
      if ((enough && now - voAdapterSilentAt >= (vad.silenceMs || 900)) || now - voAdapterSpeechAt >= 30000) voAdapterFinishRecording();
    }
  };
  tick();
}
function voAdapterManualRecord() {
  if (voAdapterTransport === 'livekit') {
    if (!voLivekitRoom || voLivekitCommitBusy || voMuted) return;
    voLivekitCommitBusy = true;
    voLivekitRoom.localParticipant.publishData(
      new TextEncoder().encode('{"type":"commit_turn"}'),
      { reliable: true, topic: 'box.voice.control' },
    ).then(() => {
      voNotice('Turn sent — finalizing the transcript for Codex.');
      voDiag('livekit', 'manual_turn_commit', {});
    }).catch(() => {
      voNotice('Could not send End turn. Keep speaking or tap once more.');
    }).finally(() => { setTimeout(() => { voLivekitCommitBusy = false; }, 1200); });
    return;
  }
  if (voAdapterBusy || voAdapterSpeaking || voMuted) return;
  // A deliberate tap means "end this turn now". Deepgram finalizes the buffered PCM
  // and returns the same endpoint event as natural end-of-speech.
  try { if (voAdapterSttWs && voAdapterSttWs.readyState === WebSocket.OPEN) voAdapterSttWs.send(JSON.stringify({ type: 'commit' })); } catch {}
}
function voAdapterBeginRecording() {
  if (!voMicStream || typeof MediaRecorder === 'undefined') return;
  try {
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    voAdapterChunks = []; voAdapterSpeechAt = Date.now(); voAdapterSilentAt = 0;
    voAdapterPreviewAt = 0; voAdapterPreviewInFlight = false; voAdapterPreviewSeq = 0;
    voAdapterUserBubble = voBubble('user', 'Listening…');
    voAdapterRecorder = new MediaRecorder(voMicStream, mimeType ? { mimeType } : undefined);
    voAdapterRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      voAdapterChunks.push(e.data);
      voAdapterPreview();
    };
    voAdapterRecorder.onstop = () => {
      const recorder = voAdapterRecorder; voAdapterRecorder = null; voAdapterManualGraceUntil = 0;
      const blob = new Blob(voAdapterChunks, { type: recorder && recorder.mimeType || 'audio/webm' });
      voAdapterChunks = [];
      if (blob.size > 200) voAdapterSubmit(blob);
    };
    // Timeslices let us transcribe the growing utterance and show an interim bubble;
    // they do not create CLI turns until VAD says the user has finished speaking.
    voAdapterRecorder.start(750);
  } catch (e) { voNotice('Microphone recording failed.'); voDiag('adapter', 'record_failed', { message: String(e && e.message || e).slice(0, 160) }); }
}
async function voAdapterPreview() {
  if (!voAdapterRecorder || voAdapterPreviewInFlight || voAdapterBusy) return;
  const now = Date.now();
  if (now - voAdapterPreviewAt < 900 || !voAdapterChunks.length) return;
  voAdapterPreviewAt = now; voAdapterPreviewInFlight = true;
  const seq = ++voAdapterPreviewSeq;
  try {
    const recorder = voAdapterRecorder;
    const blob = new Blob(voAdapterChunks, { type: recorder && recorder.mimeType || 'audio/webm' });
    const fd = new FormData(); fd.append('audio', blob, 'voice-preview.webm');
    const r = await api('/api/voice/adapter/transcribe', { method: 'POST', body: fd });
    const j = await r.json();
    // Ignore an older HTTP response after a later preview or the final turn started.
    if (seq !== voAdapterPreviewSeq || voAdapterBusy) return;
    if (j.text && voAdapterUserBubble) { voAdapterUserBubble.textContent = j.text; voScroll(); }
    voDiag('adapter', 'transcript_preview', { chars: String(j.text || '').length, stt: j.stt_model || '' });
  } catch (e) {
    // Preview is additive UX only; a failed preview must never prevent the final turn.
    voDiag('adapter', 'transcript_preview_failed', { message: String((e && e.message) || e).slice(0, 120) });
  } finally { voAdapterPreviewInFlight = false; }
}
function voAdapterFinishRecording() {
  try { if (voAdapterRecorder && voAdapterRecorder.state !== 'inactive') voAdapterRecorder.stop(); } catch {}
}
async function voAdapterSubmit(blob) {
  if (voAdapterBusy || voState !== 'live') return;
  voAdapterBusy = true; voAdapterPreviewSeq++; voOrbMode('thinking'); const chip = voChip(`Asking ${(voAdapterCfg && voAdapterCfg.agent) || 'agent'}…`);
  const started = Date.now();
  try {
    const fd = new FormData(); fd.append('audio', blob, 'voice-turn.webm'); fd.append('vsid', voVsid);
    const r = await api('/api/voice/adapter/turn', { method: 'POST', body: fd });
    const j = await r.json(); if (!r.ok && r.status !== 202) throw new Error(j.error || `adapter HTTP ${r.status}`);
    if (j.transcript) {
      if (voAdapterUserBubble) voAdapterUserBubble.textContent = j.transcript;
      else voAdapterUserBubble = voBubble('user', j.transcript);
      voScroll();
    }
    if (j.text) { voAsstText = j.text; voBubble('asst', j.text); voRememberAsst(j.text); }
    chip.classList.add('ok'); chip.querySelector('.voSpin').remove();
    voDiag('adapter', 'turn_done', { ms: Date.now() - started, stt: j.stt_model || '', agent: j.agent || '', pending: !!j.pending });
    if (j.audio) await voAdapterPlay(j.audio, j.mime || 'audio/mpeg');
    else if (j.text) await voAdapterBrowserSpeak(j.text);
  } catch (e) {
    chip.classList.add('fail'); chip.querySelector('.voSpin').remove();
    voNotice('Adapter error: ' + String((e && e.message) || e).slice(0, 180));
    voDiag('adapter', 'turn_failed', { message: String((e && e.message) || e).slice(0, 180) });
  } finally { voAdapterBusy = false; if (!voAdapterSpeaking) voOrbMode('listening'); }
}
async function voAdapterSubmitText(transcript) {
  const text = String(transcript || '').trim();
  if (!text || voAdapterBusy || voState !== 'live') return;
  voAdapterBusy = true; voAdapterStopStreamingStt(); voOrbMode('thinking'); const chip = voChip(`Asking ${(voAdapterCfg && voAdapterCfg.agent) || 'agent'}…`);
  const started = Date.now();
  try {
    const r = await api('/api/voice/adapter/text', { method: 'POST', body: JSON.stringify({ vsid: voVsid, text, stt_model: 'deepgram:streaming' }) });
    const j = await r.json(); if (!r.ok && r.status !== 202) throw new Error(j.error || `adapter HTTP ${r.status}`);
    if (voAdapterUserBubble) voAdapterUserBubble.textContent = j.transcript || text;
    if (j.text) { voAsstText = j.text; voBubble('asst', j.text); voRememberAsst(j.text); }
    chip.classList.add('ok'); chip.querySelector('.voSpin').remove();
    voDiag('adapter', 'stream_turn_done', { ms: Date.now() - started, agent: j.agent || '', pending: !!j.pending });
    if (j.audio) await voAdapterPlay(j.audio, j.mime || 'audio/mpeg');
    else if (j.text) await voAdapterBrowserSpeak(j.text);
  } catch (e) {
    chip.classList.add('fail'); chip.querySelector('.voSpin').remove();
    voNotice('Adapter error: ' + String((e && e.message) || e).slice(0, 180));
  } finally { voAdapterBusy = false; if (!voAdapterSpeaking) { voOrbMode('listening'); voAdapterStartStreamingStt().catch(() => {}); } }
}
async function voAdapterPlay(base64, mime) {
  voAdapterSpeaking = true; voOrbMode('speaking');
  const raw = atob(base64), bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    voAudioEl.srcObject = null; voAudioEl.src = url;
    await new Promise((resolve) => { voAudioEl.onended = resolve; voAudioEl.onerror = resolve; voAudioEl.play().catch(resolve); });
  } finally {
    URL.revokeObjectURL(url); voAudioEl.onended = null; voAudioEl.onerror = null;
    // Let the car-speaker tail drain before microphone VAD listens again.
    setTimeout(() => { voAdapterSpeaking = false; if (!voAdapterBusy && voState === 'live') { voOrbMode('listening'); voAdapterStartStreamingStt().catch(() => {}); } }, 600);
  }
}
async function voAdapterBrowserSpeak(text) {
  if (!('speechSynthesis' in window)) return;
  voAdapterSpeaking = true; voOrbMode('speaking');
  try {
    await new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1; utterance.onend = resolve; utterance.onerror = resolve;
      speechSynthesis.speak(utterance);
    });
  } finally {
    setTimeout(() => { voAdapterSpeaking = false; if (!voAdapterBusy && voState === 'live') { voOrbMode('listening'); voAdapterStartStreamingStt().catch(() => {}); } }, 600);
  }
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
    voAudioPolicy = { ...VO_AUDIO_POLICY_DEFAULT, ...(tok.audioPolicy || {}) };
    voDiag('pipeline', 'token_minted', { reconnect: !!isReconnect, model: tok.model || '', voice: tok.voice || '', halfDuplex: !!voAudioPolicy.halfDuplex, echoGuard: !!voAudioPolicy.echoGuard });
    voMemAudio = !!(tok.memory && tok.memory.storeAudio);

    // 2. mic (reused across reconnects)
    if (!voMicStream || !voMicStream.getAudioTracks().some((t) => t.readyState === 'live')) {
      voMicStream = await navigator.mediaDevices.getUserMedia({ audio: voMicConstraints() });
      const track = voMicStream.getAudioTracks()[0];
      voDiag('playback', 'mic_track', voTrackSettings(track));
    }
    voResetAudioGate(); voDropCurrentResponse = false; // fresh connection → mic open (subject to mute)
    voApplyMic();
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
  voResetAudioGate(); voDropCurrentResponse = false;
  voStopStats();
  voStopAudioCapture();
  voStopLivekitMicWarmup();
  if (voAdapterRaf) cancelAnimationFrame(voAdapterRaf);
  voAdapterRaf = 0;
  try { if (voAdapterRecorder && voAdapterRecorder.state !== 'inactive') voAdapterRecorder.stop(); } catch {}
  voAdapterRecorder = null; voAdapterChunks = []; voAdapterBusy = false; voAdapterSpeaking = false;
  voAdapterStopStreamingStt(); voAdapterCfg = null;
  // Telemetry: one summary line per call so self-interruption / misattribution rates are
  // queryable from the persisted diagnostics without a live session (see AC #4).
  voDiag('pipeline', 'audio_incident_summary', {
    selfInterrupt: voIncidents.selfInterrupt, misattribution: voIncidents.misattribution,
    halfDuplex: !!voAudioPolicy.halfDuplex, echoGuard: !!voAudioPolicy.echoGuard,
    durationMs: voStartedAt ? Date.now() - voStartedAt : 0,
  });
  voFlushEvents();
  // Tell the server the call ended so it indexes this session into cross-session memory
  // (a no-op there unless the owner has consented) and records the incident counts. Best-effort.
  if (voVsid) api('/api/voice/event', { method: 'POST', body: JSON.stringify({ vsid: voVsid, ended: true, incidents: voIncidents }) }).catch(() => {});
  if (voDc) { try { voDc.close(); } catch {} voDc = null; }
  if (voPc) { try { voPc.close(); } catch {} voPc = null; }
  if (voLivekitRoom) { try { voLivekitRoom.disconnect(); } catch {} voLivekitRoom = null; }
  if (voMicStream) { voMicStream.getTracks().forEach((t) => t.stop()); voMicStream = null; }
  if (voWakeLock) { try { voWakeLock.release(); } catch {} voWakeLock = null; }
  if (voOrbRaf) cancelAnimationFrame(voOrbRaf);
  if (voStartedAt) voNotice('Call ended.');
}

function voToggleMute() {
  voMuted = !voMuted;
  voApplyMic();   // compose with the half-duplex gate
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
    voDiag('api', 'speech_started', { activeResponse: !!voActiveResponse, assistantChars: voAsstText.length, micGateClosed: voMicGateClosed });
    // In half-duplex the mic is gated closed while we speak, so the VAD should not fire on
    // our own playback. Count a self-interruption candidate only when TTS is actually
    // playing (gate closed, or the assistant is already mid-sentence) — a speech_started
    // during the silent thinking/tool phase is a legitimate user interjection, not self-echo.
    if (voActiveResponse && (voMicGateClosed || voAsstText.length > 0)) {
      voIncidents.selfInterrupt++;
      voDiag('pipeline', 'self_interrupt_candidate', { micGateClosed: voMicGateClosed, halfDuplex: !!voAudioPolicy.halfDuplex, assistantChars: voAsstText.length });
    }
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
    if (String(ev.delta || '').trim()) { voClearFalseInterrupt(); voDropCurrentResponse = false; } // real words — genuine interruption
    let b = voUserItems.get(ev.item_id);
    if (!b) { b = voBubble('user', ''); voUserItems.set(ev.item_id, b); }
    b.textContent += ev.delta || '';
    voScroll();
    return;
  }
  if (t === 'conversation.item.input_audio_transcription.completed') {
    const transcript = String(ev.transcript || '').trim();
    if (globalThis.VoiceNotify && globalThis.VoiceNotify.isEmptyTranscript(transcript)) {
      const eb = voUserItems.get(ev.item_id);
      if (eb) { try { eb.remove(); } catch {} voUserItems.delete(ev.item_id); }
      if (ev.item_id) voSend({ type: 'conversation.item.delete', item_id: ev.item_id });
      voDiag('pipeline', 'empty_transcript_dropped', { itemId: ev.item_id || '', activeResponse: !!voActiveResponse });
      // Semantic VAD may already have auto-created a response to road noise. Cancel it;
      // the false-interrupt timer will resume any real answer that the noise cut off.
      if (voActiveResponse) {
        voDropCurrentResponse = true;
        voSend({ type: 'response.cancel' });
        voDiag('pipeline', 'empty_turn_response_cancelled', {});
      }
      // Confirmed noise — if a real answer was cut off and armed for recovery, resume it now.
      voResumeSoon('empty_turn');
      return;
    }
    // Misattribution guard: if this "user" turn is really our own TTS echoed back into
    // the mic, drop it and purge it from the model's context so it can't respond to
    // itself. Half-duplex normally prevents the echo reaching OpenAI at all; this catches
    // the onset window and covers barge-in mode where the mic stays hot.
    if (voIsSelfEcho(transcript)) {
      voIncidents.misattribution++;
      voDiag('pipeline', 'self_echo_dropped', { score: Math.round(voSelfEchoScore(transcript) * 100) / 100, chars: transcript.length });
      const eb = voUserItems.get(ev.item_id);
      if (eb) { try { eb.remove(); } catch {} voUserItems.delete(ev.item_id); }
      if (ev.item_id) voSend({ type: 'conversation.item.delete', item_id: ev.item_id });
      voResumeSoon('self_echo');  // confirmed our own echo — resume the cut-off answer promptly
      return;   // do NOT log it as a user turn or clear a false-interrupt recovery
    }
    voClearFalseInterrupt();
    voDropCurrentResponse = false;
    let b = voUserItems.get(ev.item_id);
    if (!b) { b = voBubble('user', ''); voUserItems.set(ev.item_id, b); }
    b.textContent = transcript;
    voEventBuf.push({ ts: Date.now(), kind: 'user', text: transcript });
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
    // Assistant TTS is now playing → gate the mic closed (half-duplex) so OpenAI can't
    // hear it. Idempotent, and cancels any pending re-open if audio resumes.
    voHalfDuplexClose();
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
    // Playback is winding down: re-open the mic after the tail hangover (jitter-buffer
    // drain) so we don't hear the last syllables of our own TTS as user speech.
    voHalfDuplexScheduleReopen();
    const turnCancelled = !!(globalThis.VoiceNotify && globalThis.VoiceNotify.isTurnDetectedCancellation(ev.response));
    // Barge-in cut this response. If the speech_started arming missed it (the cut landed
    // before >10 chars had streamed, or the events raced), arm recovery now from what we
    // had already spoken — so a FALSE interrupt (self-echo / road noise) still resumes
    // instead of the answer just stopping mid-sentence with nothing to resume from.
    if (turnCancelled && !voDropCurrentResponse && !voFalseInt.text && voAsstText && voAsstText.length > 10) {
      voFalseInt.text = voAsstText;
      if (voFalseInt.timer) clearTimeout(voFalseInt.timer);
      voFalseInt.timer = setTimeout(voResumeFalseInterrupt, 2800);
      voDiag('pipeline', 'false_interrupt_armed', { assistantChars: voAsstText.length, at: 'cancel' });
    }
    const suppressPartial = voDropCurrentResponse || (turnCancelled && !!voFalseInt.text);
    if (suppressPartial) {
      if (voAsstBubble) { try { voAsstBubble.remove(); } catch {} }
      voDiag('pipeline', 'partial_response_suppressed', { emptyTurn: !!voDropCurrentResponse, turnCancelled, chars: voAsstText.length });
      voAsstText = ''; voAsstBubble = null;
    } else if (voAsstText) {
      voRememberAsst(voAsstText);
      voEventBuf.push({ ts: Date.now(), kind: 'assistant', text: voAsstText });
      voAsstText = ''; voAsstBubble = null;
    }
    voDropCurrentResponse = false;
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
  linear_issue: 'Reading issue details…',
  needs_jimmy: 'Checking decisions…', web_search: 'Searching the web…', deep_research: 'Launching research…',
  check_tasks: 'Checking tasks…', brain_search: 'Searching the brain…', brain_read: 'Reading the brain…',
  get_briefing: 'Opening briefing…', take_note: 'Noting…', read_notes: 'Reading notes…',
  email_jimmy: 'Sending email…', calendar: 'Checking calendar…', think_hard: 'Thinking hard…',
  voice_memory: 'Updating memory…', file_access: 'Checking file access…',
};

/* ---------- false-interruption recovery (road noise cancels a reply → resume it) ---------- */

const voFalseInt = { timer: null, text: '' };
let voResumeTries = 0;
function voClearFalseInterrupt() {
  if (voFalseInt.timer) { clearTimeout(voFalseInt.timer); voFalseInt.timer = null; }
  voFalseInt.text = ''; voResumeTries = 0;
}
// Once we've POSITIVELY identified the interrupting turn as noise (empty transcript) or
// our own echo, there's no reason to sit in dead air for the full arming window — bring
// the resume forward so the answer picks back up quickly instead of feeling like it just
// stopped. (The slow 2.8s window stays for the "no transcript ever arrived" case.)
function voResumeSoon(reason) {
  if (!voFalseInt.text) return;
  if (voFalseInt.timer) clearTimeout(voFalseInt.timer);
  voFalseInt.timer = setTimeout(voResumeFalseInterrupt, 700);
  voDiag('pipeline', 'false_interrupt_resume_soon', { reason: reason || '' });
}
function voResumeFalseInterrupt() {
  voFalseInt.timer = null;
  if (!voFalseInt.text || !voDc || voDc.readyState !== 'open') { voFalseInt.text = ''; voResumeTries = 0; return; }
  // A response is active right now (the model already resumed on its own, or events
  // raced) — don't stack a second response; wait briefly and re-check, bounded so a
  // wedged state can never loop forever. Crucially, KEEP the resume text meanwhile so a
  // real cut-off answer isn't silently dropped just because the timing was tight.
  if (voActiveResponse) {
    if (voResumeTries++ < 6) { voFalseInt.timer = setTimeout(voResumeFalseInterrupt, 500); return; }
    voFalseInt.text = ''; voResumeTries = 0; return;
  }
  voResumeTries = 0;
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
      if (!(globalThis.VoiceNotify && globalThis.VoiceNotify.shouldSpeakUpdate(e))) {
        voDiag('pipeline', 'notify_silent', { kind: e.kind || '', title: String(e.title || '').slice(0, 80) });
        continue;
      }
      // Queue as an explicit SYSTEM event. The queue guarantees it is never delivered
      // mid-utterance and never fired as a user turn; the framing tells the model to
      // treat it as a system event, wait for a pause, summarize, and ask for his take.
      if (voNotifyQ) voNotifyQ.enqueue(
        `[TASK UPDATE — system event, NOT the user speaking] ${e.speak} `
        + `This was explicitly watched or is urgent. Mention it once with purpose, impact, and next step; do not ask a generic follow-up and do not switch to unrelated items.`,
        { kind: 'task_update' });
    }
  } catch {}
}

/* ---------- transcript persistence (powers reconnect context) ---------- */

async function voFlushEvents() {
  if (!voVsid || !voEventBuf.length || voFlushInFlight) return;
  const events = voEventBuf.splice(0, 50);
  voFlushInFlight = true;
  try {
    const response = await api('/api/voice/event', { method: 'POST', body: JSON.stringify({ vsid: voVsid, events }) });
    if (!response.ok) throw new Error('voice event upload failed');
  } catch {
    // Keep measurement ordering and retry on the next scheduled/boundary flush.
    voEventBuf.unshift(...events);
  } finally {
    voFlushInFlight = false;
    if (voEventBuf.length >= 40) voFlushEvents();
  }
}

/* ---------- opt-in audio capture (voice memory) ----------
 * WebRTC audio goes browser↔OpenAI directly — the server never sees it. So when the
 * owner has opted into audio storage, WE record the mic locally (MediaRecorder over the
 * same mic track) and POST timeslices to /api/voice/audio, letting a garbled transcript
 * be recovered from audio later. Gated on tok.memory.storeAudio — off by default. */
function voStartAudioCapture(stream = voMicStream, role = 'caller') {
  if (!voMemAudio || !stream || typeof MediaRecorder === 'undefined') return;
  const track = stream.getAudioTracks && stream.getAudioTracks()[0];
  if (!track || voAudioRecorders.some((r) => r.track === track)) return;
  try {
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const recording = { recorder, track, role, startedAt: Date.now() };
    voAudioRecorders.push(recording);
    if (role === 'caller' && !voRecorder) voRecorder = recorder;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) voUploadAudio(e.data, recording); };
    recorder.onstop = () => {
      voAudioRecorders = voAudioRecorders.filter((r) => r !== recording);
      if (voRecorder === recorder) voRecorder = null;
    };
    recorder.start(20000); // 20s chunks — bounded upload size, resilient to drops
    voDiag('recording', 'stream_started', { role });
  } catch (e) { console.warn('[voice] audio capture unavailable', e); }
}
function voStopAudioCapture() {
  for (const recording of voAudioRecorders) {
    try { if (recording.recorder.state !== 'inactive') recording.recorder.stop(); } catch {}
  }
  voAudioRecorders = []; voRecorder = null;
}
function voUploadAudio(blob, recording = null) {
  if (!voVsid) return;
  try {
    const fd = new FormData();
    fd.append('audio', blob, `chunk-${voRecSeq}.webm`);
    const qs = new URLSearchParams({ vsid: voVsid, seq: String(voRecSeq++) });
    if (recording) {
      qs.set('role', recording.role || 'caller');
      qs.set('started_at', String(recording.startedAt || Date.now()));
      qs.set('captured_at', String(Date.now()));
    }
    api(`/api/voice/audio?${qs}`, { method: 'POST', body: fd }).catch(() => {});
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
