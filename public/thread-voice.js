/* In-thread voice mode — talk to a chat thread like switching to voice inside a ChatGPT chat.
 *
 * GPT-Live (public/live-voice.js) carries the conversation, seeded with this thread's recent
 * history, with the same Responses backend + box tools as the Voice screen. Quick lookups
 * (email, calendar, brain, Linear, sessions…) run as box tools via /api/voice/tool. Real work
 * in this thread goes through the client-handled ask_thread_agent tool: we send the backend's
 * request INTO THIS THREAD as a normal 🎙 message (so the thread's own Claude/Codex agent does
 * it with all of its tools and context), answer the tool call at once, watch the turn stream
 * on the chat socket, and hand the agent's final reply back to GPT-Live
 * (session.commentary.append) to be spoken.
 *
 * UI: a full-screen view (title, orb, captions, tool chips, mute / back-to-chat / end) that
 * minimizes to a bar above the composer; the chat keeps streaming behind it.
 *
 * Globals from app.js: $, cur, api, toast, enqueueText, paintIcons, running.
 */
(function () {
  const VOICE_HINT = '(Sent by voice from a live call — your final reply is read aloud, so finish with a short plain-English summary.)';
  // A request waits for Jimmy to stop talking before it goes into the thread, so a sentence the
  // voice model delegated mid-way reaches the agent whole (INC-2443).
  const SETTLE_MS = 1200, SETTLE_CAP_MS = 4000;
  // A request that extends one sent moments ago (and not finished) replaces it.
  const CONTINUE_WINDOW_MS = 20000;
  // Silence gate (GPT-Live office hours): agent turns take minutes; after this much dead air
  // the voice gives a one-line "still working" update, a few times at most.
  const SILENCE_GATE_MS = 40000, NUDGE_EVERY_MS = 75000, MAX_NUDGES = 3;
  const FEED_MAX = 80;
  let tv = null; // the active call
  let swallowPop = false; // our own history.back() after minimizing

  function speakable(text, max = 1500) {
    let t = String(text || '');
    t = t.replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/`([^`]+)`/g, '$1');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1').replace(/https?:\/\/\S+/g, '(link)');
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\s*[-*+]\s+/gm, '• ');
    t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length > max) {
      const cut = t.slice(0, max); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
      t = (end > max * 0.6 ? cut.slice(0, end + 1) : cut) + ' … (the rest is in the chat)';
    }
    return t;
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const agentLabel = (a) => (a === 'codex' ? 'Codex' : a === 'claude' || !a ? 'Claude Code' : String(a));
  // Share of a's meaningful words that also appear in b.
  function overlap(a, b) {
    const toks = (s) => norm(s).replace(/[^\w\s']/g, ' ').split(/\s+/).filter((w) => w.length > 2);
    const wa = toks(a);
    if (!wa.length) return 0;
    const wb = new Set(toks(b));
    return wa.filter((w) => wb.has(w)).length / wa.length;
  }
  const extendsRequest = (prev, next) => overlap(prev, next) >= 0.6;

  /* ---------- UI ---------- */
  function ensureUi() {
    if ($('tvBar')) return;
    // Minimized: a bar above the composer. Tapping it re-opens the full view.
    const bar = document.createElement('div');
    bar.id = 'tvBar'; bar.className = 'tvBar hidden';
    bar.innerHTML = `
      <button id="tvExpand" class="tvExpand" type="button" aria-label="Open the voice view">
        <span class="tvOrb" id="tvOrb"><span></span></span>
        <span class="tvMain">
          <span class="tvStatus" id="tvStatus">Connecting…</span>
          <span class="tvCaption" id="tvCaption"></span>
        </span>
        <span class="tvExpandIc" data-icon="chevron-up"></span>
      </button>
      <button id="tvMute" class="iconbtn" title="mute" aria-label="Mute" data-icon="mic"></button>
      <button id="tvEnd" class="tvEndBtn" title="end voice">End</button>`;
    const wrap = $('inputWrap');
    wrap.parentNode.insertBefore(bar, wrap);
    // Expanded: full screen over the chat.
    const full = document.createElement('div');
    full.id = 'tvFull'; full.className = 'tvFull hidden';
    full.setAttribute('role', 'dialog'); full.setAttribute('aria-label', 'Voice mode');
    full.innerHTML = `
      <header class="tvFullBar">
        <button id="tvMin" class="iconbtn ghost" title="back to chat" aria-label="Minimize voice" data-icon="chevron-down"></button>
        <div class="tvFullHead"><strong id="tvTitle" class="tvTitle"></strong><span id="tvFullStatus" class="tvFullStatus">Connecting…</span></div>
        <span id="tvClock" class="voClock tvClock"></span>
      </header>
      <div class="tvStage"><div id="tvBigWrap" class="tvBigWrap"><span id="tvBigOrb" class="voOrb connecting"></span></div></div>
      <div id="tvFeed" class="tvFeed" aria-live="polite"></div>
      <div class="voDock tvDock">
        <button id="tvFMute" class="voCtl" title="mute" aria-label="Mute"><span data-icon="mic"></span></button>
        <button id="tvFChat" class="voCtl" title="back to chat" aria-label="Back to chat"><span data-icon="chat"></span></button>
        <button id="tvFEnd" class="voCtl voEndBtn" title="end voice" aria-label="End voice"><span data-icon="close"></span></button>
      </div>`;
    document.body.appendChild(full);
    $('tvExpand').onclick = () => expand();
    $('tvMin').onclick = () => minimize();
    $('tvFChat').onclick = () => minimize();
    $('tvEnd').onclick = () => stop('ended');
    $('tvFEnd').onclick = () => stop('ended');
    $('tvMute').onclick = toggleMute;
    $('tvFMute').onclick = toggleMute;
    paintIcons(bar); paintIcons(full);
  }
  function render() {
    const on = !!tv, big = !!(tv && tv.expanded);
    $('tvBar').classList.toggle('hidden', !on || big);
    $('tvFull').classList.toggle('hidden', !big);
    document.body.classList.toggle('tvFullOpen', big);
    const b = $('threadVoiceBtn'); if (b) b.classList.toggle('active', on);
  }
  function expand() {
    if (!tv || tv.expanded) return;
    tv.expanded = true;
    render(); scrollFeed();
    // Back (gesture or button) while expanded minimizes instead of leaving the chat.
    try { history.pushState({ ...(history.state || {}), tvFull: 1 }, '', location.href); tv.histPushed = true; } catch {}
  }
  function minimize({ fromHistory = false } = {}) {
    if (!tv || !tv.expanded) return;
    tv.expanded = false;
    render();
    dropHistoryEntry(fromHistory);
  }
  function dropHistoryEntry(fromHistory) {
    if (!tv || !tv.histPushed) return;
    tv.histPushed = false;
    if (fromHistory) return;
    swallowPop = true;
    try { history.back(); } catch { swallowPop = false; }
  }
  // Called first by app.js's popstate handler; true = handled here.
  function onPopState() {
    if (swallowPop) { swallowPop = false; return true; }
    if (tv && tv.expanded) { minimize({ fromHistory: true }); return true; }
    return false;
  }
  function toggleMute() {
    if (!tv) return;
    tv.engine.setMuted(!tv.engine.muted);
    for (const id of ['tvMute', 'tvFMute']) { const b = $(id); if (b) b.classList.toggle('active', tv.engine.muted); }
    paintStatus();
  }
  function setStatus(text) {
    for (const id of ['tvStatus', 'tvFullStatus']) { const el = $(id); if (el) el.textContent = text; }
  }
  function setCaption(role, text) {
    const el = $('tvCaption'); if (!el) return;
    el.textContent = text ? `${role === 'user' ? 'You' : 'Voice'}: ${text}` : '';
    el.className = 'tvCaption ' + (role || '');
  }
  function paintStatus() {
    if (!tv) return;
    const st = tv.engine.state;
    if (st === 'connecting' || st === 'idle') return setStatus(tv.reconnects ? 'Reconnecting…' : 'Connecting…');
    if (st !== 'live') return;
    if (tv.engine.muted) return setStatus('Muted');
    const working = tv.awaiting.filter((a) => !a.done && !a.superseded);
    if (working.length) return setStatus(working.some((a) => a.started) ? `${tv.agentName} working${tv.lastTool ? ` · ${tv.lastTool}` : ''}…` : 'Sent to the agent…');
    if (tv.backend.size) return setStatus('Working…');
    setStatus('Listening');
  }

  // Feed (full view): caption bubbles, tool chips, notices — the Voice screen's components.
  function scrollFeed() { const f = $('tvFeed'); if (f) f.scrollTop = f.scrollHeight; }
  function feedAdd(node) {
    const f = $('tvFeed'); if (!f) return node;
    f.appendChild(node);
    while (f.childNodes.length > FEED_MAX) f.removeChild(f.firstChild);
    scrollFeed();
    return node;
  }
  function bubble(cls, text) {
    const d = document.createElement('div');
    d.className = 'voBub ' + cls; d.textContent = text || '';
    return feedAdd(d);
  }
  function chip(label) {
    const d = document.createElement('div'); d.className = 'voToolChip';
    const spin = document.createElement('span'); spin.className = 'voSpin';
    const name = document.createElement('span'); name.className = 'voToolName'; name.textContent = label;
    d.appendChild(spin); d.appendChild(name);
    d._spin = spin; d._name = name;
    return feedAdd(d);
  }
  function finishChip(c, failed) {
    if (!c || c._done) return;
    c._done = true;
    c.classList.add(failed ? 'fail' : 'ok');
    try { c._spin.remove(); } catch {}
  }
  function resetFeed() { const f = $('tvFeed'); if (f) f.innerHTML = ''; }
  function onCaption(call, seg) {
    call.lastSpeechAt = Date.now();
    if (seg.role === 'user') call.lastUserDeltaAt = Date.now();
    setCaption(seg.role, seg.text.slice(-220));
    let b = call.bubbles.get(seg.id);
    if (!b) { b = bubble(seg.role === 'user' ? 'user' : 'asst', ''); call.bubbles.set(seg.id, b); }
    b.textContent = seg.text;
    scrollFeed();
    if (seg.final) {
      call.bubbles.delete(seg.id);
      if (!seg.text.trim()) { try { b.remove(); } catch {} }
      if (call.vsid && seg.text.trim()) api('/api/voice/event', { method: 'POST', body: JSON.stringify({ vsid: call.vsid, events: [{ ts: Date.now(), kind: seg.role === 'user' ? 'user' : 'assistant', text: seg.text }] }) }).catch(() => {});
    }
  }

  function animate() {
    if (!tv) return;
    const call = tv;
    // Voice is bound to ONE thread: leaving it ends the call.
    if (cur.key !== call.key) { stop('left'); toast('Voice ended — you left that chat'); return; }
    const live = call.engine.state === 'live';
    const out = live ? call.engine.outputLevel() : 0, inp = live ? call.engine.inputLevel() : 0;
    const working = call.awaiting.some((a) => !a.done && !a.superseded);
    const now = Date.now();
    for (const [id, at] of call.backend) if (now - at > 90000) call.backend.delete(id); // lost terminal event
    const orb = $('tvOrb');
    if (orb) {
      orb.style.setProperty('--lvl', Math.max(out, inp).toFixed(3));
      orb.classList.toggle('speaking', out > 0.04);
      orb.classList.toggle('hearing', out <= 0.04 && inp > 0.05);
      orb.classList.toggle('working', working);
    }
    const big = $('tvBigOrb');
    if (big && call.expanded) {
      const mode = !live ? 'connecting' : out > 0.04 ? 'speaking' : call.backend.size ? 'thinking' : 'listening';
      if (big.className !== 'voOrb ' + mode) big.className = 'voOrb ' + mode;
      big.style.setProperty('--lvl', (1 + Math.max(out, inp) * 0.22).toFixed(3));
      const wrap = $('tvBigWrap'); if (wrap) wrap.classList.toggle('working', working);
      const clock = $('tvClock');
      if (clock) {
        const s = Math.floor((now - call.startedAt) / 1000);
        const txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (clock.textContent !== txt) clock.textContent = txt;
      }
    }
    if (live && now - (call.lastGateAt || 0) > 1000) { call.lastGateAt = now; silenceGate(call); }
    call.raf = requestAnimationFrame(animate);
  }

  /* ---------- tools ---------- */
  async function onFunctionCall(call, fc) {
    if (tv !== call) return JSON.stringify({ error: 'the voice call ended' });
    let args = fc.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = {}; } }
    if (fc.name === 'ask_thread_agent') return JSON.stringify(askThreadAgent(call, args || {}));
    const c = chip(window.LiveVoice.toolLabel(fc.name));
    paintStatus();
    const { output, failed } = await window.LiveVoice.runBoxTool(api, { name: fc.name, args: fc.arguments, call_id: fc.call_id, vsid: call.vsid });
    finishChip(c, failed);
    return output;
  }

  // ask_thread_agent → a 🎙 message in this thread. Answers at once (the agent takes minutes);
  // the agent's final reply is spoken later from onChatEvent.
  function askThreadAgent(call, { request }) {
    const text = String(request || '').replace(/[ \t]+/g, ' ').trim().slice(0, 4000);
    if (!text) return { error: 'empty request — ask Jimmy what he wants the agent to do' };
    if (cur.key !== call.key) return { error: 'voice is no longer on this chat' };
    const p = call.pendingSend;
    if (p) { // still waiting for Jimmy to finish talking: fold into the same message
      if (extendsRequest(p.text, text)) p.text = text;
      else if (!extendsRequest(text, p.text)) p.text = `${p.text}\n\nAlso: ${text}`;
      return { status: 'sent', note: 'Folded into the request going to the agent right now.' };
    }
    const prev = call.lastSent;
    const recent = prev && !prev.item.done && !prev.item.superseded && Date.now() - prev.at < CONTINUE_WINDOW_MS;
    if (recent && norm(prev.text) === norm(text)) return { status: 'already_sent', note: 'That request is already with the agent.' };
    const replaces = recent && extendsRequest(prev.text, text) ? prev.item : null;
    const queued = !replaces && agentBusy(call);
    const pending = call.pendingSend = { text, replaces, at: Date.now() };
    const tick = () => {
      if (tv !== call || call.pendingSend !== pending) return;
      const quiet = Date.now() - call.lastUserDeltaAt > SETTLE_MS;
      if (!quiet && Date.now() - pending.at < SETTLE_CAP_MS) return setTimeout(tick, 150);
      flush(call, pending);
    };
    setTimeout(tick, 250);
    if (replaces) return { status: 'sent', note: 'Sent; it replaces the cut-off request from a moment ago. The agent is on it; its reply will reach Jimmy when it lands.' };
    if (queued) return { status: 'queued', note: 'The agent is still finishing an earlier turn, so this request is queued and runs right after it. Tell Jimmy that in one short sentence.' };
    return { status: 'sent', note: "Sent into the thread; the agent is working on it now. Its reply will reach Jimmy when it lands — don't guess it." };
  }

  function flush(call, pending) {
    call.pendingSend = null;
    if (tv !== call || cur.key !== call.key) return;
    let body = pending.text;
    if (pending.replaces) {
      pending.replaces.superseded = true;
      finishChip(pending.replaces.chip, false);
      body += '\n\n(My previous voice message was cut off mid-sentence — this is the full request; it replaces that one.)';
    }
    const item = { text: pending.text, sentAt: Date.now(), started: false, done: false, superseded: false, nudges: 0, chunks: [''], chip: chip(`Sent to ${call.agentName}`) };
    call.lastSent = { text: pending.text, at: Date.now(), item };
    call.awaiting.push(item);
    enqueueText(`${body}\n\n${VOICE_HINT}`, { displayText: `🎙 ${pending.text}` });
    paintStatus();
  }

  function finishItem(item, reason) {
    if (!item || item.done) return;
    item.done = true;
    finishChip(item.chip, reason === 'error');
    if (item.superseded) { paintStatus(); return; } // the full re-sent request speaks instead
    const chunks = item.chunks.map((c) => c.trim()).filter(Boolean);
    let final = chunks.length ? chunks[chunks.length - 1] : '';
    if (final.length < 60 && chunks.length > 1) final = chunks.slice(-2).join('\n\n');
    if (reason === 'error') tv.engine.commentary(null, `The thread's agent hit an error: ${speakable(item.error || 'unknown error', 300)}`);
    else if (!final) tv.engine.commentary(null, 'The thread\'s agent finished without a written reply. Ask Jimmy what he wants next.');
    else tv.engine.commentary(null, `The thread's agent replied (summarize it for Jimmy; the full text is in the chat): ${speakable(final)}`);
    paintStatus();
  }

  // Dead air while the agent works: one short spoken "still going" now and then.
  function silenceGate(call) {
    const item = call.awaiting.filter((a) => !a.done && !a.superseded).pop();
    if (!item) return;
    const now = Date.now();
    if (now - Math.max(call.lastSpeechAt, item.sentAt) < SILENCE_GATE_MS) return;
    if (item.nudges >= MAX_NUDGES || now - (item.lastNudgeAt || 0) < NUDGE_EVERY_MS) return;
    item.nudges++; item.lastNudgeAt = now;
    const doing = item.started ? (call.lastTool ? `, currently using ${call.lastTool}` : '') : ', queued behind an earlier turn';
    call.engine.commentary(null, `[STATUS — not Jimmy speaking] The thread's agent is still working on "${item.text.slice(0, 120)}"${doing}. Say in one short sentence that it is still going; do not ask him anything.`);
  }

  // Every chat socket event for the open thread (called from app.js onServer).
  function onChatEvent(o) {
    if (!tv || tv.engine.state !== 'live' || cur.key !== tv.key) return;
    const turn = tv.turn;
    const lastItem = () => (turn && turn.items.length ? turn.items[turn.items.length - 1] : null);
    switch (o.type) {
      case 'turn_start': {
        const t = norm(o.text);
        const mine = tv.awaiting.filter((a) => !a.done && !a.started && t.includes(norm(a.text).slice(0, 120)));
        mine.forEach((a) => { a.started = true; });
        // A batched turn answers several voice requests at once; the newest one speaks.
        tv.turn = mine.length ? { items: mine, chunks: [''], afterTool: false } : { items: [], chunks: [''], afterTool: false, typed: true };
        tv.lastTool = '';
        paintStatus();
        break;
      }
      case 'text':
        if (!turn) break;
        if (turn.afterTool) { turn.chunks.push(''); turn.afterTool = false; }
        turn.chunks[turn.chunks.length - 1] += o.delta || '';
        break;
      case 'tool': {
        if (!turn) break;
        turn.afterTool = true;
        tv.lastTool = String(o.name || '').replace(/^mcp__\w+__/, '').slice(0, 30);
        const it = lastItem();
        if (it && it.chip && it.chip._name) it.chip._name.textContent = `${tv.agentName} · ${tv.lastTool}`;
        if (o.name === 'AskUserQuestion' && it) {
          const q = speakable(typeof o.input === 'string' ? o.input : JSON.stringify(o.input || ''), 600);
          tv.engine.commentary(null, `The thread's agent is asking Jimmy a question: ${q}`);
        } else if (it && Date.now() - (tv.lastProgressAt || 0) > 10000) {
          tv.lastProgressAt = Date.now();
          tv.engine.thinking(null, `Thread agent progress: now using ${tv.lastTool}. Still working.`);
        }
        paintStatus();
        break;
      }
      case 'waiting':
        if (lastItem()) tv.engine.commentary(null, `The thread's agent is waiting for Jimmy's input${o.prompt ? `: ${speakable(o.prompt, 500)}` : '.'}`);
        break;
      case 'error':
        if (lastItem()) lastItem().error = o.msg;
        break;
      case 'blocked': {
        const it = tv.awaiting.filter((a) => !a.done).pop();
        if (it) { it.done = true; finishChip(it.chip, true); tv.engine.commentary(null, 'That was not sent: this chat is open live on another device. Jimmy needs to close it there or tap Take over here.'); }
        break;
      }
      case 'done':
      case 'idle': {
        if (!turn) break;
        tv.turn = null;
        if (turn.items.length) {
          const last = turn.items[turn.items.length - 1];
          turn.items.slice(0, -1).forEach((it) => { it.done = true; finishChip(it.chip, false); });
          last.chunks = turn.chunks;
          finishItem(last, last.error ? 'error' : 'done');
        } else if (turn.typed) {
          // A typed message mid-call: keep the voice model current without speaking.
          const text = turn.chunks.map((c) => c.trim()).filter(Boolean).pop();
          if (text) tv.engine.thinking(null, `The thread's agent replied in the chat to a typed message: ${speakable(text, 900)}`);
        }
        paintStatus();
        break;
      }
      default: break;
    }
  }

  // Background-task updates (start_agent completions, watchers) — same feed as the Voice screen.
  async function pollUpdates(call) {
    if (tv !== call || call.engine.state !== 'live' || call.cursor == null || call.polling) return;
    call.polling = true;
    try {
      const r = await api(`/api/voice/updates?cursor=${call.cursor}`);
      const j = await r.json();
      for (const e of (j.events || [])) {
        if (tv !== call) break;
        call.cursor = Math.max(call.cursor, e.seq);
        bubble('notice', '📣 ' + (e.title || e.kind));
        if (globalThis.VoiceNotify && globalThis.VoiceNotify.shouldSpeakUpdate(e)) {
          call.engine.commentary(null, `[TASK UPDATE — a background event, not Jimmy speaking] ${e.speak} Mention it once with purpose, impact, and next step, then return to the topic.`);
        }
      }
    } catch {} finally { call.polling = false; }
  }

  /* ---------- lifecycle ---------- */
  // app.js's `running` (a turn is running in this chat) — a shared global across classic scripts.
  // Our own voice turn counts only once it has started; before that the agent is busy with something else.
  function agentBusy(call) {
    let r = false;
    try { r = typeof running !== 'undefined' && !!running; } catch {}
    return r && !(call.turn && call.turn.items.length);
  }

  function makeEngine(call) {
    const engine = window.LiveVoice.create({
      api,
      onState: () => paintStatus(),
      onCaption: (seg) => { if (tv === call) onCaption(call, seg); },
      onDelegation: (d) => { if (tv === call) { call.backend.set(d.id, Date.now()); paintStatus(); } },
      onFunctionCall: (fc) => onFunctionCall(call, fc),
      onBackendEvent: (inner, delegationId) => {
        if (tv !== call) return;
        if (inner.type === 'response.completed' || inner.type === 'response.failed' || inner.type === 'response.incomplete') { call.backend.delete(delegationId); paintStatus(); }
      },
      onError: (err) => { if (err && (err.code || err.message)) console.warn('[thread-voice]', err.code || '', err.message || ''); },
      onClosed: ({ reason }) => {
        if (tv !== call || call.engine !== engine) return;
        // Session cap (2h) or a dropped connection: resume with fresh thread history.
        if ((reason === 'expired' || reason === 'connection_lost') && call.reconnects < 3 && !call.stopping) {
          call.reconnects++;
          call.backend.clear();
          setStatus('Reconnecting…');
          setTimeout(() => { if (tv === call) { call.engine = makeEngine(call); connect(call); } }, reason === 'expired' ? 200 : 1500);
          return;
        }
        if (!call.stopping) toast(reason === 'content' ? 'Voice ended by a safety filter' : 'Voice ended');
        cleanup('closed');
      },
    });
    return engine;
  }

  async function start() {
    if (tv) { expand(); return; } // the button re-opens a minimized call; End ends it
    if (!cur || cur.mode === 'bash') { toast('Voice works in a normal chat'); return; }
    if (!window.LiveVoice || !window.RTCPeerConnection) { toast('This browser cannot do live voice'); return; }
    ensureUi();
    const call = {
      key: cur.key, title: cur.title || 'Chat', agentName: agentLabel(cur.agent), awaiting: [], lastUserDeltaAt: 0,
      lastSpeechAt: Date.now(), lastSent: null, pendingSend: null, reconnects: 0, turn: null, lastTool: '', vsid: null,
      cursor: null, expanded: false, histPushed: false, bubbles: new Map(), backend: new Map(), startedAt: Date.now(),
    };
    tv = call;
    resetFeed(); setCaption('', '');
    $('tvTitle').textContent = call.title;
    for (const id of ['tvMute', 'tvFMute']) { const b = $(id); if (b) b.classList.remove('active'); }
    call.engine = makeEngine(call);
    expand();
    setStatus('Connecting…');
    call.raf = requestAnimationFrame(animate);
    call.pollIv = setInterval(() => pollUpdates(call), 5000);
    try { call.wake = await navigator.wakeLock.request('screen'); } catch {}
    await connect(call);
  }
  async function connect(call) {
    try {
      const info = await call.engine.start({ scope: 'thread', sessionId: cur.id || '', agent: cur.agent || 'claude', title: cur.title || '', cwd: cur.cwd || '', vsid: call.vsid || undefined });
      if (tv !== call) { call.engine.close(); return; }
      call.vsid = info.vsid;
      if (call.cursor == null && Number.isFinite(Number(info.cursor))) call.cursor = Number(info.cursor);
      call.lastSent = null; call.pendingSend = null;
      const pending = call.awaiting.filter((a) => !a.done).length;
      call.engine.commentary(null, call.reconnects
        ? `The voice connection was restored. Do not greet again; say "I'm back" and keep listening.${pending ? ' The thread\'s agent is still working on the last request.' : ''}`
        : `Greet Jimmy in a few words — say you are on this chat and ready${agentBusy(call) ? ', and that the agent is still finishing an earlier turn, so new requests will queue behind it' : ''} — then pause and listen.`);
      if (call.reconnects) bubble('notice', 'Reconnected.');
      paintStatus();
    } catch (e) {
      if (tv === call) { toast(String((e && e.message) || e).slice(0, 140)); cleanup('failed'); }
    }
  }
  function stop(reason) {
    if (!tv) return;
    tv.stopping = true;
    try { tv.engine.close(); } catch {}
    cleanup(reason);
  }
  function cleanup(reason) {
    if (!tv) return;
    const call = tv;
    if (call.raf) cancelAnimationFrame(call.raf);
    if (call.pollIv) clearInterval(call.pollIv);
    try { call.wake && call.wake.release(); } catch {}
    // Leaving the chat already moved history; otherwise drop our "expanded" entry.
    if (reason === 'left') call.histPushed = false;
    else dropHistoryEntry(false);
    tv = null;
    render();
  }

  window.ThreadVoice = {
    start, stop, expand, minimize, onChatEvent, onPopState,
    get active() { return !!tv; }, get expanded() { return !!(tv && tv.expanded); }, _speakable: speakable, _overlap: overlap,
    // Spoken transcript of the current call (debug / e2e).
    transcript: () => (tv ? tv.engine.segments.map((s) => `${s.role}: ${s.text}`).join('\n') : ''),
  };
})();
