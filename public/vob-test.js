/* VOB role-play room. This is intentionally separate from the normal Box voice
 * control: it creates a short-lived, case-scoped LiveKit room and never starts
 * or changes the real payer call. */
/* global api, cur, toast, esc */
(() => {
  const state = {
    catalog: null,
    room: null,
    mic: null,
    attached: [],
    segments: new Map(),
    startedAt: 0,
    connectedAtMs: 0,
    audioUnlockHandler: null,
    ended: false,
    timer: null,
  };

  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) => {
    if (typeof esc === 'function') return esc(value == null ? '' : String(value));
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  };
  const currentSessionId = () => (typeof cur !== 'undefined' && cur && cur.id ? String(cur.id) : '');
  const notify = (message) => { if (typeof toast === 'function') toast(message); else console.warn(message); };
  const json = async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  };
  const clock = (seconds) => {
    const n = Math.max(0, Number(seconds) || 0);
    return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  };

  function optionsHtml(items, selected, descriptions = false) {
    return (Array.isArray(items) ? items : []).map((item) => `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}>${escapeHtml(item.label || item.id)}${descriptions && item.description ? ` — ${escapeHtml(item.description)}` : ''}</option>`).join('');
  }

  function modalMarkup(catalog) {
    const defaults = catalog.defaults || {};
    return `<div class="vobTestModal" data-vob-test-modal role="dialog" aria-modal="true" aria-labelledby="vobTestTitle">
      <div class="vobTestPanel">
        <div class="vobTestHeader"><div><div class="vobEyebrow">VOB agent test mode</div><h2 id="vobTestTitle">Role-play this payer call</h2><p>The agent joins a private test room as the verification caller. You are the insurance representative and can answer the questions out loud.</p></div><button type="button" class="vobTestIcon" data-vob-test-close aria-label="Close">×</button></div>
        <form data-vob-test-form>
          <div class="vobTestGrid">
            <label>Production prompt<select name="promptPreset">${optionsHtml(catalog.prompts, defaults.promptPreset, true)}</select></label>
            <label>Production LiveKit model<select name="model">${optionsHtml(catalog.models, defaults.model, true)}</select></label>
            <label>Production Cartesia voice<select name="voice">${optionsHtml(catalog.voices, defaults.voice, true)}</select></label>
          </div>
          <div class="vobTestNotice"><strong>Production media contract.</strong> This room uses the same Gemma 4 31B IT model, Deepgram Flux transcription, and Cartesia Sonic 3.5 voice as a real payer call. The exact production caller prompt and this case’s current ledger are loaded as call context.</div>
          <div class="vobTestNotice"><strong>Safe test room.</strong> This does not place or modify a payer call. The agent receives a read-only snapshot of this case and the room expires automatically.</div>
          <div class="vobTestActions"><span class="vobTestStatus" data-vob-test-status>Ready to start</span><button type="button" class="vobClose" data-vob-test-close>Cancel</button><button type="submit" class="vobTestPrimary">Start role-play</button></div>
        </form>
        <section class="vobTestCall hidden" data-vob-test-call>
          <div class="vobTestCallHead"><div><strong>Live role-play</strong><span class="vobTestStatus" data-vob-test-live-status>Connecting…</span></div><button type="button" class="vobClose" data-vob-test-end>End test</button></div>
          <div class="vobTestTranscript" data-vob-test-transcript aria-live="polite"><div class="vobTestEmpty">The agent greeting will appear here.</div></div>
          <div class="vobTestCallFoot"><span class="vobTestTimer" data-vob-test-timer>0:00</span><span class="vobTestHint">You are role-playing the insurance representative.</span><button type="button" class="vobClose" data-vob-test-mute>Mute mic</button></div>
        </section>
      </div>
    </div>`;
  }

  function setStatus(text, live = false) {
    const target = byId('vobTestStatus') || document.querySelector('[data-vob-test-status]');
    if (target) target.textContent = text;
    const liveTarget = document.querySelector('[data-vob-test-live-status]');
    if (liveTarget) { liveTarget.textContent = text; liveTarget.classList.toggle('live', live); }
  }

  function removeModal() {
    document.querySelector('[data-vob-test-modal]')?.remove();
  }

  function stopAttached() {
    for (const element of state.attached.splice(0)) {
      try { element.pause(); } catch {}
      try { element.remove(); } catch {}
    }
  }

  function cleanup() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.audioUnlockHandler) {
      document.removeEventListener('pointerdown', state.audioUnlockHandler);
      state.audioUnlockHandler = null;
    }
    if (state.mic) { try { state.mic.stop(); } catch {} state.mic = null; }
    stopAttached();
    if (state.room) { try { state.room.disconnect(); } catch {} state.room = null; }
    state.segments.clear();
    state.startedAt = 0;
    state.connectedAtMs = 0;
  }

  function endCall(remove = true) {
    state.ended = true;
    cleanup();
    if (remove) removeModal();
  }

  function showCallPanel() {
    const form = document.querySelector('[data-vob-test-form]');
    const call = document.querySelector('[data-vob-test-call]');
    if (form) form.classList.add('hidden');
    if (call) call.classList.remove('hidden');
  }

  function segmentTime(segment) {
    if (typeof segment?.elapsedSec === 'number') return Math.max(0, segment.elapsedSec);
    if (segment?.createdAtMs && state.connectedAtMs) {
      const elapsed = (Number(segment.createdAtMs) - state.connectedAtMs) / 1000;
      if (Number.isFinite(elapsed)) return Math.max(0, elapsed);
    }
    const value = segment?.startTime ?? segment?.start ?? segment?.timestamp;
    if (typeof value === 'number') return value > 100000 ? (value / 1000) : value;
    if (value instanceof Date) return value.getTime() / 1000;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? (parsed > 100000 ? parsed / 1000 : parsed) : ((performance.now() - state.startedAt) / 1000);
  }

  function upsertTranscript(segments, participant, room) {
    const list = document.querySelector('[data-vob-test-transcript]');
    if (!list) return;
    for (const segment of (Array.isArray(segments) ? segments : [])) {
      const id = String(segment?.id || `${participant?.identity || 'agent'}-${segmentTime(segment)}-${segment?.text || ''}`);
      const local = !!room?.localParticipant && participant?.identity === room.localParticipant.identity;
      const rowData = { id, text: String(segment?.text || '').trim(), final: segment?.final !== false, local, start: Math.max(0, segmentTime(segment)) };
      if (!rowData.text) continue;
      state.segments.set(id, rowData);
      let row = [...list.children].find((candidate) => candidate.dataset?.vobSegment === id);
      if (!row) {
        row = document.createElement('div');
        row.dataset.vobSegment = id;
        list.append(row);
      }
      row.className = `vobTestTranscriptRow ${rowData.local ? 'caller' : 'agent'}${rowData.final ? '' : ' interim'}`;
      row.innerHTML = `<time>${clock(rowData.start)}</time><span class="vobTestSpeaker">${rowData.local ? 'You' : 'Agent'}</span><span class="vobTestText"></span>`;
      row.querySelector('.vobTestText').textContent = rowData.text;
    }
    const empty = list.querySelector('.vobTestEmpty');
    if (empty && state.segments.size) empty.remove();
    list.scrollTop = list.scrollHeight;
  }

  function handleDataPacket(payload, participant, room, topic) {
    if (topic && topic !== 'box-vob-transcript') return;
    let value = payload;
    try {
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) value = new TextDecoder().decode(value);
      if (ArrayBuffer.isView(value)) value = new TextDecoder().decode(value);
      if (typeof value !== 'string') return;
      value = JSON.parse(value);
    } catch { return; }
    if (!value || value.type !== 'transcript' || !value.text) return;
    upsertTranscript([{
      id: value.itemId || `${value.role || 'agent'}-${value.createdAtMs || Date.now()}`,
      text: value.text,
      final: value.final !== false,
      elapsedSec: Number.isFinite(Number(value.elapsedSec)) ? Number(value.elapsedSec) : undefined,
      createdAtMs: value.createdAtMs,
    }], participant, room);
  }

  function bindRoom(LK, room) {
    room.on(LK.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== LK.Track.Kind.Audio) return;
      const elements = track.attach();
      for (const element of (Array.isArray(elements) ? elements : [elements])) {
        if (!element) continue;
        element.autoplay = true;
        element.muted = false;
        element.setAttribute('aria-hidden', 'true');
        element.style.position = 'fixed';
        element.style.width = '1px';
        element.style.height = '1px';
        element.style.opacity = '0';
        element.style.pointerEvents = 'none';
        element.dataset.vobTestAudio = '1';
        document.body.append(element);
        state.attached.push(element);
        element.play().catch(() => {});
      }
    });
    room.on(LK.RoomEvent.TranscriptionReceived, (segments, participant) => upsertTranscript(segments, participant, room));
    if (LK.RoomEvent.DataReceived) {
      room.on(LK.RoomEvent.DataReceived, (payload, participant, _kind, topic) => handleDataPacket(payload, participant, room, topic));
    }
    room.on(LK.RoomEvent.Reconnecting, () => setStatus('Reconnecting…'));
    room.on(LK.RoomEvent.Reconnected, () => setStatus('Connected', true));
    room.on(LK.RoomEvent.Disconnected, () => {
      if (state.ended) return;
      state.room = null;
      if (state.mic) { try { state.mic.stop(); } catch {} state.mic = null; }
      setStatus('Disconnected — end the test and start again');
    });
  }

  function armAudioUnlock(room) {
    if (typeof room?.startAudio !== 'function' || state.audioUnlockHandler) return;
    state.audioUnlockHandler = async () => {
      if (state.room !== room) return;
      try {
        await room.startAudio();
        document.removeEventListener('pointerdown', state.audioUnlockHandler);
        state.audioUnlockHandler = null;
        setStatus('Connected', true);
      } catch {
        setStatus('Connected — tap the page to enable speaker', true);
      }
    };
    document.addEventListener('pointerdown', state.audioUnlockHandler);
  }

  async function startCall(form) {
    const LK = globalThis.LivekitClient;
    if (!LK || typeof LK.Room !== 'function') throw new Error('LiveKit client did not load; refresh once and try again');
    const sessionId = currentSessionId();
    if (!sessionId) throw new Error('Open a VOB session before starting a role-play');
    const values = Object.fromEntries(new FormData(form).entries());
    state.ended = false;
    try {
      // Request the microphone during the submit gesture. Mobile browsers can
      // reject a later getUserMedia call after the token/network awaits.
      setStatus('Requesting microphone…');
      state.mic = await LK.createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      setStatus('Preparing private room…');
      const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/vob/test/token`, { method: 'POST', body: JSON.stringify(values) });
      const join = await json(response);
      if (state.ended) throw new Error('Role-play cancelled');
      state.room = new LK.Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      bindRoom(LK, state.room);
      showCallPanel();
      setStatus('Connecting…');
      await state.room.connect(join.url, join.token);
      state.connectedAtMs = Date.now();
      state.startedAt = performance.now();
      let audioReady = true;
      if (typeof state.room.startAudio === 'function') {
        try { await state.room.startAudio(); }
        catch { audioReady = false; armAudioUnlock(state.room); }
      }
      await state.room.localParticipant.publishTrack(state.mic, { source: LK.Track.Source.Microphone });
      setStatus(audioReady ? 'Connected' : 'Connected — tap the page to enable speaker', true);
      const timer = document.querySelector('[data-vob-test-timer]');
      const updateTimer = () => { if (timer && state.startedAt) timer.textContent = clock((performance.now() - state.startedAt) / 1000); };
      updateTimer();
      state.timer = setInterval(updateTimer, 1000);
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async function openModal() {
    if (document.querySelector('[data-vob-test-modal]')) return;
    try {
      const catalog = state.catalog || await json(await api('/api/vob/test/options'));
      state.catalog = catalog;
      document.body.insertAdjacentHTML('beforeend', modalMarkup(catalog));
      const modal = document.querySelector('[data-vob-test-modal]');
      modal.querySelector('[data-vob-test-form]').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = modal.querySelector('.vobTestPrimary');
        button.disabled = true;
        try { await startCall(event.currentTarget); }
        catch (error) { setStatus(error.message || 'Could not start role-play'); notify(error.message || 'Could not start role-play'); button.disabled = false; }
      });
      modal.querySelector('[data-vob-test-mute]').addEventListener('click', (event) => {
        if (!state.mic) return;
        const muted = !state.mic.isMuted;
        state.mic.mute(muted);
        event.currentTarget.textContent = muted ? 'Unmute mic' : 'Mute mic';
      });
    } catch (error) { notify(error.message || 'Could not load VOB test settings'); }
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-vob-test-start]')) { openModal(); return; }
    if (event.target.closest('[data-vob-test-close]')) { endCall(true); return; }
    if (event.target.closest('[data-vob-test-end]')) { endCall(true); }
  });
  window.addEventListener('beforeunload', () => endCall(false));
})();
