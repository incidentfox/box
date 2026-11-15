/* GPT-Live client engine + box-tool runner — shared by the Voice screen (global scope) and
 * in-thread voice (public/thread-voice.js).
 *
 * Browser mic ↔ OpenAI gpt-live-1 over WebRTC. The box server creates the session from
 * our SDP offer (POST /api/voice/live/session), so the API key never reaches the browser.
 * Events (transcripts, delegations, nested Responses events) arrive on the "oai-events"
 * data channel. GPT-Live is full duplex: it listens while it speaks, handles barge-in
 * itself, and hands real work to a backend ("delegation"):
 *   - client delegation  → onDelegation({ id, offsetMs }) — the caller does the work and
 *     answers with commentary(id, text) (spoken) / thinking(id, text) (silent context);
 *   - Responses delegation → OpenAI runs the backend model; each completed function call
 *     goes to onFunctionCall({ name, arguments, call_id, delegationId }) and its string
 *     result is returned with response.item.create + response.create.
 * Docs: developers.openai.com/api/docs/guides/voice-webrtc?api=live, …/live-delegation.
 */
(function () {
  const GAP_MS = 1400; // a pause longer than this starts a new caption segment
  const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

  function uid(prefix) {
    try { return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`; } catch { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }
  }

  // Parallel function calls (parallel_tool_calls: true): one backend turn can emit several
  // function_call items, and a fast tool may finish before the next item even arrives. So a
  // turn continues (response.create) only when ALL its calls have answered AND the backend
  // turn itself is done (response.completed/failed/incomplete). If that terminal event never
  // shows up, a fallback timer continues anyway so a call can't wedge the conversation.
  function createCallGate(o) {
    const onContinue = o.onContinue, fallbackMs = o.fallbackMs == null ? 3000 : o.fallbackMs;
    const setT = o.setTimer || ((f, ms) => setTimeout(f, ms)), clearT = o.clearTimer || ((t) => clearTimeout(t));
    const turns = new Map(); // delegationId → { inFlight, done, timer }
    function maybeContinue(id) {
      const t = turns.get(id);
      if (!t || t.inFlight > 0) return;
      if (t.timer) { clearT(t.timer); t.timer = null; }
      if (t.done) { turns.delete(id); onContinue(id); return; }
      t.timer = setT(() => { const c = turns.get(id); if (c && c.inFlight <= 0) { turns.delete(id); onContinue(id); } }, fallbackMs);
    }
    return {
      callStarted(id) {
        const t = turns.get(id) || { inFlight: 0, done: false, timer: null };
        if (t.timer) { clearT(t.timer); t.timer = null; }
        t.inFlight++; turns.set(id, t);
      },
      callFinished(id) { const t = turns.get(id); if (!t) return; t.inFlight--; maybeContinue(id); },
      // Only meaningful while this turn has calls; a final text-only turn has no entry.
      turnDone(id) { const t = turns.get(id); if (!t) return; t.done = true; maybeContinue(id); },
      pending(id) { const t = turns.get(id); return t ? t.inFlight : 0; },
    };
  }

  // Chip labels for the box voice tools (Voice screen + thread voice).
  const TOOL_LABELS = {
    get_overview: 'Checking the box…', list_sessions: 'Listing sessions…', check_session: 'Checking session…',
    send_to_session: 'Messaging agent…', start_agent: 'Starting agent…', delegate_ticket: 'Delegating ticket…',
    linear_board: 'Reading board…', linear_create: 'Creating issue…', linear_update: 'Updating issue…',
    linear_issue: 'Reading issue details…',
    needs_jimmy: 'Checking decisions…', web_search: 'Searching the web…', deep_research: 'Launching research…',
    check_tasks: 'Checking tasks…', brain_search: 'Searching the brain…', brain_read: 'Reading the brain…',
    get_briefing: 'Opening briefing…', take_note: 'Noting…', read_notes: 'Reading notes…',
    email_jimmy: 'Sending email…', calendar: 'Checking calendar…', think_hard: 'Thinking hard…',
    voice_memory: 'Updating memory…', file_access: 'Checking file access…',
    brain_save: 'Saving to the brain…', gmail_search: 'Checking email…', gmail_read: 'Opening email…',
    calendar_add: 'Adding to calendar…', needs_jimmy_resolve: 'Recording decision…',
    quick_lookup: 'Looking it up…', ask_thread_agent: 'Handing to the agent…',
  };
  const toolLabel = (name) => TOOL_LABELS[name] || String(name || 'tool');
  // Coding-agent display names — mirrors server/coding-agents.mjs (kept in sync by public/live-voice.test.mjs).
  const AGENT_LABELS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', agy: 'Antigravity', deepseek: 'DeepSeek', experiential: 'Experiential', mac: 'Computer Use' };
  const agentLabel = (id) => AGENT_LABELS[String(id || 'claude').toLowerCase()] || String(id);
  // Past-tense label once a tool finished (the pill resolves to this).
  const TOOL_DONE = {
    get_overview: 'Checked the box', list_sessions: 'Listed sessions', check_session: 'Checked session',
    send_to_session: 'Messaged agent', start_agent: 'Started agent', delegate_ticket: 'Delegated ticket',
    linear_board: 'Read the board', linear_create: 'Created issue', linear_update: 'Updated issue', linear_issue: 'Read issue details',
    needs_jimmy: 'Checked decisions', web_search: 'Searched the web', deep_research: 'Launched research', check_tasks: 'Checked tasks',
    brain_search: 'Searched the brain', brain_read: 'Read the brain', get_briefing: 'Opened briefing', take_note: 'Noted',
    read_notes: 'Read notes', email_jimmy: 'Sent email', calendar: 'Checked calendar', think_hard: 'Thought it through',
    voice_memory: 'Updated memory', file_access: 'Checked file access', brain_save: 'Saved to the brain', gmail_search: 'Checked email',
    gmail_read: 'Opened email', calendar_add: 'Calendar updated', needs_jimmy_resolve: 'Recorded decision',
    quick_lookup: 'Looked it up',
  };
  const toolDoneLabel = (name) => TOOL_DONE[name] || toolLabel(name).replace(/…$/, '');

  // How a tool call really went, from its output: 'ok' | 'warn' (some parts failed) | 'fail'.
  // A top-level {"error"} is a failure; a multi-part result (calendar: personal + work) whose
  // parts carry their own {"error"} — or an error string like "Token refresh failed" — is a
  // partial failure, or a failure when every part failed. `failedParts` names them.
  const ERRORISH = /^(token refresh failed|error:|failed:|invalid_grant)|^\{?\s*"error"\s*:/i;
  function toolOutcome(output) {
    let j;
    try { j = typeof output === 'string' ? JSON.parse(output) : output; } catch { return { outcome: /^\s*\{?\s*"?error/i.test(String(output)) ? 'fail' : 'ok', failedParts: [] }; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { outcome: 'ok', failedParts: [] };
    if (j.error != null && j.error !== false && j.error !== '') return { outcome: 'fail', failedParts: [] };
    const parts = Object.entries(j).filter(([, v]) => v != null && (typeof v === 'object' || typeof v === 'string'));
    const bad = parts.filter(([, v]) => (typeof v === 'string' ? ERRORISH.test(v.trim()) : !Array.isArray(v) && v.error != null && v.error !== false && v.error !== '')).map(([k]) => k);
    if (!bad.length) return { outcome: 'ok', failedParts: [] };
    const multi = parts.filter(([, v]) => typeof v === 'object' || typeof v === 'string').length;
    return { outcome: bad.length >= multi ? 'fail' : 'warn', failedParts: bad };
  }

  // Run one box voice tool server-side (POST /api/voice/tool). Never throws: a transport
  // failure becomes an {"error"} output the model can say out loud.
  async function runBoxTool(api, { name, args, call_id, vsid }) {
    const t0 = Date.now();
    let output;
    try {
      const r = await api('/api/voice/tool', { method: 'POST', body: JSON.stringify({ name, args, call_id, vsid: vsid || null }) });
      const j = await r.json();
      output = j.output || '{"error":"empty tool result"}';
    } catch (e) {
      output = JSON.stringify({ error: 'box unreachable: ' + String((e && e.message) || e).slice(0, 120) });
    }
    const { outcome, failedParts } = toolOutcome(output);
    return { output, outcome, failedParts, failed: outcome === 'fail', ms: Date.now() - t0 };
  }

  // ---- background / screen-off lifecycle (iOS web policy) ----
  // iOS does not let a web page keep capturing the mic or playing WebRTC audio while the screen
  // is locked or the app is in the background (no web API grants that; only a native app with
  // background-audio/VoIP entitlements can). So instead of fighting it with silent-audio or
  // keep-alive tricks, a call PAUSES when the page is hidden and RESUMES when it comes back.
  const HIDDEN_GRACE_MS = 3000; // a drop this soon after the page was hidden is the OS, not the network

  // Why a live connection died: 'backgrounded' (page hidden now or moments ago) or 'connection_lost'.
  function lostReason({ hidden = false, hiddenAt = 0, now = Date.now(), graceMs = HIDDEN_GRACE_MS } = {}) {
    if (hidden) return 'backgrounded';
    if (hiddenAt && now - hiddenAt <= graceMs) return 'backgrounded';
    return 'connection_lost';
  }

  // What a caller should do when a call's engine closed:
  //   'pause'     — backgrounded: keep the call, wait until visible, then resume (no budget used)
  //   'reconnect' — session cap / network drop with budget left
  //   'end'       — user stop, safety filter, failures, or budget exhausted
  function closeAction({ reason = '', stopping = false, reconnects = 0, maxReconnects = 3 } = {}) {
    if (stopping) return 'end';
    if (reason === 'backgrounded') return 'pause';
    if ((reason === 'expired' || reason === 'connection_lost') && reconnects < maxReconnects) return 'reconnect';
    return 'end';
  }

  // Run fn once the document is visible (now, or on the next visibilitychange/pageshow).
  // Returns a cancel function.
  function whenVisible(doc, fn) {
    let done = false;
    const fire = () => {
      if (done || !doc || doc.visibilityState !== 'visible') return;
      done = true; off();
      try { fn(); } catch {}
    };
    const off = () => {
      try { doc.removeEventListener('visibilitychange', fire); } catch {}
      try { (doc.defaultView || globalThis).removeEventListener('pageshow', fire); } catch {}
    };
    if (doc && doc.visibilityState === 'visible') { done = true; Promise.resolve().then(() => { try { fn(); } catch {} }); return () => {}; }
    try { doc.addEventListener('visibilitychange', fire); } catch {}
    try { (doc.defaultView || globalThis).addEventListener('pageshow', fire); } catch {}
    return () => { done = true; off(); };
  }

  // W3C Audio Session API (Safari 16.4+): 'play-and-record' is the category for a two-way call.
  // It does NOT enable background capture; it just makes routing/ducking right while visible.
  function setAudioSession(nav, type) {
    try { if (nav && nav.audioSession && 'type' in nav.audioSession) { nav.audioSession.type = type; return true; } } catch {}
    return false;
  }

  // Installed to the iPhone home screen — where locking/switching apps always stops the mic.
  function isIosStandalone(nav, win) {
    const ua = String((nav && nav.userAgent) || '');
    if (!/iPhone|iPad|iPod/.test(ua)) return false;
    if (nav && nav.standalone === true) return true;
    try { return !!(win && win.matchMedia && win.matchMedia('(display-mode: standalone)').matches); } catch { return false; }
  }
  const IOS_BACKGROUND_NOTICE = 'On iPhone, locking the screen or switching apps pauses voice; it resumes when you return.';

  function create(opts) {
    const o = opts || {};
    const api = o.api || ((path, init) => fetch(path, init));
    const noop = () => {};
    const onState = o.onState || noop, onCaption = o.onCaption || noop, onEvent = o.onEvent || noop;
    const onDelegation = o.onDelegation || noop, onClosed = o.onClosed || noop, onError = o.onError || noop;
    const onFunctionCall = o.onFunctionCall || null, onBackendEvent = o.onBackendEvent || noop;

    let pc = null, dc = null, mic = null, audioEl = null, state = 'idle', muted = false;
    let finalized = false, closeTimer = null, info = null, usageSeconds = 0;
    let hiddenAt = 0, visHandler = null, sender = null, recoveringMic = false;
    const doc = o.document || (typeof document !== 'undefined' ? document : null);
    const nav = o.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const dropReason = () => lostReason({ hidden: !!(doc && doc.visibilityState === 'hidden'), hiddenAt });
    let outCtx = null, outAnalyser = null, outBuf = null, inAnalyser = null, inBuf = null;
    const segments = []; // { id, role, text, startMs, endMs, final }
    const callGate = createCallGate({ onContinue: () => send({ type: 'response.create', event_id: uid('evt') }) });

    function setState(s) { state = s; try { onState(s); } catch {} }
    function send(obj) {
      if (!dc || dc.readyState !== 'open') return false;
      try { dc.send(JSON.stringify(obj)); return true; } catch { return false; }
    }

    // ---- captions ----
    function finalize(seg) {
      if (!seg || seg.final) return;
      seg.final = true;
      try { onCaption({ ...seg }); } catch {}
    }
    function addDelta(role, ev) {
      const delta = String(ev.delta || '');
      if (!delta) return;
      const start = Number(ev.start_ms) || 0, end = Number(ev.end_ms) || start;
      let seg = null;
      for (let i = segments.length - 1; i >= 0; i--) { if (segments[i].role === role) { seg = segments[i]; break; } }
      const otherSpokeSince = seg && segments.indexOf(seg) < segments.length - 1;
      if (!seg || seg.final || start - seg.endMs > GAP_MS || otherSpokeSince) {
        // Close this role's previous segment before opening a new one.
        if (seg && !seg.final) finalize(seg);
        seg = { id: uid('seg'), role, text: '', startMs: start, endMs: end, final: false };
        segments.push(seg);
        if (segments.length > 400) segments.splice(0, segments.length - 400);
      }
      seg.text += delta; seg.endMs = Math.max(seg.endMs, end);
      try { onCaption({ ...seg }); } catch {}
    }
    // Close idle segments so a reply/turn can be persisted without waiting for the next one.
    let idleIv = null;
    let lastEventAt = 0;
    function startIdleSweep() {
      idleIv = setInterval(() => {
        if (Date.now() - lastEventAt < 1800) return;
        for (const s of segments) if (!s.final) finalize(s);
      }, 700);
    }

    // ---- Responses delegation: function calls ----
    async function runFunctionCall(delegationId, item) {
      callGate.callStarted(delegationId);
      let output;
      try { output = await onFunctionCall({ name: item.name, arguments: item.arguments, call_id: item.call_id, delegationId }); }
      catch (e) { output = JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) }); }
      if (typeof output !== 'string') output = JSON.stringify(output == null ? { ok: true } : output);
      send({ type: 'response.item.create', event_id: uid('evt'), item: { type: 'function_call_output', call_id: item.call_id, output } });
      callGate.callFinished(delegationId);
    }

    function handle(ev) {
      lastEventAt = Date.now();
      try { onEvent(ev); } catch {}
      switch (ev.type) {
        case 'session.started':
          setState('live');
          break;
        case 'session.input_transcript.delta': addDelta('user', ev); break;
        case 'session.output_transcript.delta': addDelta('assistant', ev); break;
        case 'session.delegation.created': {
          const d = ev.delegation || {};
          try { onDelegation({ id: d.id, target: d.target, offsetMs: Number(ev.offset_ms) || 0, responseId: d.response_id || ev.response_id || null }); } catch {}
          break;
        }
        case 'response.event': {
          const inner = ev.event || {};
          try { onBackendEvent(inner, ev.delegation_id); } catch {}
          if (inner.type === 'response.output_item.done' && inner.item && inner.item.type === 'function_call' && onFunctionCall) {
            runFunctionCall(ev.delegation_id, inner.item);
          } else if (inner.type === 'response.completed' || inner.type === 'response.failed' || inner.type === 'response.incomplete') {
            callGate.turnDone(ev.delegation_id);
          }
          break;
        }
        case 'session.usage.updated':
          usageSeconds = Number(ev.usage && ev.usage.seconds) || usageSeconds;
          break;
        case 'session.closed':
          finalized = true;
          usageSeconds = Number(ev.usage && ev.usage.seconds) || usageSeconds;
          teardown(ev.reason || 'closed');
          break;
        case 'error':
          try { onError(ev.error || {}); } catch {}
          break;
        default: break;
      }
    }

    function levelOf(analyser, buf) {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
    }
    function attachAnalysers(remoteStream) {
      try {
        outCtx = outCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (remoteStream) {
          const src = outCtx.createMediaStreamSource(remoteStream);
          outAnalyser = outCtx.createAnalyser(); outAnalyser.fftSize = 512; outBuf = new Uint8Array(outAnalyser.fftSize);
          src.connect(outAnalyser);
        }
        if (mic && !inAnalyser) {
          const ms = outCtx.createMediaStreamSource(mic);
          inAnalyser = outCtx.createAnalyser(); inAnalyser.fftSize = 512; inBuf = new Uint8Array(inAnalyser.fftSize);
          ms.connect(inAnalyser);
        }
      } catch {}
    }

    async function start(body) {
      if (state === 'connecting' || state === 'live') return info;
      finalized = false; setState('connecting');
      try {
        pc = new RTCPeerConnection();
        audioEl = o.audioEl || new Audio();
        audioEl.autoplay = true; audioEl.setAttribute('playsinline', '');
        pc.addEventListener('track', (event) => {
          const stream = new MediaStream([event.track]);
          audioEl.srcObject = stream;
          audioEl.play().catch(() => {});
          attachAnalysers(stream);
        });
        pc.addEventListener('connectionstatechange', () => {
          if (!pc) return;
          if (pc.connectionState === 'failed' || (pc.connectionState === 'disconnected' && state === 'live')) {
            if (!finalized) teardown(dropReason());
          }
        });
        setAudioSession(nav, 'play-and-record'); // before capture starts
        mic = o.micStream || await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        for (const track of mic.getAudioTracks()) { track.enabled = !muted; sender = pc.addTrack(track, mic); }
        watchVisibility();
        setupMediaSession();
        dc = pc.createDataChannel('oai-events');
        dc.addEventListener('message', ({ data }) => { let ev; try { ev = JSON.parse(data); } catch { return; } handle(ev); });
        dc.addEventListener('close', () => { if (!finalized) teardown(dropReason()); });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (pc.iceGatheringState !== 'complete') {
          await new Promise((resolve) => {
            const t = setTimeout(done, 3000); // a partial candidate set still connects
            function done() { clearTimeout(t); pc && pc.removeEventListener('icegatheringstatechange', onIce); resolve(); }
            function onIce() { if (pc && pc.iceGatheringState === 'complete') done(); }
            pc.addEventListener('icegatheringstatechange', onIce);
          });
        }
        const r = await api('/api/voice/live/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(body || {}), sdp: pc.localDescription.sdp }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.transport) throw new Error(j.error || `live session HTTP ${r.status}`);
        info = j;
        await pc.setRemoteDescription({ type: 'answer', sdp: j.transport.sdp });
        startIdleSweep();
        return info;
      } catch (e) {
        teardown('start_failed');
        throw e;
      }
    }

    // ---- page visibility: remember when we were hidden; on return, recover an ended mic ----
    function watchVisibility() {
      if (!doc || visHandler) return;
      visHandler = () => {
        if (doc.visibilityState === 'hidden') { hiddenAt = Date.now(); try { onEvent({ type: 'client.page_hidden' }); } catch {} return; }
        try { onEvent({ type: 'client.page_visible', hidden_ms: hiddenAt ? Date.now() - hiddenAt : 0 }); } catch {}
        recoverMicIfEnded();
      };
      doc.addEventListener('visibilitychange', visHandler);
    }
    // iOS may END the capture track while the page is hidden even when the session survives
    // (Safari tab). Re-acquire it and swap it into the same sender — no new session needed.
    async function recoverMicIfEnded() {
      if (o.micStream || !mic || !sender || recoveringMic || (state !== 'live' && state !== 'connecting')) return false;
      const t = mic.getAudioTracks()[0];
      if (t && t.readyState !== 'ended') return false;
      recoveringMic = true;
      try {
        const fresh = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        const nt = fresh.getAudioTracks()[0];
        if (!pc || !nt) { fresh.getTracks().forEach((x) => x.stop()); return false; }
        nt.enabled = !muted;
        await sender.replaceTrack(nt);
        try { mic.getTracks().forEach((x) => x.stop()); } catch {}
        mic = fresh; inAnalyser = null; attachAnalysers(null);
        try { onEvent({ type: 'client.mic_recovered' }); } catch {}
        return true;
      } catch (e) {
        try { onError({ code: 'mic_recover_failed', message: String((e && e.message) || e).slice(0, 160) }); } catch {}
        return false;
      } finally { recoveringMic = false; }
    }
    // Lock-screen / Control Center metadata, and the mic toggle where Safari supports it (18.4+).
    function setupMediaSession() {
      const ms = nav && nav.mediaSession;
      if (!ms) return;
      try { if (typeof MediaMetadata !== 'undefined') ms.metadata = new MediaMetadata({ title: 'Box voice', artist: 'Live call' }); } catch {}
      try {
        // The page owns mute UI; let it toggle (falls back to the engine's own mute).
        ms.setActionHandler('togglemicrophone', () => { try { if (o.onMuteToggle) o.onMuteToggle(); else setMuted(!muted); } catch {} });
        if (typeof ms.setMicrophoneActive === 'function') ms.setMicrophoneActive(!muted);
      } catch {} // unsupported action → ignore
    }
    function clearMediaSession() {
      const ms = nav && nav.mediaSession;
      if (!ms) return;
      try { ms.setActionHandler('togglemicrophone', null); } catch {}
      try { ms.metadata = null; } catch {}
    }

    function teardown(reason) {
      if (state === 'closed') return;
      if (visHandler && doc) { try { doc.removeEventListener('visibilitychange', visHandler); } catch {} visHandler = null; }
      clearMediaSession();
      setAudioSession(nav, 'auto');
      sender = null;
      clearTimeout(closeTimer); closeTimer = null;
      if (idleIv) { clearInterval(idleIv); idleIv = null; }
      for (const s of segments) if (!s.final) finalize(s);
      const c = dc; dc = null; try { c && c.close(); } catch {}
      try { pc && pc.close(); } catch {} pc = null;
      if (mic && !o.micStream) mic.getTracks().forEach((t) => t.stop());
      mic = null;
      if (audioEl) { try { audioEl.srcObject = null; } catch {} }
      try { outCtx && outCtx.close(); } catch {}
      outCtx = outAnalyser = inAnalyser = null;
      setState('closed');
      try { onClosed({ reason, usageSeconds, finalized }); } catch {}
    }

    // Graceful close: session.close, then wait for session.closed (final usage).
    function close() {
      if (state === 'closed' || state === 'idle') return;
      if (!send({ type: 'session.close', event_id: uid('evt') })) return teardown('close_requested');
      setState('closing');
      closeTimer = setTimeout(() => teardown('close_timeout'), 6000);
    }

    function setMuted(m) {
      muted = !!m;
      if (mic) mic.getAudioTracks().forEach((t) => { t.enabled = !muted; });
      try { if (nav && nav.mediaSession && typeof nav.mediaSession.setMicrophoneActive === 'function') nav.mediaSession.setMicrophoneActive(!muted); } catch {}
    }

    // Context appends (≤500 tokens each). delegationId null = session-wide.
    const clip = (t) => { const s = String(t || ''); return s.length > 1800 ? s.slice(0, 1790) + ' …' : s; };
    function commentary(delegationId, content) { return send({ type: 'session.commentary.append', event_id: uid('evt'), delegation_id: delegationId || null, content: clip(content) }); }
    function thinking(delegationId, content) { return send({ type: 'session.thinking.append', event_id: uid('evt'), delegation_id: delegationId || null, content: clip(content) }); }
    function instructions(content) { return send({ type: 'session.instructions.append', event_id: uid('evt'), delegation_id: null, content: clip(content) }); }

    return {
      start, close, setMuted, commentary, thinking, instructions, send, recoverMicIfEnded,
      get state() { return state; }, get muted() { return muted; }, get info() { return info; },
      get usageSeconds() { return usageSeconds; }, get segments() { return segments; },
      outputLevel: () => levelOf(outAnalyser, outBuf), inputLevel: () => (muted ? 0 : levelOf(inAnalyser, inBuf)),
    };
  }

  window.LiveVoice = {
    create, createCallGate, runBoxTool, toolLabel, toolDoneLabel, toolOutcome, TOOL_LABELS, agentLabel, AGENT_LABELS,
    lostReason, closeAction, whenVisible, setAudioSession, isIosStandalone, IOS_BACKGROUND_NOTICE, HIDDEN_GRACE_MS,
  };
})();
