/* GPT-Live client engine — shared by the Voice screen (global scope) and in-thread voice.
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

  function uid(prefix) {
    try { return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`; } catch { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }
  }

  function create(opts) {
    const o = opts || {};
    const api = o.api || ((path, init) => fetch(path, init));
    const noop = () => {};
    const onState = o.onState || noop, onCaption = o.onCaption || noop, onEvent = o.onEvent || noop;
    const onDelegation = o.onDelegation || noop, onClosed = o.onClosed || noop, onError = o.onError || noop;
    const onFunctionCall = o.onFunctionCall || null, onBackendEvent = o.onBackendEvent || noop;

    let pc = null, dc = null, mic = null, audioEl = null, state = 'idle', muted = false;
    let finalized = false, closeTimer = null, info = null, usageSeconds = 0;
    let outCtx = null, outAnalyser = null, outBuf = null, inAnalyser = null, inBuf = null;
    const segments = []; // { id, role, text, startMs, endMs, final }
    const pendingCalls = new Map(); // delegationId → { inFlight, continueQueued }

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
      const p = pendingCalls.get(delegationId) || { inFlight: 0 };
      p.inFlight++; pendingCalls.set(delegationId, p);
      let output;
      try { output = await onFunctionCall({ name: item.name, arguments: item.arguments, call_id: item.call_id, delegationId }); }
      catch (e) { output = JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) }); }
      if (typeof output !== 'string') output = JSON.stringify(output == null ? { ok: true } : output);
      send({ type: 'response.item.create', event_id: uid('evt'), item: { type: 'function_call_output', call_id: item.call_id, output } });
      p.inFlight--;
      // Continue the backend once every known call for this delegation has its result.
      if (p.inFlight <= 0) { pendingCalls.delete(delegationId); send({ type: 'response.create', event_id: uid('evt') }); }
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
            if (!finalized) teardown('connection_lost');
          }
        });
        mic = o.micStream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        for (const track of mic.getAudioTracks()) { track.enabled = !muted; pc.addTrack(track, mic); }
        dc = pc.createDataChannel('oai-events');
        dc.addEventListener('message', ({ data }) => { let ev; try { ev = JSON.parse(data); } catch { return; } handle(ev); });
        dc.addEventListener('close', () => { if (!finalized) teardown('connection_lost'); });
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

    function teardown(reason) {
      if (state === 'closed') return;
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
    }

    // Context appends (≤500 tokens each). delegationId null = session-wide.
    const clip = (t) => { const s = String(t || ''); return s.length > 1800 ? s.slice(0, 1790) + ' …' : s; };
    function commentary(delegationId, content) { return send({ type: 'session.commentary.append', event_id: uid('evt'), delegation_id: delegationId || null, content: clip(content) }); }
    function thinking(delegationId, content) { return send({ type: 'session.thinking.append', event_id: uid('evt'), delegation_id: delegationId || null, content: clip(content) }); }
    function instructions(content) { return send({ type: 'session.instructions.append', event_id: uid('evt'), delegation_id: null, content: clip(content) }); }

    return {
      start, close, setMuted, commentary, thinking, instructions, send,
      get state() { return state; }, get muted() { return muted; }, get info() { return info; },
      get usageSeconds() { return usageSeconds; }, get segments() { return segments; },
      outputLevel: () => levelOf(outAnalyser, outBuf), inputLevel: () => (muted ? 0 : levelOf(inAnalyser, inBuf)),
    };
  }

  window.LiveVoice = { create };
})();
