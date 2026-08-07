/* VOB role-play room. This is intentionally separate from the normal Box voice
 * control: it creates a short-lived, case-scoped LiveKit room and never starts
 * or changes the real payer call. */
/* global api, cur, toast, esc */
(() => {
  const state = {
    catalog: null,
    config: null,
    testId: '',
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
        <div class="vobTestHeader"><div><div class="vobEyebrow">VOB agent test mode</div><h2 id="vobTestTitle">Test the live representative phase</h2><p>The same production VOB caller joins a private room after IVR and hold are complete. Choose the guarded production pipeline or a prompt-only iteration lane, then answer as the insurance representative.</p></div><button type="button" class="vobTestIcon" data-vob-test-close aria-label="Close">×</button></div>
        <form data-vob-test-form>
          <div class="vobTestGrid">
            <label>Test lane mode / prompt<select name="promptPreset">${optionsHtml(catalog.prompts, defaults.promptPreset, true)}</select></label>
            <label>Production LiveKit model<select name="model">${optionsHtml(catalog.models, defaults.model, true)}</select></label>
            <label>Production Cartesia voice<select name="voice">${optionsHtml(catalog.voices, defaults.voice, true)}</select></label>
          </div>
          <label class="vobTestPrompt">Private test-lane prompt<small>Starts with the exact production prompt. Edits are isolated to this ephemeral room and apply when it restarts.</small><textarea name="promptText" rows="14">${escapeHtml(catalog.productionPrompt?.baseText || '')}</textarea></label>
          <div class="vobTestNotice"><strong>Same production caller.</strong> Both lanes use the production Gemma 4 31B IT model, Deepgram Flux transcription, Cartesia Sonic 3.5 voice, and the same provider-side caller prompt. The case packet is injected as LiveKit context variables.</div>
          <div class="vobTestNotice"><strong>Pipeline choice.</strong> Production guarded runs the deterministic extractor, validator, ledger update, and close gate. Prompt-only iteration runs one caller prompt and intentionally skips those postprocessors.</div>
          <div class="vobTestNotice"><strong>Human representative phase.</strong> IVR routing and hold music are skipped. The caller starts as if a live payer representative has just answered, so you can evaluate introductions, evidence questions, and follow-up behavior.</div>
          <div class="vobTestNotice"><strong>Safe test room.</strong> This does not place or modify a payer call. The agent receives a read-only snapshot of this case and the room expires automatically.</div>
          <div class="vobTestActions"><span class="vobTestStatus" data-vob-test-status>Ready to start</span><button type="button" class="vobClose" data-vob-test-close>Cancel</button><button type="submit" class="vobTestPrimary">Start human-phase test</button></div>
        </form>
        <section class="vobTestCall hidden" data-vob-test-call>
          <div class="vobTestCallHead"><div><strong>Live production caller</strong><span class="vobTestStatus" data-vob-test-live-status>Connecting…</span></div><button type="button" class="vobClose" data-vob-test-end>End test</button></div>
          <div class="vobTestCallBody"><div class="vobTestTranscript" data-vob-test-transcript aria-live="polite"><div class="vobTestEmpty">Say hello as the insurance representative to begin.</div></div><aside class="vobTestInspector" data-vob-test-inspector><div class="vobTestEmpty">Loading test context…</div></aside></div>
          <div class="vobTestCallFoot"><span class="vobTestTimer" data-vob-test-timer>0:00</span><span class="vobTestHint">You are the live insurance representative.</span><button type="button" class="vobClose" data-vob-test-mute>Mute mic</button></div>
        </section>
      </div>
    </div>`;
  }

  function configValue(value, fallback = '—') {
    return value == null || value === '' ? fallback : String(value);
  }

  function configRows(rows, empty = 'No values available.') {
    const list = Array.isArray(rows) ? rows.filter((row) => row && row.key) : [];
    if (!list.length) return `<div class="vobTestEmpty">${escapeHtml(empty)}</div>`;
    return `<div class="vobTestDataRows">${list.map((row) => `<div class="vobTestDataRow"><code>${escapeHtml(row.key)}</code><span>${escapeHtml(configValue(row.value, 'Not captured yet'))}</span><small>${escapeHtml(row.status || 'unknown')}</small></div>`).join('')}</div>`;
  }

  function configSection(title, body, open = true) {
    return `<details class="vobTestConfigSection"${open ? ' open' : ''}><summary>${escapeHtml(title)}</summary><div class="vobTestConfigContent">${body}</div></details>`;
  }

  function pipelineJson(value) {
    try { return JSON.stringify(value || {}, null, 2); } catch { return '{}'; }
  }

  function pipelineStageMarkup(stage, open = false) {
    if (!stage) return '';
    const isLlm = stage.kind === 'llm';
    const schema = stage.output?.schema ? `<div class="vobPipelineCodeLabel">Structured output schema</div><pre class="vobPipelineCode">${escapeHtml(pipelineJson(stage.output.schema))}</pre>` : '';
    const prompt = stage.promptTemplate ? `<div class="vobPipelineCodeLabel">Prompt template</div><pre class="vobPipelineCode">${escapeHtml(stage.promptTemplate)}</pre>` : '';
    const rules = Array.isArray(stage.rules) && stage.rules.length ? `<div class="vobPipelineCodeLabel">Deterministic rules</div><ul class="vobPipelineRules">${stage.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('')}</ul>` : '';
    const statuses = Array.isArray(stage.statuses) && stage.statuses.length ? `<div class="vobPipelineCodeLabel">Ledger statuses</div><div class="vobPipelineStatuses">${stage.statuses.map((status) => `<span>${escapeHtml(status)}</span>`).join('')}</div>` : '';
    const closeGate = stage.closeGate ? `<div class="vobPipelineCodeLabel">Close gate</div><div class="vobPipelineMeta"><span><b>Modes</b> ${escapeHtml((stage.closeGate.modes || []).join(' · '))}</span><span><b>Checks</b> ${escapeHtml((stage.closeGate.fields || []).join(' · '))}</span></div>` : '';
    const noPrompt = !isLlm ? '<div class="vobPipelineNoPrompt">No LLM prompt — deterministic code runs after the model/transcript and can override or block it.</div>' : '';
    const output = stage.output ? `<div class="vobPipelineMeta"><span><b>Output</b> ${escapeHtml(stage.output.name || 'structured output')} · ${stage.output.strict ? 'strict schema' : 'schema'}</span></div>` : '';
    return `<details class="vobPipelineCard"${open ? ' open' : ''}><summary><span><strong>${escapeHtml(stage.title || 'Pipeline stage')}</strong><small>${escapeHtml(stage.kind || '')}</small></span><em class="vobPipelineBadge ${isLlm ? 'llm' : 'deterministic'}">${isLlm ? 'LLM' : 'CODE'}</em></summary><div class="vobPipelineCardBody"><div class="vobPipelineMeta"><span><b>Source</b> ${escapeHtml(stage.source || '—')}</span>${stage.model ? `<span><b>Model</b> ${escapeHtml(stage.model)}</span>` : ''}${stage.controlModel ? `<span><b>Control model</b> ${escapeHtml(stage.controlModel)}</span>` : ''}${stage.mediaModel ? `<span><b>Media model</b> ${escapeHtml(stage.mediaModel)}</span>` : ''}${stage.mediaContract ? `<span><b>Media</b> ${escapeHtml(stage.mediaContract)}</span>` : ''}${stage.promptRef ? `<span><b>Prompt</b> ${escapeHtml(stage.promptRef.version || 'production')} · ${escapeHtml(stage.promptRef.source || '')}</span>` : ''}</div><p class="vobPipelineExplain">${escapeHtml(stage.explanation || '')}</p>${noPrompt}${output}${prompt}${schema}${rules}${statuses}${closeGate}</div></details>`;
  }

  function pipelineMarkup(pipeline, pipelineModes) {
    const modes = Object.values(pipelineModes || {}).length
      ? Object.values(pipelineModes)
      : (pipeline ? [{ id: 'current', label: 'Current pipeline', description: '', pipeline }] : []);
    if (!modes.length) return '<div class="vobTestEmpty">Pipeline metadata is not available for this test.</div>';
    const cards = modes.map((mode, modeIndex) => {
      const current = mode.pipeline || mode;
      const stages = [current.caller, current.extractor, current.runtimeEvidence, current.validator, current.ledger].filter(Boolean);
      const removed = Array.isArray(mode.removedStages) && mode.removedStages.length
        ? `<div class="vobPipelineRemoved"><b>Not run:</b> ${escapeHtml(mode.removedStages.join(' · '))}</div>` : '';
      const guarded = Array.isArray(mode.deterministicStages) && mode.deterministicStages.length;
      return `<article class="vobPipelineMode"><div class="vobPipelineModeHead"><div><strong>${escapeHtml(mode.label || mode.id || 'Pipeline')}</strong><p>${escapeHtml(mode.description || '')}</p></div><span class="vobPill">${guarded ? 'guarded' : 'prompt only'}</span></div><div class="vobPipelineIntro"><span><b>Version</b> ${escapeHtml(current.version || '—')}</span><span>${guarded ? 'LLM proposals are validated before evidence can close.' : 'One LiveKit caller prompt; no deterministic postprocessor runs.'}</span></div>${removed}<div class="vobPipelineGrid">${stages.map((stage, index) => pipelineStageMarkup(stage, modeIndex === 0 && index < 2)).join('')}</div></article>`;
    }).join('');
    return configSection('Decision pipeline modes · production guardrails and prompt-only test lane', cards, false);
  }

  function renderTestInspector(config) {
    const target = document.querySelector('[data-vob-test-inspector]');
    if (!target) return;
    if (!config) { target.innerHTML = '<div class="vobTestEmpty">Test context is not available yet.</div>'; return; }
    const runtime = config.productionRuntime || {};
    const settings = config.settings || {};
    const data = config.testData || {};
    const contextVariables = config.contextVariables || data.contextVariables || {};
    const contextRows = Object.entries(contextVariables).map(([key, value]) => ({ key, value, status: 'LiveKit context' }));
    const runtimeRows = [
      ['Lane', config.pipelineMode === 'prompt_only' || settings.promptPreset === 'prompt_only' ? 'Prompt-only iteration' : 'Production guarded'],
      ['Prompt', config.productionPrompt?.label || config.productionPrompt?.id || configValue(settings.promptPreset)],
      ['Prompt source', config.productionPrompt?.source || 'production'],
      ['LLM', `${runtime.llmProvider || 'livekit'} / ${runtime.llmModel || runtime.model || configValue(settings.model)}`],
      ['STT', `${runtime.sttProvider || 'deepgram'} / ${runtime.sttModel || '—'}`],
      ['TTS', `${runtime.ttsProvider || 'cartesia'} / ${runtime.ttsModel || '—'}`],
      ['Voice', runtime.ttsVoice || runtime.voice || configValue(settings.voice)],
      ['Starting state', config.initialCallState || 'human_rep'],
    ].map(([key, value]) => ({ key, value, status: 'production' }));
    const facts = Array.isArray(data.facts) ? data.facts : [];
    const packetFacts = Array.isArray(data.packetFacts) ? data.packetFacts : [];
    const calls = Array.isArray(data.ledger) ? data.ledger : [];
    const promptEditor = config.promptEditor || {};
    const promptText = promptEditor.baseText || config.instructions || '';
    const compiledPrompt = promptEditor.compiledText || config.instructions || '';
    const promptMeta = [
      ['Version', promptEditor.version || config.productionPrompt?.version || '—'],
      ['Source', promptEditor.source || config.productionPrompt?.source || 'production'],
      ['Lane', `${config.pipelineMode === 'prompt_only' ? 'prompt-only iteration' : 'production guarded'}${promptEditor.overrideActive ? ' · private override' : ''}`],
    ].map(([key, value]) => `<span><b>${escapeHtml(key)}</b> ${escapeHtml(value)}</span>`).join('');
    const callsMarkup = calls.length ? calls.map((call) => {
      const fields = Array.isArray(call.fields) ? call.fields : [];
      const fieldRows = fields.length ? configRows(fields) : configRows((call.focusFields || []).map((key) => ({ key, value: null, status: 'pending' })));
      return `<article class="vobTestLedgerCard"><div class="vobTestLedgerHead"><div><code>${escapeHtml(call.callId || 'call')}</code><span>${escapeHtml(call.kind || 'call')} · #${escapeHtml(call.sequence || '—')}</span></div><em>${escapeHtml(call.attemptStatus || 'pending')}</em></div>${fieldRows}</article>`;
    }).join('') : '<div class="vobTestEmpty">No ledger calls are recorded for this case.</div>';
    target.innerHTML = `<div class="vobTestInspectorHead"><div><strong>Test lane context</strong><span>read-only case snapshot · refreshes on demand</span></div><button type="button" class="vobClose" data-vob-test-refresh>Refresh</button></div>
      ${configSection('Production configuration', configRows(runtimeRows.map((row) => ({ ...row, key: row.key, value: row.value }))))}
      ${configSection('Current prompt / private test override', `<div class="vobPromptMeta">${promptMeta}</div><label class="vobTestPrompt">Private test prompt<small>Production calls are unchanged. Restart the test room to apply edits.</small><textarea class="vobPromptEditor" name="promptText" rows="18">${escapeHtml(promptText)}</textarea></label><details class="vobPromptCompiled"><summary>Compiled prompt with packet context</summary><textarea class="vobPromptCompiledText" readonly rows="12">${escapeHtml(compiledPrompt)}</textarea></details><button type="button" class="vobClose" data-vob-test-reset-prompt>Reset to production prompt</button>`, true)}
      ${configSection('Packet / dynamic variables', configRows(packetFacts), true)}
      ${configSection('LiveKit context variables / injected at session start', configRows(contextRows, 'No context variables were generated for this case.'), true)}
      ${configSection('Ledger fields and captured answers', `<div class="vobTestLedgerCards">${callsMarkup}</div>`, true)}
      ${configSection('Answers / extracted facts', configRows(facts), false)}
      ${pipelineMarkup(config.pipeline, config.pipelineModes)}
      ${configSection('Current test settings', `<div class="vobTestSettings"><label>Prompt<select name="promptPreset">${optionsHtml(state.catalog?.prompts, settings.promptPreset, true)}</select></label><label>Model<select name="model">${optionsHtml(state.catalog?.models, settings.model, true)}</select></label><label>Voice<select name="voice">${optionsHtml(state.catalog?.voices, settings.voice, true)}</select></label><div class="vobTestConfigNote">Changes apply when the test room restarts. Runtime stays on the production Gemma / Flux / Cartesia contract.</div><button type="button" class="vobTestPrimary" data-vob-test-restart>Restart with settings</button></div>`, false)}`;
  }

  async function refreshTestConfig() {
    const sessionId = currentSessionId();
    if (!sessionId || !state.testId) return;
    const response = await api(`/api/sessions/${encodeURIComponent(sessionId)}/vob/test/config/${encodeURIComponent(state.testId)}`);
    state.config = await json(response);
    renderTestInspector(state.config);
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
    state.testId = '';
    state.config = null;
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

  function humanTranscriptText(value) {
    const text = String(value == null ? '' : value).replace(/\r/g, '').trim();
    if (!text) return '';
    const candidates = [text];
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) candidates.unshift(fenced[1].trim());
    else {
      const unfenced = text.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
      if (unfenced !== text) candidates.unshift(unfenced);
    }
    for (const candidate of candidates) {
      try {
        const payload = JSON.parse(candidate);
        if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'say')) {
          return String(payload.say == null ? '' : payload.say).trim();
        }
      } catch {}
    }
    return text;
  }

  function upsertTranscript(segments, participant, room) {
    const list = document.querySelector('[data-vob-test-transcript]');
    if (!list) return;
    for (const segment of (Array.isArray(segments) ? segments : [])) {
      const id = String(segment?.id || `${participant?.identity || 'agent'}-${segmentTime(segment)}-${segment?.text || ''}`);
      const local = !!room?.localParticipant && participant?.identity === room.localParticipant.identity;
      const rowData = { id, text: humanTranscriptText(segment?.text), final: segment?.final !== false, local, start: Math.max(0, segmentTime(segment)) };
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
      state.testId = String(join.testId || '');
      if (state.testId) {
        try { await refreshTestConfig(); } catch { /* config is best-effort; the room can still connect */ }
      }
      if (state.ended) throw new Error('Role-play cancelled');
      state.room = new LK.Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      bindRoom(LK, state.room);
      showCallPanel();
      renderTestInspector(state.config);
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
      modal.addEventListener('click', async (event) => {
        if (event.target.closest('[data-vob-test-reset-prompt]')) {
          const editor = modal.querySelector('[data-vob-test-inspector] textarea[name="promptText"]');
          if (editor) editor.value = state.config?.promptEditor?.productionBaseText || state.catalog?.productionPrompt?.baseText || '';
          return;
        }
        if (event.target.closest('[data-vob-test-refresh]')) {
          try { await refreshTestConfig(); } catch (error) { notify(error.message || 'Could not refresh test context'); }
        }
        if (event.target.closest('[data-vob-test-restart]')) {
          const activeSettings = modal.querySelector('[data-vob-test-inspector]');
          const values = Object.fromEntries([...activeSettings.querySelectorAll('select[name], textarea[name], input[name]')].map((field) => [field.name, field.value]));
          const button = event.target.closest('[data-vob-test-restart]');
          button.disabled = true;
          try {
            endCall(false);
            const form = modal.querySelector('[data-vob-test-form]');
            Object.entries(values).forEach(([key, value]) => { if (form?.elements[key]) form.elements[key].value = value; });
            form?.classList.remove('hidden');
            modal.querySelector('[data-vob-test-call]')?.classList.add('hidden');
            await startCall(form);
          } catch (error) { notify(error.message || 'Could not restart test'); button.disabled = false; }
        }
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
