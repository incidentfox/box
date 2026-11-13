/* Voice UI kit — the shared visual language of the Voice screen (voice.js) and in-thread
 * voice (thread-voice.js). No dependencies; every DOM/canvas API is feature-checked so the
 * unit tests' fake DOM (node vm) can load it.
 *
 *   createOrb(canvas, { mini })  — a living, audio-reactive gradient orb on a 2D canvas.
 *       orb.set({ phase, thinking, working, hint })   phase: idle|connecting|live|muted|reconnecting|error
 *       orb.levels = () => ({ inp, out })            mic / assistant output level, 0..1
 *       orb.setActive(bool)                           stop drawing while minimized/hidden
 *       orb.mode                                      derived visual mode (see MODES)
 *     While live the orb derives its mode itself (speaking > hearing > thinking > listening,
 *     with hold times so it never flickers); `working` adds the orbiting "agent at work" motif.
 *   createCaptions(scrollEl, jumpBtn) — hero captions: the newest spoken line is big, earlier
 *       turns recede above it; scrolling back pauses auto-follow and shows a "Latest" pill.
 *   pill(label, toolName) / finishPill(el, outcome, { label, meta }) — animated tool status pills.
 *   haptic(kind), primeAudio(), cue(kind), morph(...), exit(...), reducedMotion().
 */
(function () {
  const W_ = typeof window !== 'undefined' ? window : globalThis;
  const doc = W_.document;
  const mq = (q) => { try { return W_.matchMedia ? W_.matchMedia(q) : null; } catch { return null; } };
  const reduceMq = mq('(prefers-reduced-motion: reduce)');
  const reducedMotion = () => !!(reduceMq && reduceMq.matches);
  const isDark = () => { try { return doc.documentElement.dataset.theme === 'dark'; } catch { return false; } };
  const now = () => (W_.performance && W_.performance.now ? W_.performance.now() : Date.now());

  /* ---------- color ---------- */
  const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  const mixc = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

  // Visual modes. c = [deep, mid, light, accent]. Blue = you (listening / hearing),
  // warm sunset = the assistant speaking, violet = thinking. Motion params blend too.
  const MODES = {
    idle:         { c: ['#9aa1a9', '#c2c7cd', '#eef0f2', '#aeb4bc'], glow: '#aab1ba', wob: .008, spin: .14, size: .93, breathe: .014, glowK: .28, shimmer: 0, arc: 0 },
    connecting:   { c: ['#7f97b8', '#adc0d8', '#eef4fb', '#9fa9ff'], glow: '#98acd6', wob: .012, spin: .55, size: .9, breathe: .04, glowK: .4, shimmer: .45, arc: 1 },
    listening:    { c: ['#3a7cff', '#55b4ff', '#c8ecff', '#8b7bff'], glow: '#58a6ff', wob: .016, spin: .3, size: 1, breathe: .02, glowK: .55, shimmer: 0, arc: 0 },
    hearing:      { c: ['#1d63ff', '#1cc4ee', '#b9f4ff', '#6a5aff'], glow: '#38bff3', wob: .03, spin: .6, size: 1.02, breathe: .006, glowK: .72, shimmer: 0, arc: 0 },
    thinking:     { c: ['#5636ea', '#9b6cff', '#e7dcff', '#ff7cc4'], glow: '#9070ff', wob: .02, spin: 1.3, size: .97, breathe: .03, glowK: .62, shimmer: 1, arc: 0 },
    speaking:     { c: ['#ff5f45', '#ff9e57', '#ffe2c8', '#ff4f8e'], glow: '#ff8a5a', wob: .028, spin: .65, size: 1.03, breathe: .006, glowK: .78, shimmer: 0, arc: 0 },
    muted:        { c: ['#767c84', '#a0a5ab', '#e2e4e7', '#8c9198'], glow: '#959ba2', wob: .003, spin: .08, size: .86, breathe: .008, glowK: .16, shimmer: 0, arc: 0 },
    reconnecting: { c: ['#de8124', '#f4b046', '#ffeac2', '#ec7438'], glow: '#f0a040', wob: .012, spin: .5, size: .9, breathe: .045, glowK: .45, shimmer: .35, arc: 1 },
    error:        { c: ['#d33440', '#ff7666', '#ffd7d0', '#b8264f'], glow: '#ff5a5a', wob: .01, spin: .16, size: .9, breathe: .02, glowK: .45, shimmer: 0, arc: 0 },
  };
  const NUMS = ['wob', 'spin', 'size', 'breathe', 'glowK', 'shimmer', 'arc'];
  const PAL = {};
  for (const [k, m] of Object.entries(MODES)) PAL[k] = { ...m, c: m.c.map(hex), glow: hex(m.glow) };

  function accentRgb() {
    try {
      const v = getComputedStyle(doc.documentElement).getPropertyValue('--accent').trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) return hex(v);
    } catch {}
    return hex('#d97757');
  }

  /* ---------- orb ---------- */
  function stubOrb() {
    return { set() {}, setActive() {}, levels: () => ({ inp: 0, out: 0 }), mode: 'idle', onMode: null, destroy() {}, get active() { return false; } };
  }

  function createOrb(canvas, opts = {}) {
    const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return stubOrb();
    const mini = !!opts.mini;
    const state = { phase: 'idle', thinking: false, working: false, hint: '' };
    const cur = { ...PAL.idle, c: PAL.idle.c.map((c) => c.slice()), glow: PAL.idle.glow.slice() };
    let W = 0, dpr = 1, raf = 0, active = true, sleeping = false, sleepT = 0, frames = 0;
    let t = Math.random() * 100, last = 0, lvl = 0, workMix = 0, speakUntil = 0, hearUntil = 0;
    let accent = accentRgb(), dark = isDark();
    const api = {
      levels: () => ({ inp: 0, out: 0 }), mode: 'idle', onMode: null,
      set(s) { Object.assign(state, s || {}); kick(); },
      setActive(on) { active = !!on; if (active) kick(); else stop(); },
      destroy() { active = false; stop(); try { ro && ro.disconnect(); } catch {} },
      get active() { return active && !!raf; },
    };

    function resize() {
      const w = canvas.clientWidth || 0;
      if (!w) return false;
      const d = Math.min(W_.devicePixelRatio || 1, mini ? 3 : 2);
      if (w !== W || d !== dpr) {
        W = w; dpr = d;
        canvas.width = Math.round(w * d); canvas.height = Math.round(w * d);
      }
      return true;
    }
    let ro = null;
    try { if (W_.ResizeObserver) { ro = new W_.ResizeObserver(() => { W = 0; kick(); }); ro.observe(canvas); } } catch {}

    function deriveMode(ts) {
      const p = state.phase;
      if (p !== 'live') return MODES[p] ? p : 'idle';
      let inp = 0, out = 0;
      try { const l = api.levels() || {}; inp = +l.inp || 0; out = +l.out || 0; } catch {}
      if (out > 0.035 || state.hint === 'speaking') speakUntil = ts + 320;
      if (inp > 0.07) hearUntil = ts + 420;
      const mode = ts < speakUntil ? 'speaking' : ts < hearUntil ? 'hearing' : state.thinking ? 'thinking' : 'listening';
      const target = mode === 'speaking' ? out : mode === 'hearing' ? inp : Math.max(inp, out) * 0.35;
      lvlTarget = target;
      return mode;
    }
    let lvlTarget = 0;

    function path(cx, cy, R, amp, ts) {
      const n = mini ? 30 : 72;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        // Liquid surface: a slow 3-lobe swell plus finer ripples (no 2-lobe term: that reads as a lumpy oval).
        const d = 0.48 * Math.sin(3 * a + ts * 1.3) + 0.3 * Math.sin(4 * a - ts * 1.75 + 1.1) + 0.22 * Math.sin(6 * a + ts * 2.2 + 2.3) + 0.14 * Math.sin(9 * a - ts * 3.1);
        const r = R + amp * d;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      ctx.beginPath();
      const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      let m = mid(pts[n - 1], pts[0]);
      ctx.moveTo(m[0], m[1]);
      for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; m = mid(p, q); ctx.quadraticCurveTo(p[0], p[1], m[0], m[1]); }
      ctx.closePath();
    }

    // The thread agent at work: small bright moons orbiting on a tilted ellipse, passing
    // behind (dim) and in front of (bright) the orb, each with a short fading trail.
    function satellites(cx, cy, R, front, ts) {
      if (workMix < 0.01) return;
      const n = 3, Ro = R * (mini ? 1.3 : 1.36), squish = 0.36, tilt = -0.38, sp = 0.95;
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      const size = mini ? 1.6 : 3.1;
      if (!front && !mini) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(tilt); ctx.scale(1, squish);
        ctx.beginPath(); ctx.arc(0, 0, Ro, 0, Math.PI * 2); ctx.restore();
        ctx.lineWidth = 1; ctx.strokeStyle = rgba(accent, 0.13 * workMix); ctx.stroke();
      }
      const trail = mini ? 3 : 9;
      for (let k = 0; k < n; k++) {
        for (let j = trail; j >= 0; j--) {
          const a = ts * sp + (k * Math.PI * 2) / n - j * 0.07;
          const z = Math.sin(a); // + = in front
          if ((z >= 0) !== front) continue;
          const x0 = Math.cos(a) * Ro, y0 = Math.sin(a) * Ro * squish;
          const x = cx + x0 * ct - y0 * st, y = cy + x0 * st + y0 * ct;
          const depth = 0.72 + 0.28 * z;
          const fade = j === 0 ? 1 : (1 - j / (trail + 1)) * 0.45;
          const alpha = workMix * fade * (front ? 1 : 0.4);
          ctx.beginPath(); ctx.arc(x, y, size * depth * (j === 0 ? 1 : 0.8), 0, Math.PI * 2);
          ctx.fillStyle = j === 0 ? rgba(mixc(accent, [255, 255, 255], 0.25), alpha) : rgba(accent, alpha);
          ctx.fill();
          if (j === 0 && !mini) {
            const g = ctx.createRadialGradient(x, y, 0, x, y, size * 4);
            g.addColorStop(0, rgba(accent, 0.35 * alpha)); g.addColorStop(1, rgba(accent, 0));
            ctx.fillStyle = g; ctx.fillRect(x - size * 4, y - size * 4, size * 8, size * 8);
          }
        }
      }
    }

    function draw(ts) {
      const P = cur, cx = W / 2, cy = W / 2;
      const reduce = reducedMotion();
      const base = W * (mini ? 0.33 : 0.3);
      const breathe = reduce ? 0 : P.breathe * Math.sin(ts * 1.7);
      const R = base * P.size * (1 + breathe + lvl * (mini ? 0.14 : 0.12));
      const amp = reduce ? 0 : R * (P.wob * 0.6 + lvl * 0.032);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, W);
      // halo
      const gk = P.glowK * (dark ? 1 : 0.75) * (0.6 + lvl * 0.7);
      // (kept inside the canvas: a halo wider than W/2 shows the canvas's square edge)
      const hr = Math.min(W * 0.495, R * (mini ? 1.5 : 1.7 + lvl * 0.2));
      let g = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, hr);
      g.addColorStop(0, rgba(P.glow, gk * 0.62)); g.addColorStop(0.35, rgba(P.glow, gk * 0.24)); g.addColorStop(0.7, rgba(P.glow, gk * 0.06)); g.addColorStop(1, rgba(P.glow, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, W);
      // connecting / reconnecting: a sweeping arc around the orb
      if (P.arc > 0.02) {
        const ar = R * 1.2, a0 = ts * 3.1, segs = mini ? 10 : 26, span = Math.PI * 1.15;
        ctx.lineCap = 'round'; ctx.lineWidth = mini ? 1.5 : 2.2;
        for (let i = 0; i < segs; i++) {
          ctx.beginPath(); ctx.arc(cx, cy, ar, a0 + (span * i) / segs, a0 + (span * (i + 1)) / segs + 0.02);
          ctx.strokeStyle = rgba(P.c[1], P.arc * 0.85 * ((i + 1) / segs)); ctx.stroke();
        }
      }
      satellites(cx, cy, R, false, ts);
      // body
      path(cx, cy, R, amp, ts);
      ctx.save();
      ctx.clip();
      const ang = ts * P.spin * 0.5;
      const lg = ctx.createLinearGradient(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, cx - Math.cos(ang) * R, cy - Math.sin(ang) * R);
      lg.addColorStop(0, rgba(P.c[0], 1)); lg.addColorStop(1, rgba(P.c[1], 1));
      ctx.fillStyle = lg; ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);
      // Fluid interior: soft colour clouds drifting on Lissajous paths — a deep pool for depth,
      // the accent, a mid tone, and a bright core that swells with the voice.
      const blobs = mini ? 3 : 5;
      const cols = [P.c[0], P.c[3], P.c[1], P.c[2], P.c[3]];
      const alphas = [0.7, 0.8, 0.7, 0.9, 0.55];
      const sizes = [0.95, 0.78, 0.72, 0.62 + lvl * 0.25, 0.5];
      for (let i = 0; i < blobs; i++) {
        const ph = i * 1.7 + 0.4, sp = (0.55 + i * 0.29) * (0.35 + P.spin);
        const orbit = i === 3 ? 0.22 : 0.52;
        const px = cx + Math.cos(ts * sp + ph) * R * orbit, py = cy + Math.sin(ts * sp * 0.79 + ph * 1.37) * R * orbit * 0.92;
        const br = R * sizes[i] * (1 + 0.1 * Math.sin(ts * 1.1 + i * 2));
        const rg = ctx.createRadialGradient(px, py, 0, px, py, br);
        rg.addColorStop(0, rgba(cols[i], alphas[i])); rg.addColorStop(0.55, rgba(cols[i], alphas[i] * 0.45)); rg.addColorStop(1, rgba(cols[i], 0));
        ctx.fillStyle = rg; ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);
      }
      if (P.shimmer > 0.02) { // a light band sweeping across (thinking / connecting)
        const cyc = (ts * 0.55) % 1, off = (cyc * 3.2 - 1.6) * R, a = -0.6;
        const ux = Math.cos(a), uy = Math.sin(a);
        const sx = cx + ux * off, sy = cy + uy * off;
        const sg = ctx.createLinearGradient(sx - ux * R * 0.5, sy - uy * R * 0.5, sx + ux * R * 0.5, sy + uy * R * 0.5);
        sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, `rgba(255,255,255,${(0.32 * P.shimmer).toFixed(3)})`); sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sg; ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);
      }
      // glassy highlight + rim depth
      g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.45, 0, cx - R * 0.3, cy - R * 0.45, R * 0.7);
      g.addColorStop(0, 'rgba(255,255,255,0.42)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);
      g = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.04);
      g.addColorStop(0, rgba(P.c[0], 0)); g.addColorStop(1, rgba(mixc(P.c[0], [0, 0, 0], 0.2), dark ? 0.22 : 0.16));
      ctx.fillStyle = g; ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);
      ctx.restore();
      if (dark && !mini) { path(cx, cy, R, amp, ts); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.stroke(); }
      satellites(cx, cy, R, true, ts);
    }

    function frame(ts) {
      raf = 0;
      if (!active) return;
      // Asleep while hidden (display:none ancestor, detached): poll cheaply instead of drawing.
      if ((frames++ % 20 === 0 || !W) && (!canvas.isConnected || !canvas.offsetWidth || !resize())) { sleep(); return; }
      const dt = Math.min(0.1, last ? (ts - last) / 1000 : 0.016);
      // The minimized orb runs at ~30fps: it is 40px wide and shares the frame with the chat.
      if (mini && last && ts - last < 30) { raf = W_.requestAnimationFrame(frame); return; }
      last = ts;
      const reduce = reducedMotion();
      t += dt * (reduce ? 0.2 : 1);
      const mode = deriveMode(ts);
      if (mode !== api.mode) {
        api.mode = mode;
        try { canvas.dataset.mode = mode; } catch {}
        if (api.onMode) { try { api.onMode(mode); } catch {} }
      }
      const P = PAL[mode] || PAL.idle;
      const k = 1 - Math.exp(-dt / 0.33);
      for (let i = 0; i < 4; i++) cur.c[i] = mixc(cur.c[i], P.c[i], k);
      cur.glow = mixc(cur.glow, P.glow, k);
      for (const n of NUMS) cur[n] += (P[n] - cur[n]) * k;
      const lt = state.phase === 'live' ? lvlTarget : 0;
      lvl += (lt - lvl) * (lt > lvl ? 0.45 : 0.1) * Math.min(1, dt * 60);
      workMix += ((state.working ? 1 : 0) - workMix) * (1 - Math.exp(-dt / 0.45));
      draw(t);
      raf = W_.requestAnimationFrame(frame);
    }
    function kick() {
      if (!active || raf || !W_.requestAnimationFrame) return;
      if (sleeping) { clearTimeout(sleepT); sleeping = false; }
      dark = isDark(); accent = accentRgb();
      last = 0;
      raf = W_.requestAnimationFrame(frame);
    }
    function stop() { if (raf) { W_.cancelAnimationFrame(raf); raf = 0; } clearTimeout(sleepT); sleeping = false; }
    function sleep() { sleeping = true; W = 0; sleepT = setTimeout(() => { sleeping = false; kick(); }, 500); }
    kick();
    return api;
  }

  /* ---------- icons (24×24 stroke) ---------- */
  const svg = (p, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const ICON = {
    calendar: svg('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
    mail: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>'),
    globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.3 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.3-3.6-8.5s1-5.9 3.6-8.5z"/>', 1.8),
    brain: svg('<path d="M12 4.5v15M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.5A3 3 0 0 0 6 18a3 3 0 0 0 6 1.5M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.5A3 3 0 0 1 18 18a3 3 0 0 1-6 1.5M9 4.5a3 3 0 0 1 3 0"/>', 1.8),
    board: svg('<rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M9.5 4v16M15.5 4v10"/>', 1.8),
    agent: svg('<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7.5 10 2.5 2-2.5 2M12.5 15h4"/>'),
    note: svg('<path d="M14 3.5H7a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M14 3.5V9h5.5M8.5 13h7M8.5 16.5h5"/>', 1.8),
    spark: svg('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1-5.1-1.9 5.1-1.9z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>', 1.7),
    flag: svg('<path d="M5 20.5V4.5M5 4.5h11l-2 4 2 4H5"/>'),
    bolt: svg('<path d="M13 3 5 13.5h6L10.5 21 19 10.5h-6z"/>', 1.8),
    send: svg('<path d="M20.5 3.5 10 14M20.5 3.5l-6.5 17-4-6.5-6.5-4z"/>', 1.8),
    check: svg('<path d="M5.5 12.5l4 4 9-9.5"/>', 2.6),
    warn: svg('<path d="M12 7.5v6M12 17.2v.1"/>', 2.8),
    fail: svg('<path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/>', 2.6),
    mic: svg('<rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3"/>'),
    'mic-off': svg('<path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2.5a3 3 0 0 0 4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.6 5M18.4 12.5a6.6 6.6 0 0 0 .1-1.5M12 17.5v3M4 4l16 16"/>'),
    chat: svg('<path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H9l-4.5 3.5V6.5A2.5 2.5 0 0 1 7 4h10.5A2.5 2.5 0 0 1 20 6.5z"/>', 1.9),
    end: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 2.5),
    down: svg('<path d="M6 9.5l6 6 6-6"/>', 2.4),
    up: svg('<path d="M6 14.5l6-6 6 6"/>', 2.4),
  };
  const TOOL_ICON = {
    calendar: 'calendar', calendar_add: 'calendar', gmail_search: 'mail', gmail_read: 'mail', email_jimmy: 'mail',
    web_search: 'globe', deep_research: 'globe', brain_search: 'brain', brain_read: 'brain', brain_save: 'brain',
    linear_board: 'board', linear_create: 'board', linear_update: 'board', linear_issue: 'board', delegate_ticket: 'board',
    needs_jimmy: 'flag', needs_jimmy_resolve: 'flag', get_overview: 'agent', list_sessions: 'agent', check_session: 'agent',
    send_to_session: 'agent', start_agent: 'agent', ask_thread_agent: 'agent', agent: 'agent', check_tasks: 'agent',
    take_note: 'note', read_notes: 'note', get_briefing: 'note', voice_memory: 'note', think_hard: 'spark', file_access: 'note',
  };
  const toolIcon = (name) => ICON[TOOL_ICON[name] || (/^(linear|board)/.test(name || '') ? 'board' : 'bolt')];

  /* ---------- tool pills ---------- */
  function el(tag, cls, text) {
    const d = doc.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function pill(label, toolName) {
    const d = el('div', 'voToolChip vPill run');
    const badge = el('span', 'vPillBadge');
    const spin = el('span', 'voSpin');
    const ic = el('span', 'vPillIc'); ic.innerHTML = toolIcon(toolName);
    badge.appendChild(spin); badge.appendChild(ic);
    const name = el('span', 'voToolName', label);
    const meta = el('span', 'vPillMeta');
    d.appendChild(badge); d.appendChild(name); d.appendChild(meta);
    d._spin = spin; d._name = name; d._ic = ic; d._meta = meta; d._t0 = Date.now();
    return d;
  }
  // outcome: 'ok' | 'warn' (partly failed) | 'fail'. Every finished pill also gets 'done'.
  function finishPill(d, outcome, o = {}) {
    if (!d || d._done) return;
    d._done = true;
    const oc = outcome === 'fail' || outcome === true ? 'fail' : outcome === 'warn' ? 'warn' : 'ok';
    d.classList.remove('run');
    d.classList.add('done'); d.classList.add(oc);
    try { d._spin && d._spin.remove(); } catch {}
    if (d._ic) d._ic.innerHTML = ICON[oc === 'ok' ? 'check' : oc];
    if (o.label && d._name) d._name.textContent = o.label;
    const ms = o.ms != null ? o.ms : Date.now() - (d._t0 || Date.now());
    const meta = o.meta || (ms >= 700 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s` : '');
    if (d._meta) d._meta.textContent = meta;
  }

  /* ---------- captions ---------- */
  function createCaptions(root, jump, opts = {}) {
    const speech = []; // speech lines in order
    let follow = true, touchAt = 0, nowEl = null, prevEl = null;
    const MAX = 120;
    if (root && root.addEventListener) {
      const touched = () => { touchAt = Date.now(); };
      root.addEventListener('touchmove', touched, { passive: true });
      root.addEventListener('wheel', touched, { passive: true });
      root.addEventListener('scroll', () => {
        const gap = root.scrollHeight - root.scrollTop - root.clientHeight;
        if (gap < 56) follow = true;
        else if (Date.now() - touchAt < 1200) follow = false; // only the user's own scroll pauses follow
        if (jump) jump.classList.toggle('show', !follow);
      }, { passive: true });
    }
    if (jump) jump.onclick = () => { follow = true; jump.classList.remove('show'); scroll(true, true); };
    function scroll(force, smooth) {
      if (!root || (!follow && !force)) return;
      if (smooth && root.scrollTo && !reducedMotion()) root.scrollTo({ top: root.scrollHeight, behavior: 'smooth' });
      else root.scrollTop = root.scrollHeight;
    }
    function trim() {
      while (root.childNodes.length > MAX) {
        const f = root.firstChild;
        const i = speech.indexOf(f); if (i >= 0) speech.splice(i, 1);
        root.removeChild(f);
      }
    }
    let hintEl = null;
    function showHint() {
      if (!opts.hint || !root || hintEl) return;
      hintEl = el('div', 'voHint vEmpty', opts.hint);
      root.appendChild(hintEl);
    }
    function add(node) {
      if (hintEl) { try { root.removeChild(hintEl); } catch {} hintEl = null; }
      root.appendChild(node); trim(); refresh(); return node;
    }
    function line(role, text) {
      const d = el('div', `voBub ${role} vLine`);
      d.textContent = text || '';
      if (role === 'user' || role === 'asst') speech.push(d);
      return add(d);
    }
    // Mark the newest non-empty spoken line as the hero, the one before it as the echo.
    function refresh() {
      let n = null, p = null;
      for (let i = speech.length - 1; i >= 0; i--) {
        if (!String(speech[i].textContent || '').trim()) continue;
        if (!n) n = speech[i]; else { p = speech[i]; break; }
      }
      if (n !== nowEl) {
        if (nowEl) nowEl.classList.remove('now');
        if (n) n.classList.add('now');
        nowEl = n;
      }
      if (p !== prevEl) {
        if (prevEl) prevEl.classList.remove('prev');
        if (p) p.classList.add('prev');
        prevEl = p;
      }
      if (n) {
        const long = String(n.textContent).length > 170;
        if (n._long !== long) { n._long = long; n.classList.toggle('long', long); }
      }
      scroll();
    }
    function clear() {
      speech.length = 0; nowEl = prevEl = null; follow = true;
      if (jump) jump.classList.remove('show');
      if (root) while (root.firstChild) root.removeChild(root.firstChild);
      hintEl = null; showHint();
    }
    function forget(node) { const i = speech.indexOf(node); if (i >= 0) speech.splice(i, 1); try { node.remove(); } catch {} refresh(); }
    return {
      line, add, refresh, clear, forget,
      notice: (text) => line('notice', text),
      pill: (label, tool) => add(pill(label, tool)),
      scroll: (force) => scroll(force),
      get following() { return follow; },
    };
  }

  /* ---------- haptics + sound cues ---------- */
  const PATTERNS = { tap: 8, start: [12, 50, 18], end: [18, 40, 10], done: [10, 70, 10], error: [28, 50, 28] };
  function iosTick() {
    // iOS Safari has no navigator.vibrate; toggling a hidden <input switch> plays the system haptic (iOS 18+).
    try {
      const lab = el('label'); lab.setAttribute('aria-hidden', 'true'); lab.style.display = 'none';
      const inp = el('input'); inp.type = 'checkbox'; inp.setAttribute('switch', '');
      lab.appendChild(inp); doc.head.appendChild(lab); lab.click(); doc.head.removeChild(lab);
    } catch {}
  }
  function haptic(kind) {
    const p = PATTERNS[kind] || 8;
    try { if (W_.navigator && typeof W_.navigator.vibrate === 'function') { W_.navigator.vibrate(p); return; } } catch {}
    const n = Array.isArray(p) ? Math.ceil(p.length / 2) : 1;
    for (let i = 0; i < n; i++) setTimeout(iosTick, i * 110);
  }
  let actx = null;
  // Create/resume inside the user's tap — iOS only lets a gesture unlock audio.
  function primeAudio() {
    try {
      const AC = W_.AudioContext || W_.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume().catch(() => {});
    } catch {}
  }
  // Soft two-note sine chimes, ~-30 dB: present but never louder than the voice.
  const CUES = { start: [[659.25, 0], [987.77, 0.085]], end: [[783.99, 0], [523.25, 0.095]], done: [[880, 0], [1174.66, 0.07]] };
  function cue(kind) {
    const notes = CUES[kind];
    if (!notes || !actx) return;
    try {
      const t0 = actx.currentTime + 0.01;
      for (const [f, at] of notes) {
        for (const [mul, vol] of [[1, 0.045], [2, 0.008]]) {
          const o = actx.createOscillator(), g = actx.createGain();
          o.type = 'sine'; o.frequency.value = f * mul;
          g.gain.setValueAtTime(0.0001, t0 + at);
          g.gain.exponentialRampToValueAtTime(vol, t0 + at + 0.014);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.34);
          o.connect(g); g.connect(actx.destination);
          o.start(t0 + at); o.stop(t0 + at + 0.36);
        }
      }
    } catch {}
  }

  /* ---------- transitions ---------- */
  const EASE = 'cubic-bezier(.2,.85,.25,1)';
  const canAnimate = (node) => !!(node && typeof node.animate === 'function');
  const inset = (r, rad) => {
    const vw = W_.innerWidth, vh = W_.innerHeight;
    return `inset(${Math.max(0, r.top).toFixed(1)}px ${Math.max(0, vw - r.right).toFixed(1)}px ${Math.max(0, vh - r.bottom).toFixed(1)}px ${Math.max(0, r.left).toFixed(1)}px round ${rad}px)`;
  };
  const rectOf = (node) => { try { const r = node && node.getBoundingClientRect(); return r && r.width ? r : null; } catch { return null; } };
  // Shared-element morph between a small source (the minimized bar / the composer button)
  // and a full-screen surface: the surface's clip grows out of the source rect while the big
  // orb flies from the small orb's spot; chrome fades in behind it. Reverse to collapse.
  // Resolves when done; with no WAAPI or reduced motion it is a short fade (or instant).
  // crossfade: the source stays visible underneath (the bar), so the surface fades in over the
  // first quarter / out over the last quarter and the two blend instead of popping.
  function morph({ surface, from, fromRadius = 22, orb, orbFrom, fade = [], open = true, duration = 440, crossfade = false }) {
    if (!canAnimate(surface)) return Promise.resolve();
    const reduce = reducedMotion();
    const anims = [];
    const fr = rectOf(from);
    try {
      if (reduce || !fr) {
        anims.push(surface.animate([{ opacity: open ? 0 : 1 }, { opacity: open ? 1 : 0 }], { duration: reduce ? 160 : 240, easing: 'ease', fill: 'both' }));
      } else {
        const full = 'inset(0px 0px 0px 0px round 0px)', small = inset(fr, fromRadius);
        const ease = open ? EASE : 'cubic-bezier(.4,0,.2,1)';
        anims.push(surface.animate([{ clipPath: open ? small : full }, { clipPath: open ? full : small }], { duration, easing: ease, fill: 'both' }));
        if (crossfade) {
          const k = open ? [{ opacity: 0 }, { opacity: 1, offset: 0.22 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }];
          anims.push(surface.animate(k, { duration, easing: 'linear', fill: 'both' }));
        }
        const or = rectOf(orb), sr = rectOf(orbFrom);
        if (or && sr) {
          const dx = sr.left + sr.width / 2 - (or.left + or.width / 2), dy = sr.top + sr.height / 2 - (or.top + or.height / 2);
          const s = Math.max(0.12, sr.width / or.width);
          const a = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${s.toFixed(3)})`, b = 'translate(0px, 0px) scale(1)';
          anims.push(orb.animate([{ transform: open ? a : b }, { transform: open ? b : a }], { duration, easing: ease, fill: 'both' }));
        }
        for (const f of fade) {
          if (!canAnimate(f)) continue;
          const k = open
            ? [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0px)' }]
            : [{ opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(10px)' }];
          anims.push(f.animate(k, { duration: open ? duration * 0.8 : duration * 0.45, delay: open ? duration * 0.28 : 0, easing: EASE, fill: 'both' }));
        }
      }
    } catch { /* clip-path unsupported → no animation */ }
    if (!anims.length) return Promise.resolve();
    return Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => { for (const a of anims) { try { a.cancel(); } catch {} } });
  }
  // Graceful exit: scale down + fade, then the caller hides the node.
  function exit(node, { duration = 260, scale = 0.96, y = 0 } = {}) {
    if (!canAnimate(node) || reducedMotion()) return Promise.resolve();
    try {
      const a = node.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${y}px) scale(${scale})` }], { duration, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' });
      return a.finished.catch(() => {}).then(() => { try { a.cancel(); } catch {} });
    } catch { return Promise.resolve(); }
  }
  function enter(node, { duration = 320, y = 10, scale = 1 } = {}) {
    if (!canAnimate(node) || reducedMotion()) return;
    try { node.animate([{ opacity: 0, transform: `translateY(${y}px) scale(${scale})` }, { opacity: 1, transform: 'none' }], { duration, easing: EASE }); } catch {}
  }

  // Human status label for an orb mode (used under the orb).
  const MODE_LABEL = { idle: '', connecting: 'Connecting…', listening: 'Listening', hearing: 'Listening', thinking: 'Thinking…', speaking: 'Speaking', muted: 'Muted', reconnecting: 'Reconnecting…', error: 'Something went wrong' };

  W_.VoiceUI = { createOrb, createCaptions, pill, finishPill, toolIcon, ICON, haptic, primeAudio, cue, morph, exit, enter, reducedMotion, MODES: Object.keys(MODES), MODE_LABEL };
})();
