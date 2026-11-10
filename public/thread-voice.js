/* In-thread voice mode — talk to a chat thread like switching to voice inside a ChatGPT chat.
 *
 * GPT-Live (public/live-voice.js) carries the conversation, seeded with this thread's
 * recent history. When it decides real work is needed it emits a client delegation; we
 * take what the user just said, send it INTO THIS THREAD as a normal message (so it shows
 * up in the chat and the thread's own Claude/Codex agent does the work with all of its
 * tools and context), watch the turn stream on the chat socket, and hand the agent's
 * final reply back to GPT-Live (session.commentary.append) to be spoken.
 *
 * Globals from app.js: $, cur, api, toast, enqueueText, paintIcons.
 */
(function () {
  const VOICE_HINT = '(Sent by voice from a live call — your final reply is read aloud, so finish with a short plain-English summary.)';
  let tv = null; // the active call

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
  const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  /* ---------- UI ---------- */
  function ensureUi() {
    if ($('tvBar')) return;
    const bar = document.createElement('div');
    bar.id = 'tvBar'; bar.className = 'tvBar hidden';
    bar.innerHTML = `
      <div class="tvOrb" id="tvOrb"><span></span></div>
      <div class="tvMain">
        <div class="tvStatus" id="tvStatus">Connecting…</div>
        <div class="tvCaption" id="tvCaption"></div>
      </div>
      <button id="tvMute" class="iconbtn" title="mute" data-icon="mic"></button>
      <button id="tvEnd" class="tvEndBtn" title="end voice">End</button>`;
    const wrap = $('inputWrap');
    wrap.parentNode.insertBefore(bar, wrap);
    $('tvEnd').onclick = () => stop('ended');
    $('tvMute').onclick = () => {
      if (!tv) return;
      tv.engine.setMuted(!tv.engine.muted);
      $('tvMute').classList.toggle('active', tv.engine.muted);
      paintStatus();
    };
    paintIcons(bar);
  }
  function show(on) {
    ensureUi();
    $('tvBar').classList.toggle('hidden', !on);
    const b = $('threadVoiceBtn'); if (b) b.classList.toggle('active', !!on);
  }
  function setStatus(text) { const el = $('tvStatus'); if (el) el.textContent = text; }
  function setCaption(role, text) {
    const el = $('tvCaption'); if (!el) return;
    el.textContent = text ? `${role === 'user' ? 'You' : 'Voice'}: ${text}` : '';
    el.className = 'tvCaption ' + (role || '');
  }
  function paintStatus() {
    if (!tv) return;
    const st = tv.engine.state;
    if (st === 'connecting') return setStatus(tv.reconnects ? 'Reconnecting…' : 'Connecting…');
    if (st !== 'live') return;
    if (tv.engine.muted) return setStatus('Muted');
    const working = tv.awaiting.filter((a) => !a.done);
    if (working.length) return setStatus(working.some((a) => a.started) ? `Agent working${tv.lastTool ? ` · ${tv.lastTool}` : ''}…` : 'Sent to the agent…');
    setStatus('Listening');
  }
  function animate() {
    if (!tv) return;
    const orb = $('tvOrb');
    if (orb && tv.engine.state === 'live') {
      const out = tv.engine.outputLevel(), inp = tv.engine.inputLevel();
      const lvl = Math.max(out, inp);
      orb.style.setProperty('--lvl', lvl.toFixed(3));
      orb.classList.toggle('speaking', out > 0.04);
      orb.classList.toggle('hearing', out <= 0.04 && inp > 0.05);
      orb.classList.toggle('working', tv.awaiting.some((a) => !a.done));
    }
    // Voice is bound to ONE thread: leaving it ends the call.
    if (cur.key !== tv.key) { stop('left'); toast('Voice ended — you left that chat'); return; }
    tv.raf = requestAnimationFrame(animate);
  }

  /* ---------- delegation → thread ---------- */
  function userTextSince(ms) {
    const segs = tv.engine.segments;
    const users = segs.filter((s) => s.role === 'user' && s.endMs > ms);
    let text = users.map((s) => s.text.trim()).filter(Boolean).join(' ');
    let endMs = users.reduce((m, s) => Math.max(m, s.endMs), ms);
    if (!text) { // re-asked the same thing: use the most recent utterance
      const last = segs.filter((s) => s.role === 'user').pop();
      if (last) { text = last.text.trim(); endMs = Math.max(endMs, last.endMs); }
    }
    // A short reply ("yes, do it") needs what it is answering.
    let context = '';
    if (words(text) < 8) {
      const firstUser = users[0];
      const prior = segs.filter((s) => s.role === 'assistant' && (!firstUser || s.startMs < firstUser.startMs)).pop();
      if (prior && prior.text.trim()) context = prior.text.trim();
    }
    return { text, endMs, context, startMs: users.length ? users[0].startMs : null };
  }

  // A sentence must reach the thread as ONE message. GPT-Live can delegate before Jimmy has
  // finished (a mid-sentence pause, or its own "on it" splitting the transcript), then delegate
  // again for the rest — which used to send only the tail (INC-2443). So: wait longer for the
  // transcript to settle, fold delegations that arrive meanwhile into the same send, and if a
  // send continues the previous one, re-send the whole sentence instead of the fragment.
  const SETTLE_MS = 1200, SETTLE_CAP_MS = 4000, CONTINUE_GAP_MS = 1500, CONTINUE_WINDOW_MS = 15000;
  function onDelegation(d) {
    if (!tv) return;
    const call = tv;
    if (call.pending) { call.pending.ids.push(d.id); return; }
    const pending = call.pending = { ids: [d.id], startedAt: Date.now() };
    const tick = () => {
      if (tv !== call) return;
      const quiet = Date.now() - call.lastUserDeltaAt > SETTLE_MS;
      if (!quiet && Date.now() - pending.startedAt < SETTLE_CAP_MS) return setTimeout(tick, 150);
      call.pending = null;
      dispatch(pending.ids);
    };
    setTimeout(tick, 250);
  }

  function dispatch(ids) {
    const id = ids[ids.length - 1];
    const sentence = userTextSince(tv.consumedMs);
    let { text } = sentence;
    const { endMs, context, startMs } = sentence;
    const prev = tv.lastSent;
    tv.consumedMs = Math.max(tv.consumedMs, endMs);
    for (const other of ids.slice(0, -1)) tv.engine.thinking(other, 'Merged into the next request (same sentence).');
    if (!text) { tv.engine.commentary(id, 'I did not catch the request — ask Jimmy to say it again.'); return; }
    if (cur.key !== tv.key) return;
    // Continuation of the message just sent (no real pause between them): send the whole thing.
    const continues = prev && prev.gen === tv.gen && !prev.item.done && startMs != null && startMs - prev.endMs < CONTINUE_GAP_MS
      && Date.now() - prev.at < CONTINUE_WINDOW_MS;
    if (continues) { text = `${prev.text} ${text}`; prev.item.superseded = true; }
    let body = context && !continues ? `${text}\n\n(Replying to the voice assistant, which had just said: "${context.slice(0, 400)}")` : text;
    if (continues) body += '\n\n(My previous voice message was cut off mid-sentence — this is the full request; it replaces that one.)';
    const item = { id, gen: tv.gen, text, sentAt: Date.now(), started: false, done: false, chunks: [''], afterTool: false };
    tv.lastSent = { text, endMs, gen: tv.gen, at: Date.now(), item };
    tv.awaiting.push(item);
    enqueueText(`${body}\n\n${VOICE_HINT}`, { displayText: `🎙 ${text}` });
    // Queued behind a turn that is still running (e.g. one Jimmy typed): say so out loud, or
    // the call goes silent until that earlier turn finishes and looks broken.
    if (agentBusy()) tv.engine.commentary(id, `Sent to the thread, but the agent is still finishing an earlier turn, so this request is queued behind it. Tell Jimmy that in one short sentence.`);
    else tv.engine.thinking(id, `Sent to the thread's agent: "${text.slice(0, 300)}". It is working; no result yet.`);
    paintStatus();
  }

  function finishItem(item, reason) {
    if (!item || item.done) return;
    item.done = true;
    const chunks = item.chunks.map((c) => c.trim()).filter(Boolean);
    let final = chunks.length ? chunks[chunks.length - 1] : '';
    if (final.length < 60 && chunks.length > 1) final = chunks.slice(-2).join('\n\n');
    const did = delegationFor(item);
    if (item.superseded) { paintStatus(); return; } // the full re-sent request speaks instead
    if (reason === 'error') tv.engine.commentary(did, `The agent hit an error: ${speakable(item.error || 'unknown error', 300)}`);
    else if (!final) tv.engine.commentary(did, 'The agent finished without a written reply. Ask Jimmy what he wants next.');
    else tv.engine.commentary(did, `The agent's reply (summarize it for Jimmy; the full text is in the chat): ${speakable(final)}`);
    paintStatus();
  }

  // Every chat socket event for the open thread (called from app.js onServer).
  function onChatEvent(o) {
    if (!tv || tv.engine.state !== 'live' || cur.key !== tv.key) return;
    const turn = tv.turn;
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
      case 'tool':
        if (!turn) break;
        turn.afterTool = true;
        tv.lastTool = String(o.name || '').replace(/^mcp__\w+__/, '').slice(0, 30);
        if (o.name === 'AskUserQuestion' && turn.items.length) {
          const q = speakable(typeof o.input === 'string' ? o.input : JSON.stringify(o.input || ''), 600);
          tv.engine.commentary(delegationFor(turn.items[turn.items.length - 1]), `The agent is asking Jimmy a question: ${q}`);
        } else if (turn.items.length && Date.now() - (tv.lastProgressAt || 0) > 10000) {
          tv.lastProgressAt = Date.now();
          tv.engine.thinking(delegationFor(turn.items[turn.items.length - 1]), `Agent progress: now using ${tv.lastTool}. Still working.`);
        }
        paintStatus();
        break;
      case 'waiting':
        if (turn && turn.items.length) tv.engine.commentary(delegationFor(turn.items[turn.items.length - 1]), `The agent is waiting for Jimmy's input${o.prompt ? `: ${speakable(o.prompt, 500)}` : '.'}`);
        break;
      case 'error':
        if (turn && turn.items.length) { const it = turn.items[turn.items.length - 1]; it.error = o.msg; }
        break;
      case 'blocked': {
        const it = tv.awaiting.filter((a) => !a.done).pop();
        if (it) { it.done = true; tv.engine.commentary(delegationFor(it), 'That was not sent: this chat is open live on another device. Jimmy needs to close it there or tap Take over here.'); }
        break;
      }
      case 'done':
      case 'idle': {
        if (!turn) break;
        tv.turn = null;
        if (turn.items.length) {
          const last = turn.items[turn.items.length - 1];
          turn.items.slice(0, -1).forEach((it) => { it.done = true; });
          last.chunks = turn.chunks;
          finishItem(last, last.error ? 'error' : 'done');
        } else if (turn.typed) {
          // A typed message mid-call: keep the voice model current without speaking.
          const text = turn.chunks.map((c) => c.trim()).filter(Boolean).pop();
          if (text) tv.engine.thinking(null, `The agent replied in the chat to a typed message: ${speakable(text, 900)}`);
        }
        break;
      }
      default: break;
    }
  }

  /* ---------- lifecycle ---------- */
  // A delegation id is only valid inside the GPT-Live session that created it. After a
  // reconnect, results for older requests go in as session-wide (null) context.
  // app.js's `running` (a turn is running in this chat) — a shared global across classic scripts.
  // Our own voice turn counts only once it has started; before that the agent is busy with something else.
  function agentBusy() {
    let r = false;
    try { r = typeof running !== 'undefined' && !!running; } catch {}
    return r && !(tv.turn && tv.turn.items.length);
  }
  function delegationFor(item) { return item && tv && item.gen === tv.gen ? item.id : null; }

  function makeEngine(call) {
    const engine = window.LiveVoice.create({
      api,
      onState: () => paintStatus(),
      onCaption: (seg) => {
        if (tv !== call) return;
        if (seg.role === 'user') call.lastUserDeltaAt = Date.now();
        setCaption(seg.role, seg.text.slice(-220));
        if (seg.final && call.vsid) api('/api/voice/event', { method: 'POST', body: JSON.stringify({ vsid: call.vsid, events: [{ ts: Date.now(), kind: seg.role === 'user' ? 'user' : 'assistant', text: seg.text }] }) }).catch(() => {});
      },
      onDelegation: (d) => { if (tv === call) onDelegation(d); },
      onError: (err) => { if (err && (err.code || err.message)) console.warn('[thread-voice]', err.code || '', err.message || ''); },
      onClosed: ({ reason }) => {
        if (tv !== call || call.engine !== engine) return;
        // Session cap (2h) or a dropped connection: resume with fresh thread history.
        if ((reason === 'expired' || reason === 'connection_lost') && call.reconnects < 3 && !call.stopping) {
          call.reconnects++;
          setStatus('Reconnecting…');
          setTimeout(() => { if (tv === call) { call.engine = makeEngine(call); connect(call); } }, reason === 'expired' ? 200 : 1500);
          return;
        }
        if (!call.stopping) toast(reason === 'content' ? 'Voice ended by a safety filter' : 'Voice ended');
        cleanup();
      },
    });
    return engine;
  }

  async function start() {
    if (tv) return stop('ended');
    if (!cur || cur.mode === 'bash') { toast('Voice works in a normal chat'); return; }
    if (!window.LiveVoice || !window.RTCPeerConnection) { toast('This browser cannot do live voice'); return; }
    ensureUi(); show(true); setStatus('Connecting…'); setCaption('', '');
    const call = { key: cur.key, awaiting: [], consumedMs: -1, lastUserDeltaAt: 0, lastSent: null, pending: null, reconnects: 0, gen: 0, turn: null, lastTool: '', vsid: null };
    tv = call;
    call.engine = makeEngine(call);
    call.raf = requestAnimationFrame(animate);
    try { call.wake = await navigator.wakeLock.request('screen'); } catch {}
    await connect(call);
  }
  async function connect(call) {
    try {
      const info = await call.engine.start({ scope: 'thread', sessionId: cur.id || '', agent: cur.agent || 'claude', title: cur.title || '', cwd: cur.cwd || '', vsid: call.vsid || undefined });
      if (tv !== call) { call.engine.close(); return; }
      call.vsid = info.vsid;
      call.gen++;
      call.consumedMs = -1; // transcript timestamps restart with each session
      call.lastSent = null; call.pending = null;
      const pending = call.awaiting.filter((a) => !a.done).length;
      call.engine.commentary(null, call.reconnects
        ? `The voice connection was restored. Do not greet again; say "I'm back" and keep listening.${pending ? ' The agent is still working on the last request.' : ''}`
        : `Greet Jimmy in a few words — say you are on this chat and ready${agentBusy() ? ', and that the agent is still finishing an earlier turn, so new requests will queue behind it' : ''} — then pause and listen.`);
      paintStatus();
    } catch (e) {
      if (tv === call) { toast(String((e && e.message) || e).slice(0, 140)); cleanup(); }
    }
  }
  function stop(reason) {
    if (!tv) return;
    tv.stopping = true;
    try { tv.engine.close(); } catch {}
    cleanup();
  }
  function cleanup() {
    if (!tv) return;
    if (tv.raf) cancelAnimationFrame(tv.raf);
    try { tv.wake && tv.wake.release(); } catch {}
    tv = null;
    show(false);
  }

  window.ThreadVoice = {
    start, stop, onChatEvent, get active() { return !!tv; }, _speakable: speakable,
    // Spoken transcript of the current call (debug / e2e).
    transcript: () => (tv ? tv.engine.segments.map((s) => `${s.role}: ${s.text}`).join('\n') : ''),
  };
})();
