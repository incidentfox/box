'use strict';
const $ = (id) => document.getElementById(id);
const LS = localStorage;
let TOKEN = LS.getItem('cc_token') || '';
let ws = null;
// Keep in lock-step with the server's DEFAULT_SETTINGS (server/index.mjs) so the model
// chip shows what a chat ACTUALLY runs with, not a stale guess.
const DEFAULT_SETTINGS = {
  codex: { model: 'gpt-5.5', reasoningEffort: 'high' },
  gemini: { model: 'gemini-3.5-flash' },
  agy: { model: '' },
  claude: { model: 'opus', effort: 'xhigh' },
};
const AGENT_META = {
  claude: { label: 'Claude', icon: '⌘' },
  codex: { label: 'Codex', icon: '◆' },
  gemini: { label: 'Gemini', icon: '✦' },
  agy: { label: 'Antigravity', icon: '△' },
};
const AGENT_LABEL = Object.fromEntries(Object.entries(AGENT_META).map(([k, v]) => [k, v.label]));
const DEFAULT_CONTEXT_WINDOW = { codex: 258400, claude: 1000000, gemini: 1000000, agy: 1000000 };
const agentLabel = (agent) => (AGENT_META[agent] && AGENT_META[agent].label) || 'Claude';
const agentIcon = (agent) => (AGENT_META[agent] && AGENT_META[agent].icon) || '⌘';
const agentType = (agent) => (agent === 'codex' || agent === 'gemini' || agent === 'agy') ? agent : 'claude';
const agentBranch = (agent) => (agent === 'codex' ? 'codex' : agent === 'gemini' ? 'gemini' : agent === 'agy' ? 'agy' : 'claude');
const agentModelLabel = (agent, rawModel) => {
  const raw = String(rawModel || '');
  if (!raw) return '';
  const found = (agent === 'codex' ? CODEX_MODELS : agent === 'gemini' ? GEMINI_MODELS : agent === 'agy' ? AGY_MODELS : CLAUDE_MODELS).find((m) => m.id === raw);
  if (found) return found.label;
  if (agent === 'agy') return raw ? raw.replace(/-/g, ' ') : 'Antigravity default';
  if (agent === 'gemini') return raw.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ');
  if (agent === 'codex') return raw.replace(/^gpt-/, 'GPT-').replace(/-/g, ' ');
  return raw.replace(/^claude-/, '').replace(/^(opus|sonnet|haiku|fable).*/, (m, p) => p.charAt(0).toUpperCase() + p.slice(1));
};
let cur = { id: null, cwd: '', title: '', mode: 'normal', agent: agentType(LS.getItem('box_agent') || 'claude'), parentId: null, parentTitle: '', settings: { codex: { ...DEFAULT_SETTINGS.codex }, gemini: { ...DEFAULT_SETTINGS.gemini }, agy: { ...DEFAULT_SETTINGS.agy }, claude: { ...DEFAULT_SETTINGS.claude } }, context: null };
let images = [];            // composer attachment buffer: [{path, url, name, isImage}]
let waitingState = null;    // pending interactive prompt (AskUserQuestion / plan / permission) or null
let commandsCache = {};
let pipeView = 'list';   // 'list' | 'detail' — for the Pipelines swipe-back target

/* ---------- viewport / keyboard (keeps composer above keyboard) ---------- */
const vv = window.visualViewport;
function applyVV() {
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  if (vv && vv.offsetTop) window.scrollTo(0, 0);
}
if (vv) { vv.addEventListener('resize', applyVV); vv.addEventListener('scroll', applyVV); }
applyVV();

/* ---------- native feel: kill whole-app pinch-zoom ----------
   iOS Safari ignores `user-scalable=no` in the viewport tag, so the shell can still be
   pinch-zoomed into a half-scrolled mess. These cancel the pinch gesture itself (double-tap
   zoom + tap delay are handled by `touch-action: manipulation` in CSS). The image lightbox
   does its own JS pan/zoom, so nothing user-facing loses zoom. */
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

/* ---------- helpers ---------- */
const TOP_SCREENS = ['login', 'sessions', 'chat', 'pipelines', 'board', 'issue', 'issueNew'];
const desktopMq = window.matchMedia ? window.matchMedia('(min-width: 900px)') : null;
const isDesktopShell = () => !!(desktopMq && desktopMq.matches);
function show(id) {
  document.body.dataset.view = id;
  TOP_SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id));
}

/* ---------- history-synced navigation (browser Back / Forward) ---------- */
// The app is one page that toggles top-level <section> "screens" (plus the chat's
// attention overlay). Without this, the browser Back button left the app entirely
// instead of stepping back a screen. We mirror every FORWARD navigation into the
// History API and re-render the previous screen on `popstate`, so the browser
// Back/Forward buttons, the in-app back arrows, and swipe-back all walk one stack.
let navSuppress = false;   // true while restoring a popped route, so the render itself doesn't re-push
const routeKey = (s) => (s ? [s.view, s.id || '', s.filter || ''].join('|') : '');
function navTo(state, { replace = false } = {}) {
  if (navSuppress) return;                       // we're rendering a popped route — don't push
  const prev = history.state;
  // Replace (don't grow the stack) for: first entry, an explicit replace, the same
  // screen re-rendering (e.g. re-filtering the list / refresh), or stepping off the
  // login screen — so Back from the list leaves the app instead of flashing login.
  if (!prev || replace || routeKey(prev) === routeKey(state) || prev.view === 'login') {
    try { history.replaceState(state, ''); } catch {}
    return;
  }
  try { history.pushState(state, ''); } catch {}
}
function renderRoute(s) {
  navSuppress = true;
  try {
    if (!TOKEN) { show('login'); return; }
    // leaving the chat → drop the live socket (matches the old goBackFromChat)
    if (s && s.view !== 'chat' && s.view !== 'chatAttn' && ws) { try { ws.close(); } catch {} }
    const chatVisible = () => !$('chat').classList.contains('hidden');
    switch (s && s.view) {
      case 'login':     show('login'); break;
      case 'pipelines': openPipelines(); break;
      case 'board':     openBoard(); break;
      case 'issue':     openIssue(s.id); break;
      case 'issueNew':  openIssueNew(); break;
      case 'chat':
        if (s.id && cur.id === s.id && chatVisible()) { if (attnMode) closeAttention(); break; } // just closing the overlay
        if (attnMode) closeAttention();
        if (s.id) openChat({ id: s.id, title: s.title, agent: s.agent });
        else if (s.key && cur.key === s.key) { show('chat'); if (!ws || ws.readyState > 1) connectWS(); }
        else openSessions();
        break;
      case 'chatAttn':
        if (s.id && cur.id === s.id && chatVisible()) { if (!attnMode) showAttention(); }
        else if (s.id) { openChat({ id: s.id, title: s.title, agent: s.agent }).then(() => showAttention()); }
        else if (s.key && cur.key === s.key) { show('chat'); if (!ws || ws.readyState > 1) connectWS(); if (!attnMode) showAttention(); }
        else openSessions();
        break;
      case 'sessions':
      default:          openSessions((s && s.filter) || 'all'); break;
    }
  } finally { navSuppress = false; }
}
window.addEventListener('popstate', (e) => renderRoute(e.state));
function toast(m, ms = 2200, action) {
  const t = $('toast'); t.innerHTML = '';
  const label = document.createElement('span'); label.textContent = m; t.appendChild(label);
  if (action && action.label && action.fn) {
    const b = document.createElement('button'); b.className = 'toastAct'; b.type = 'button'; b.textContent = action.label;
    b.onclick = (e) => { e.stopPropagation(); clearTimeout(t._t); t.classList.add('hidden'); action.fn(); };
    t.appendChild(b);
  }
  t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms);
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isPlaceholderChatTitle = (s) => /^New (Claude |Codex )?chat$/i.test(String(s || '').trim());
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { Authorization: 'Bearer ' + TOKEN, ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (r.status === 401) { throw new Error('unauthorized'); }   // never auto-logout — token is long & annoying to re-enter
  return r;
}
// Client bootstrap (filled from /api/config): $HOME for path-shortening + which optional
// integrations are wired, so we can hide the Board / Linear UI when they aren't set up.
let CFG = { home: '', ownerName: 'you', features: { linear: false, brain: false, voice: false, codex: false, gemini: false, agy: false } };
async function loadConfig() {
  try { CFG = await (await api('/api/config')).json(); } catch {}
  applyConfig();
}
function applyConfig() {
  const f = (CFG && CFG.features) || {};
  const setVis = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
  setVis('boardBtn', !!f.linear);       // header Linear-board button
  setVis('attnTabLinear', !!f.linear);  // Linear tab in the needs-attention panel
}
function scrollBottom(smooth) { const m = $('messages'); m.scrollTo({ top: m.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); updateToBottom(); }
function atBottom() { const m = $('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 90; }
function maybeScroll() { if (atBottom()) scrollBottom(); else updateToBottom(); }
function updateToBottom() { const b = $('toBottom'); if (b) b.classList.toggle('hidden', atBottom()); }
$('messages').addEventListener('scroll', updateToBottom);
$('toBottom').onclick = () => scrollBottom(true);

// Swipe right to go back from the chat — iOS-native: only from the LEFT EDGE
// (a ~36px band, like the system interactive-pop gesture), not the left third.
// Engages only on a clearly RIGHTWARD, horizontal-dominant drag, and never on code
// blocks / inputs (so their scroll/typing still works) or vertical scrolls. Mirrors
// the top-left back button: closes the bell panel if open, else returns to the list.
(function swipeBack() {
  const el = $('chat'); let sx = 0, sy = 0, tracking = false, decided = false, horiz = false;
  const EDGE = 36;   // left-edge band (CSS px) ≈ iOS edge-pan; not a third of the screen
  const reset = () => { el.style.transition = 'transform .18s ease'; el.style.transform = ''; setTimeout(() => { el.style.transition = ''; }, 200); };
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    tracking = t.clientX < EDGE && !(e.target.closest && e.target.closest('pre, code, textarea, input, select, .hljs'));
    sx = t.clientX; sy = t.clientY; decided = false; horiz = false;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true; horiz = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2;
      if (!horiz) { tracking = false; el.style.transform = ''; return; }   // vertical → let it scroll
      el.style.transition = '';
    }
    e.preventDefault();                                   // own the gesture (no scroll/selection)
    el.style.transform = `translateX(${Math.min(Math.max(dx, 0), 140)}px)`;
  }, { passive: false });
  const end = (e) => {
    if (!tracking) return; tracking = false;
    const dx = ((e.changedTouches[0] || {}).clientX || sx) - sx;
    reset();
    if (horiz && dx > 70) goBackFromChat();   // handles the attention overlay + history itself
  };
  el.addEventListener('touchend', end, { passive: true });
  el.addEventListener('touchcancel', end, { passive: true });
})();

// swipe from the left edge inside Pipelines: detail → list → sessions
(function pipesSwipeBack() {
  const el = $('pipelines'); if (!el) return;
  let sx = 0, sy = 0, tracking = false;
  el.addEventListener('touchstart', (e) => { const t = e.touches[0]; tracking = t.clientX < 30; sx = t.clientX; sy = t.clientY; }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!tracking) return; const t = e.touches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dy) > Math.abs(dx) + 8) { tracking = false; el.style.transform = ''; return; }
    if (dx > 0) el.style.transform = `translateX(${Math.min(dx, 130)}px)`;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!tracking) return; tracking = false;
    const dx = e.changedTouches[0].clientX - sx;
    el.style.transition = 'transform .18s ease'; el.style.transform = '';
    setTimeout(() => { el.style.transition = ''; }, 200);
    if (dx > 75) { if (pipeView === 'detail') openPipelines(); else history.back(); }
  }, { passive: true });
})();

/* ---------- SVG icons (native-style) ---------- */
const SVG = (p, o = {}) => `<svg viewBox="0 0 24 24" fill="${o.fill || 'none'}" stroke="${o.fill ? 'none' : 'currentColor'}" stroke-width="${o.w || 2}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  plus: SVG('<path d="M12 5v14M5 12h14"/>'),
  back: SVG('<path d="M15 5l-7 7 7 7"/>', { w: 2.3 }),
  power: SVG('<path d="M12 4v8M7.5 7a8 8 0 1 0 9 0"/>'),
  folder: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  pencil: SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  paperclip: SVG('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  mic: SVG('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/>'),
  send: SVG('<path d="M12 19V5M5 12l7-7 7 7"/>', { w: 2.4 }),
  stop: SVG('<rect x="6" y="6" width="12" height="12" rx="3"/>', { fill: 'currentColor' }),
  close: SVG('<path d="M6 6l12 12M18 6L6 18"/>', { w: 2.2 }),
  check: SVG('<path d="M5 13l4 4L19 7"/>', { w: 2.4 }),
  code: SVG('<path d="M8 9l-3 3 3 3M16 9l3 3-3 3"/>', { w: 2.1 }),
  at: SVG('<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>', { w: 1.8 }),
  file: SVG('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
  fold: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  'arrow-up-dir': SVG('<path d="M12 19V6M6 12l6-6 6 6"/>', { w: 2.1 }),
  laptop: SVG('<rect x="4" y="5" width="16" height="11" rx="1.6"/><path d="M2 20h20"/>', { w: 1.8 }),
  'arrow-down': SVG('<path d="M12 5v14M5 12l7 7 7-7"/>', { w: 2.2 }),
  pulse: SVG('<path d="M3 12h4l3 8 4-16 3 8h4"/>', { w: 2 }),
  moon: SVG('<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.7 6.7 0 0 0 9.8 9.8z"/>', { w: 2 }),
  sun: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>', { w: 2 }),
  clipboard: SVG('<rect x="9" y="2" width="6" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>', { w: 2 }),
  copy: SVG('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', { w: 2 }),
  trash: SVG('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h2a2 2 0 0 1 2 2v2"/>', { w: 1.9 }),
  archive: SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>', { w: 1.9 }),
  unarchive: SVG('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M12 17v-6M8.5 14.5L12 11l3.5 3.5"/>', { w: 1.9 }),
  bell: SVG('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>', { w: 2 }),
  list: SVG('<path d="M8 6h13M8 12h13M8 18h11"/><circle cx="3.5" cy="6" r="1" fill="currentColor"/><circle cx="3.5" cy="12" r="1" fill="currentColor"/><circle cx="3.5" cy="18" r="1" fill="currentColor"/>', { w: 2 }),
  board: SVG('<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="14" rx="1"/>', { w: 1.9 }),
  search: SVG('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>', { w: 2 }),
};
function paintIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((el) => { if (!el._painted) { el.innerHTML = ICONS[el.dataset.icon] || ''; el._painted = 1; } }); }

const THEME_KEY = 'box_theme';
const themeMq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
function resolveTheme(theme) { return theme === 'dark' || (theme !== 'light' && themeMq && themeMq.matches) ? 'dark' : 'light'; }
function applyTheme(theme = LS.getItem(THEME_KEY) || 'auto') {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#101214' : '#faf9f7');
  const btn = $('themeBtn');
  if (btn) { btn.dataset.icon = resolved === 'dark' ? 'sun' : 'moon'; btn._painted = 0; btn.innerHTML = ''; paintIcons(btn.parentElement || document); }
}
function setTheme(theme) { LS.setItem(THEME_KEY, theme); applyTheme(theme); toast(`Theme: ${theme}`); }
// One tap flips straight between light and dark off whatever's currently showing — no sheet, no Auto.
function toggleTheme() { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
if (themeMq) {
  const syncTheme = () => { if ((LS.getItem(THEME_KEY) || 'auto') === 'auto') applyTheme('auto'); };
  if (themeMq.addEventListener) themeMq.addEventListener('change', syncTheme);
  else if (themeMq.addListener) themeMq.addListener(syncTheme);
}
applyTheme();

/* ---------- markdown (compact, for chat bubbles) ---------- */
function md(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let html = '', i = 0, list = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  // Like esc() but won't double-encode existing HTML entities (&amp; &lt; &#123; etc.)
  const safeEsc = (t) => t.replace(/&(?![#a-zA-Z]\w*;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t) => {
    const codes = [];
    // Stash code spans behind private-use sentinels so digit placeholder indices
    // can't clash with real numbers in the text (dates, bill #s, counts).
    t = safeEsc(t).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `${codes.length - 1}`; });
    // images before links so ![ doesn't partially match the link regex
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      src = src.trim();
      const isHttp = /^https?:\/\//i.test(src);
      const looksImg = /\.(png|jpe?g|gif|webp|svg|bmp|heic|avif)(\?|#|$)/i.test(src);
      // A non-image http(s) URL embedded as a "screenshot" (e.g. a dashboard webpage the
      // status model mistook for an image) → render as a labelled link, not a broken <img>.
      if (isHttp && !looksImg) return `<a href="${esc(src)}" target="_blank">${esc(alt || src)}</a>`;
      // A relative/placeholder path (path/to/x.png — no leading slash) never resolves → its label.
      if (!isHttp && !src.startsWith('/')) return alt ? esc(alt) : '';
      const url = isHttp ? src : rawFileUrl(src);
      // onerror: a missing/stale file should vanish, not leave a broken-image placeholder box.
      return `<img class="mdImg" src="${esc(url)}" alt="${esc(alt)}" onerror="this.style.display='none'">`;
    });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank">$2</a>');
    return t.replace(/(\d+)/g, (_, n) => `<code>${safeEsc(codes[+n] ?? '')}</code>`);
  };
  const isTableRow = (ln) => /^\|.+\|$/.test(ln.trim());
  const isSepRow  = (ln) => /^\|[-|: ]+\|$/.test(ln.trim());
  while (i < lines.length) {
    const ln = lines[i];
    // fenced code block
    if (/^```/.test(ln)) { closeList(); const lang = ln.slice(3).trim(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; html += `<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(buf.join('\n'))}</code></pre>`; continue; }
    // horizontal rule
    if (/^[ ]{0,3}([-*_][ ]{0,2}){3,}$/.test(ln.trim()) && ln.trim().length >= 3) { closeList(); html += '<hr>'; i++; continue; }
    // headings
    const h = ln.match(/^(#{1,3})\s+(.*)/); if (h) { closeList(); const l = h[1].length; html += `<h${l}>${inline(h[2])}</h${l}>`; i++; continue; }
    // tables — header + separator row
    if (isTableRow(ln) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      closeList();
      const parseCells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const headers = parseCells(ln); i += 2;
      html += '<div class="mdtbl"><table><thead><tr>' + headers.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lines.length && isTableRow(lines[i])) { html += '<tr>' + parseCells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++; }
      html += '</tbody></table></div>'; continue;
    }
    // list items — keep list open across blank lines if the next non-blank is the same type
    const li = ln.match(/^[ \t]*([-*]|\d+\.)\s+(.*)/);
    if (li) { const t = /\d/.test(li[1]) ? 'ol' : 'ul'; if (list !== t) { closeList(); html += `<${t}>`; list = t; } html += `<li>${inline(li[2])}</li>`; i++; continue; }
    if (/^\s*$/.test(ln)) {
      if (list) {
        let j = i + 1; while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        const peek = j < lines.length && lines[j].match(/^[ \t]*([-*]|\d+\.)\s/);
        const pt = peek && (/\d/.test(peek[1]) ? 'ol' : 'ul');
        if (!peek || pt !== list) closeList();
      }
      i++; continue;
    }
    closeList(); const buf = [ln]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,3}\s|```|[ \t]*([-*]|\d+\.)\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    html += `<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`;
  }
  closeList(); return html;
}

/* ---------- login ---------- */
$('loginBtn').onclick = login;
$('tokenInput').onkeydown = (e) => { if (e.key === 'Enter') login(); };
async function login() {
  const token = $('tokenInput').value.trim(); if (!token) return;
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!r.ok) { $('loginErr').textContent = 'Wrong token'; return; }
  TOKEN = token; LS.setItem('cc_token', token); loadConfig(); openSessions();
}
function logout() { LS.removeItem('cc_token'); TOKEN = ''; if (ws) ws.close(); navTo({ view: 'login' }, { replace: true }); show('login'); }

/* ---------- sessions ---------- */
let defaultCwd = '';  // filled from /api/sessions (server's CC_WORKSPACE / $HOME)
let allSessions = [], sessionCounts = { all: 0 }, curFilter = 'all';
let chatRenderSeq = 0;
const STATUS_TABS = [['all', 'All'], ['needs_input', 'Needs input'], ['working', 'Working'], ['live', 'Live'], ['auto', 'Automated'], ['archived', 'Archived']];
// subcategories shown as a second chip row when the Automated tab is active
const AUTO_SUBS = [['healer', 'Healer'], ['scheduled', 'Scheduled'], ['other-auto', 'Other']];
const STATUS_LABEL = { working: 'Working', needs_input: 'Needs input', live: 'Connected', archived: 'Archived' };  // idle has no label

async function openSessions(filter = 'all') { navTo({ view: 'sessions', filter }); show('sessions'); await fetchSessions(filter); }
async function fetchSessions(filter) {
  curFilter = filter || 'all';
  const d = await (await api('/api/sessions?filter=' + curFilter)).json();
  defaultCwd = d.defaultCwd; cur.cwd = cur.cwd || d.defaultCwd;
  allSessions = d.sessions || [];
  sessionCounts = d.counts || { all: allSessions.length };
  renderTabs(); renderSessionList(); paintIcons($('sessions'));
}
function renderTabs() {
  const c = sessionCounts; const wrap = $('tabs'); wrap.innerHTML = '';
  const base = curFilter.split(':')[0];
  for (const [k, label] of STATUS_TABS) {
    if (k !== 'all' && !c[k] && base !== k) continue;
    const t = document.createElement('button'); t.className = 'tab' + (base === k ? ' on' : '');
    t.innerHTML = `${label}<span class="tcount">${c[k] || 0}</span>`;
    t.onclick = () => fetchSessions(k);
    wrap.appendChild(t);
  }
  // when Automated is active, show a second row breaking it into subcategories
  const srow = $('subtabs'); if (!srow) return;   // tolerate a stale cached index.html
  srow.innerHTML = ''; srow.classList.toggle('hidden', base !== 'auto');
  if (base === 'auto') {
    const sub = c.autoSub || {};
    const mk = (key, label, count) => {
      const want = key ? 'auto:' + key : 'auto';
      const b = document.createElement('button'); b.className = 'tab' + (curFilter === want ? ' on' : '');
      b.innerHTML = `${label}<span class="tcount">${count}</span>`;
      b.onclick = () => fetchSessions(want);
      srow.appendChild(b);
    };
    mk('', 'All', c.auto || 0);
    // Label buckets via overlay subLabels first, then built-in defaults, then a humanized key.
    const labelMap = Object.assign({}, Object.fromEntries(AUTO_SUBS), (CFG && CFG.subLabels) || {});
    const humanize = (k) => k.replace(/(^|[-_])(\w)/g, (m, s, ch) => (s ? ' ' : '') + ch.toUpperCase());
    const order = [...AUTO_SUBS.map(([k]) => k), ...Object.keys((CFG && CFG.subLabels) || {}), ...Object.keys(sub)];
    const seen = new Set();
    for (const k of order) {
      if (seen.has(k) || !sub[k]) continue;
      seen.add(k);
      mk(k, labelMap[k] || humanize(k), sub[k]);
    }
  }
}
function timeGroup(ms) {
  const now = new Date(), d = new Date(ms);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(now, d)) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1); if (sameDay(y, d)) return 'Yesterday';
  if (now - ms < 7 * 864e5) return 'This week';
  return 'Earlier';
}
function relTime(ms) {
  if (!ms) return '';   // live bridge with no recorded activity yet (no jsonl) — avoid a bogus "Dec 31"
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h'; if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
// In the Archived view, sort/group/label by WHEN it was archived (so a chat you just
// archived shows up at the very top under "Today"), falling back to last-activity for
// legacy archives. Everywhere else, last-activity time.
const cardTime = (s) => (curFilter === 'archived' && s.archivedAt ? s.archivedAt : s.mtime);
function renderSessionList() {
  const list = $('sessionList'); list.innerHTML = '';
  const items = allSessions;   // server already filtered by curFilter
  if (!items.length) { list.innerHTML = '<p class="empty">No chats here.</p>'; return; }
  let group = null;
  for (const s of items) {
    // Pinned (live) sessions are sorted to the top by the server. Group them ALL under
    // one "Live" header instead of letting them fall into time buckets — otherwise a
    // pinned "Today" item and a non-pinned "Today" item each emit their own header,
    // duplicating Today/This week/Earlier down the list (the reported bug).
    const g = s.pinned ? 'Live' : timeGroup(cardTime(s));
    if (g !== group) { group = g; const h = document.createElement('div'); h.className = 'grouphd'; h.textContent = g; list.appendChild(h); }
    list.appendChild(sessionCard(s));
  }
}
function sessionCard(s) {
  const el = document.createElement('div'); el.className = 'sCard';
  if (cur && cur.id && s.id === cur.id) el.classList.add('current');
  const agent = s.agent || 'claude';
  const sub = s.parentId ? `Fork of ${s.parentTitle || s.parentId.slice(0, 8)}` : (s.note ? s.note : shortCwd(s.cwd));
  const label = STATUS_LABEL[s.status];
  const arch = s.archived;
  el.innerHTML =
    `<div class="sActions">
       <button class="sAct edit" type="button"><span class="sActIc">✎</span>Edit</button>
       <button class="sAct ${arch ? 'unarch' : 'arch'} archBtn" type="button"><span class="sActIc">${arch ? '⤴' : '🗄'}</span>${arch ? 'Unarchive' : 'Archive'}</button>
     </div>
     <div class="sCardFront">
       <div class="srow">
         <div class="savatar ${s.status}">${s.status === 'idle' ? '' : '<span class="sdot"></span>'}</div>
         <div class="hd">
	         <div class="nmrow"><span class="nm"></span>${s.parentId ? '<span class="agentTag fork">Fork</span>' : ''}${agent !== 'claude' ? `<span class="agentTag ${agent}">${agentLabel(agent)}</span>` : ''}${s.hasAttention ? '<span class="attnDot" title="Needs your input"></span>' : ''}<span class="time">${relTime(cardTime(s))}</span><button class="sMore" type="button" title="More actions (rename / archive)" aria-label="More actions">⋯</button></div>
           <div class="sl"></div>
         </div>
       </div>
       ${s.preview ? '<div class="preview"></div>' : ''}
     </div>`;
  const front = el.querySelector('.sCardFront');
  front.querySelector('.nm').textContent = s.title;
  const sl = front.querySelector('.sl');
  if (label) {
    const c = document.createElement('span'); c.className = 'conn ' + s.status;
    if (s.status === 'live') c.innerHTML = ICONS.laptop;
    const lb = document.createElement('span'); lb.textContent = label; c.appendChild(lb);
    sl.appendChild(c); sl.appendChild(document.createTextNode(' · '));
  }
  const cw = document.createElement('span'); cw.className = 'cwd'; cw.textContent = sub; sl.appendChild(cw);
  if (s.preview) front.querySelector('.preview').textContent = stripMd(s.preview);
  const swipe = attachSwipeActions(el, front, s);
  // swipe-left action buttons (revealed behind the front)
  el.querySelector('.sAct.edit').addEventListener('click', (e) => { e.stopPropagation(); swipe.close(); renameChat(s, () => fetchSessions(curFilter)); });
  el.querySelector('.archBtn').addEventListener('click', (e) => { e.stopPropagation(); swipe.close(); confirmArchive(s); });
  // web/desktop has no swipe and no touch long-press: a visible ⋯ button (shown on
  // hover-capable devices, see .sMore in CSS) opens the same Rename/Archive sheet on a
  // plain click. Right-click anywhere on the row opens it too, as a power-user shortcut.
  el.querySelector('.sMore').addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); swipe.close(); openArchiveSheet(s); });
  front.addEventListener('contextmenu', (e) => { e.preventDefault(); openArchiveSheet(s); });
  return el;
}
// iOS-style swipe-left to reveal Edit/Archive. Front slides under the finger; snaps
// open past ~45% of the reveal width, else closed. A plain tap (no horizontal drag)
// opens the chat. Only one row stays open at a time.
let closeOpenSwipe = null;
function attachSwipeActions(card, front, s) {
  const MAX = 132;            // reveal width = two 66px buttons
  let sx = 0, sy = 0, dx = 0, dragging = false, horiz = false, decided = false, open = false, moved = false;
  const setX = (x) => { front.style.transform = `translateX(${x}px)`; };
  const close = () => { open = false; front.classList.remove('dragging'); setX(0); if (closeOpenSwipe === close) closeOpenSwipe = null; };
  const openIt = () => { if (closeOpenSwipe && closeOpenSwipe !== close) closeOpenSwipe(); open = true; front.classList.remove('dragging'); setX(-MAX); closeOpenSwipe = close; };
  front.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; dx = 0; dragging = true; decided = false; horiz = false; moved = false;
    front.classList.add('dragging');
  }, { passive: true });
  front.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0]; dx = t.clientX - sx; const dy = t.clientY - sy;
    if (!decided) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      decided = true; horiz = Math.abs(dx) > Math.abs(dy) * 1.2;
      if (!horiz) front.classList.remove('dragging'); // vertical → let the list scroll
    }
    if (!horiz) return;
    moved = true; e.preventDefault();             // own the horizontal gesture
    setX(Math.max(-MAX - 24, Math.min(0, (open ? -MAX : 0) + dx)));
  }, { passive: false });
  const end = () => {
    if (!dragging) return; dragging = false;
    if (!horiz) { front.classList.remove('dragging'); return; }
    ((open ? -MAX : 0) + dx) < -MAX * 0.45 ? openIt() : close();
  };
  front.addEventListener('touchend', end);
  front.addEventListener('touchcancel', end);
  front.addEventListener('click', (e) => {
    if (open) { e.preventDefault(); e.stopPropagation(); close(); return; }   // tap front to dismiss
    if (moved && horiz) { e.preventDefault(); return; }                       // was a swipe, not a tap
    openChat(s);
  });
  return { close, isOpen: () => open };
}
function confirmArchive(s) {
  if (s.archived) return doArchive(s, false);
  openArchiveConfirm(s);
}
function openArchiveSheet(s) {
  openSheet(s.title, [
    { ic: '✎', label: 'Rename', desc: 'Edit this chat’s name', fn: () => renameChat(s, () => fetchSessions(curFilter)) },
    s.archived
      ? { ic: '📤', label: 'Unarchive', fn: () => doArchive(s, false) }
      : { ic: '🗄', label: 'Archive', desc: 'Hide from your list', fn: () => confirmArchive(s) },
  ]);
}
async function doArchive(s, on) {
  let j = null;
  try {
    const r = await api(`/api/sessions/${s.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: on }) });
    j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j && j.error) || 'archive failed');
  } catch {
    toast(on ? 'Archive failed' : 'Unarchive failed', 2600);
    return null;
  }
  s.archived = !!j.archived;
  if (cur && cur.id === s.id) { cur.archived = s.archived; updateArchiveButton(); }
  if (s.archived) toast('🗄 Archived', 6000, { label: 'Undo', fn: () => doArchive(s, false) });
  else toast(j.restored && j.restored.started ? '📤 Unarchived and reconnected' : '📤 Unarchived');
  fetchSessions(curFilter);
  return j;
}
const stripMd = (t) => (t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`>#]/g, '').replace(/^\s*[-•]\s*/gm, '').replace(/\s+/g, ' ').trim();
const shortCwd = (c) => { let s = c || ''; const h = CFG && CFG.home; if (h && (s === h || s.startsWith(h + '/'))) s = '~' + s.slice(h.length); return s; };
const agentEnabled = (agent) => agent === 'claude' || agent === 'codex' || !!((CFG.features || {})[agent]);
function fmtTokens(n) {
  n = Math.max(0, Math.round(Number(n) || 0));
  if (n >= 1000000) return (n / 1000000).toFixed(n < 10000000 ? 1 : 0).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}
function currentContext() {
  const agent = agentType(cur.agent);
  const cx = cur.context || {};
  const win = Number(cx.windowTokens) || DEFAULT_CONTEXT_WINDOW[agent];
  const used = Math.max(0, Math.round(Number(cx.usedTokens) || 0));
  return {
    usedTokens: used,
    windowTokens: win,
    percent: win ? Math.min(999, Math.round((used / win) * 100)) : 0,
    source: cx.source || 'estimated',
  };
}
function renderContextMeter() {
  const el = $('contextMeter'); if (!el) return;
  const cx = currentContext();
  el.classList.toggle('warn', cx.percent >= 70 && cx.percent < 90);
  el.classList.toggle('hi', cx.percent >= 90);
  const estimated = cx.source !== 'reported';
  el.title = `${cx.usedTokens.toLocaleString()} / ${cx.windowTokens.toLocaleString()} tokens${estimated ? ' (estimated)' : ''}`;
  el.innerHTML = `<div class="contextFill" style="width:${Math.min(100, cx.percent)}%"></div><div class="contextText"><span>Context ${cx.percent}% before compact</span><span>${fmtTokens(cx.usedTokens)} / ${fmtTokens(cx.windowTokens)}${estimated ? ' <span class="contextEst">est</span>' : ''}</span></div>`;
}
$('newBtn').onclick = () => {
  const rows = [
    { ic: '◆', label: 'Codex', desc: 'Run Codex on the box', fn: () => { setAgent('codex'); openChat({ id: null, title: 'New Codex chat', cwd: defaultCwd, agent: 'codex' }); } },
    { ic: '⌘', label: 'Claude', desc: 'Remote-control Claude Code', fn: () => { setAgent('claude'); openChat({ id: null, title: 'New Claude chat', cwd: defaultCwd, agent: 'claude' }); } },
  ];
  if (agentEnabled('gemini')) rows.push({ ic: '✦', label: 'Gemini', desc: 'Run Gemini on the box', fn: () => { setAgent('gemini'); openChat({ id: null, title: 'New Gemini chat', cwd: defaultCwd, agent: 'gemini' }); } });
  if (agentEnabled('agy')) rows.push({ ic: '△', label: 'Antigravity', desc: 'Use the local agy CLI / AI Pro route', fn: () => { setAgent('agy'); openChat({ id: null, title: 'New Antigravity chat', cwd: defaultCwd, agent: 'agy' }); } });
  openSheet('New chat', rows);
};
$('themeBtn').onclick = toggleTheme;
if ($('contextMeter')) $('contextMeter').onclick = openStatusSheet;

/* ---------- session search — full-text across ALL chats (title/summary/cwd/transcript)
   via the sessiongrep CLI on the server. Only surfaces chats this box can actually open. */
let sessQuery = '', sessSearchDeb = null, sessSearchSeq = 0;
$('sessSearchBtn').onclick = sessSearchToggle;
$('sessSearchClear').onclick = () => { $('sessSearchInput').value = ''; setSessQuery(''); $('sessSearchInput').focus(); };
$('sessSearchInput').addEventListener('input', (e) => {
  clearTimeout(sessSearchDeb); const v = e.target.value;
  sessSearchDeb = setTimeout(() => setSessQuery(v), 220);
});
$('sessSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') sessSearchClose(); });
function sessSearchToggle() {
  const bar = $('sessSearch');
  if (bar.classList.contains('hidden')) { bar.classList.remove('hidden'); paintIcons(bar); $('sessSearchInput').focus(); }
  else sessSearchClose();
}
function sessSearchClose() {
  $('sessSearch').classList.add('hidden');
  $('sessSearchInput').value = '';
  if (sessQuery) setSessQuery('');
}
function setSessQuery(q) {
  q = (q || '').trim(); sessQuery = q;
  const results = $('sessResults'), list = $('sessionList');
  if (!q) {
    results.classList.add('hidden'); results.innerHTML = '';
    list.classList.remove('hidden'); renderTabs();   // restores #tabs/#subtabs for the current filter
    return;
  }
  $('tabs').classList.add('hidden'); $('subtabs').classList.add('hidden'); list.classList.add('hidden');
  results.classList.remove('hidden');
  runSessSearch();
}
async function runSessSearch() {
  const q = sessQuery; if (!q) return;
  const seq = ++sessSearchSeq;
  const box = $('sessResults'); box.innerHTML = '<p class="empty">Searching…</p>';
  let results = [];
  const params = new URLSearchParams({ q });
  if (cur.id) params.set('exclude', cur.id);
  try { results = (await (await api('/api/session-search?' + params.toString())).json()).results || []; } catch {}
  if (seq !== sessSearchSeq || sessQuery !== q) return;   // a newer query already fired
  box.innerHTML = '';
  if (!results.length) { box.innerHTML = `<p class="empty">No chats match “${esc(q)}”.</p>`; return; }
  for (const s of results) box.appendChild(sessResultRow(s));
}
function sessResultRow(s) {
  const row = document.createElement('div'); row.className = 'sres';
  const agent = s.agent || 'claude';
  row.innerHTML =
    `<div class="sresTop"><span class="sresTitle"></span>`
    + `${agent === 'codex' ? '<span class="agentTag codex">Codex</span>' : ''}`
    + `${s.archived ? '<span class="agentTag arch">Archived</span>' : ''}`
    + `<span class="sresAge"></span></div>`
    + `<div class="sresMeta"></div>`
    + (s.preview ? `<div class="sresSnip"></div>` : '');
  row.querySelector('.sresTitle').textContent = s.title || 'session';
  row.querySelector('.sresAge').textContent = s.age || '';
  row.querySelector('.sresMeta').textContent = [shortCwd(s.cwd), searchMatchLabel(s)].filter(Boolean).join(' · ');
  if (s.preview) row.querySelector('.sresSnip').textContent = stripMd(s.preview);
  row.onclick = () => { sessSearchClose(); openChat({ id: s.id, title: s.title, agent, cwd: s.cwd }); };
  return row;
}
function searchMatchLabel(s) {
  if (!s || !s.matchedQuery || s.matchKind === 'exact') return '';
  return `matched ${s.matchKind}: ${s.matchedQuery}`;
}

/* ---------- pipelines health panel ---------- */
$('pipesBtn').onclick = openPipelines;
$('pipesBack').onclick = () => history.back();
$('pipesRefresh').onclick = openPipelines;
async function openPipelines() {
  navTo({ view: 'pipelines' });
  show('pipelines'); paintIcons($('pipelines')); pipeView = 'list';
  const body = $('pipesBody'); body.innerHTML = '<p class="empty">Loading…</p>';
  let d;
  try { d = await (await api('/api/pipelines')).json(); }
  catch { body.innerHTML = '<p class="empty">Could not load pipelines.</p>'; return; }
  body.innerHTML = '';
  if (d.health && d.health.checks) body.appendChild(healthCard(d.health));
  if (d.activity) body.appendChild(activityCard(d.activity));
  body.appendChild(pipeCard('📋 Meetings', d.meetings, (it) => ({
    title: it.title || '(untitled meeting)',
    sub: [it.date, it.transcript_source && ('via ' + it.transcript_source), it.recording_status].filter(Boolean).join(' · '),
    flag: it.recording_status === 'needs-recording' ? 'no recording' : '',
  })));
  body.appendChild(pipeCard('✉️ Emails → brain', d.emails, (it) => ({
    title: it.subject || '(no subject)',
    sub: [it.from, it.date && it.date.slice(0, 10)].filter(Boolean).join(' · '),
    flag: it.priority || it.action || '',
  })));
  if (!d.brainDir) { const w = document.createElement('p'); w.className = 'empty'; w.textContent = 'No notes/brain folder found (set BRAIN_DIR).'; body.appendChild(w); }
}
/* ---------- Linear board (kanban of all INC tickets by status) ---------- */
// A GLOBAL view of every open ticket grouped by workflow state — unlike the
// per-cwd ATTENTION.md, it's the same regardless of which dir the session runs in.
// Loads stale-while-revalidate (instant repaint from cache, then refetch), supports
// drag-to-reorder / drag-to-restatus, and live search.
$('boardBtn').onclick = openBoard;
$('boardBack').onclick = () => history.back();
$('boardRefresh').onclick = () => refreshBoard(true);
const PRIO = { 1: ['urgent', '#e0533a'], 2: ['high', '#e08a1e'], 3: ['med', '#3b82c4'], 4: ['low', '#9aa0a6'] };

let boardCache = null;        // last payload — stale-while-revalidate → instant repaint on reopen
let boardFetchSeq = 0;        // race guard for overlapping board fetches
let boardQuery = '';          // active search text ('' = normal column view)

async function openBoard() {
  navTo({ view: 'board' });
  show('board'); paintIcons($('board'));
  // paint the cached board instantly, then revalidate in the background — feels instant on reopen
  if (boardCache && !boardQuery) renderBoard(boardCache);
  else if (!boardCache) { $('boardBody').innerHTML = '<p class="empty">Loading board…</p>'; $('boardMeta').textContent = ''; }
  await refreshBoard(boardDirty);   // force-fresh if a mutation happened while we were away
  boardDirty = false;
}
async function refreshBoard(fresh) {
  const seq = ++boardFetchSeq;
  let d;
  try { d = await (await api('/api/linear-board' + (fresh ? '?fresh=1' : ''))).json(); }
  catch { if (!boardCache) $('boardBody').innerHTML = '<p class="empty">Could not load the board.</p>'; return; }
  if (seq !== boardFetchSeq) return;            // a newer fetch superseded us
  if (drag) return;                             // never repaint out from under an in-flight drag
  if (d.error) { if (!boardCache) $('boardBody').innerHTML = `<p class="empty">${esc(d.error)}</p>`; return; }
  boardCache = d;
  if (boardQuery) runBoardSearch(); else renderBoard(d);
}
function renderBoard(d) {
  const body = $('boardBody'); body.innerHTML = '';
  $('boardMeta').textContent = `${d.total} open`;
  for (const col of (d.columns || [])) {
    const c = document.createElement('div'); c.className = 'boardCol';
    c.dataset.stateId = col.stateId || '';
    c.dataset.stateName = col.name || '';
    c.dataset.type = col.type || '';
    const hd = document.createElement('div'); hd.className = 'boardColHd';
    hd.innerHTML = `<span class="boardColName"></span><span class="boardColRight">${col.recent ? '<span class="boardColTag">recent</span>' : ''}<span class="boardColCount">${col.count}</span></span>`;
    hd.querySelector('.boardColName').textContent = col.name;
    c.appendChild(hd);
    const list = document.createElement('div'); list.className = 'boardColList';
    for (const t of col.issues) list.appendChild(ticketCard(t));
    syncColEmpty(list);
    c.appendChild(list); body.appendChild(c);
  }
  if (!(d.columns || []).length) body.innerHTML = '<p class="empty">No tickets.</p>';
}
// keep a column's "—" empty marker in sync with its card count (also after drag moves)
function syncColEmpty(list) {
  const has = list.querySelector('.tkt');
  let mk = list.querySelector('.boardEmpty');
  if (!has && !mk) { mk = document.createElement('p'); mk.className = 'boardEmpty'; mk.textContent = '—'; list.appendChild(mk); }
  else if (has && mk) mk.remove();
}
function recountCol(colEl) {
  if (!colEl) return;
  const list = colEl.querySelector('.boardColList');
  const cnt = colEl.querySelector('.boardColCount');
  if (cnt) cnt.textContent = list.querySelectorAll('.tkt').length;
  syncColEmpty(list);
}
function ticketCard(t) {
  const card = document.createElement('div'); card.className = 'tkt';
  card.dataset.id = t.id;
  card.dataset.sort = (t.sortOrder == null ? 0 : t.sortOrder);
  card._t = t;
  const [plabel, pcolor] = PRIO[t.priority] || [];
  const top = document.createElement('div'); top.className = 'tktTop';
  top.innerHTML = `${pcolor ? `<span class="tktPrio" style="background:${pcolor}" title="${plabel}"></span>` : ''}<span class="tktId"></span><span class="tktTime"></span>`;
  top.querySelector('.tktId').textContent = t.id;
  top.querySelector('.tktTime').textContent = t.updatedAt ? relTime(Date.parse(t.updatedAt)) : '';
  card.appendChild(top);
  const title = document.createElement('div'); title.className = 'tktTitle'; title.textContent = t.title || '(untitled)';
  card.appendChild(title);
  // hide internal harness/staging labels — they're noise for an at-a-glance board
  const labels = (t.labels || []).filter((l) => l && !/^agent[:-]/.test(l) && l !== 'auto-captured').slice(0, 3);
  if (labels.length || t.assignee) {
    const meta = document.createElement('div'); meta.className = 'tktMeta';
    for (const l of labels) { const s = document.createElement('span'); s.className = 'tktChip'; s.textContent = l; meta.appendChild(s); }
    if (t.assignee) { const a = document.createElement('span'); a.className = 'tktWho'; a.textContent = t.assignee; meta.appendChild(a); }
    card.appendChild(meta);
  }
  // delegation badge — at-a-glance "this is claimed by an agent" (+ tap to jump into it)
  if (t.delegation) {
    const dg = t.delegation;
    const el = document.createElement('div'); el.className = 'tktDeleg';
    const who = dg.sessionTitle || `${agentLabel(dg.agent)} agent`;
    el.innerHTML = `<span class="tktDelegIc">🤖</span><span class="tktDelegTxt"></span>${dg.sessionId ? '<span class="tktDelegGo">→</span>' : ''}`;
    el.querySelector('.tktDelegTxt').textContent = `delegated · ${who}`;
    if (dg.sessionId) { el.classList.add('clk'); el.onclick = (e) => { e.stopPropagation(); openChat({ id: dg.sessionId, title: who, agent: dg.agent }); }; }
    card.appendChild(el);
  }
  card.onclick = () => { if (card._justDragged) return; issueOrigin = { kind: 'board' }; openIssue(t.id); };
  attachCardDrag(card);
  return card;
}

/* ---------- board drag-and-drop ----------
   Long-press a card to lift it, then drop it: in another column → changes its workflow
   state; within a column → reorders it. Both persist via POST /api/linear/:id/move
   (stateId + a midpoint sortOrder). Pointer Events → works with touch and mouse. The DOM
   moves optimistically; a background refresh reconciles, and a failed move snaps back. */
const DRAG_HOLD = 200, DRAG_SLOP = 9, DRAG_EDGE = 46;
let drag = null;
let boardDndInit = false;
function initBoardDnd() {
  if (boardDndInit) return; boardDndInit = true;
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  // iOS won't honor preventDefault on pointermove for scroll, but it does on touchmove —
  // this is what actually stops the page/column scrolling under an active drag.
  window.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
}
function attachCardDrag(card) {
  card.addEventListener('pointerdown', (e) => {
    if (boardQuery || drag) return;                          // no DnD while searching / already dragging
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.tktDeleg.clk')) return;           // delegation badge owns its own tap
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    const hold = setTimeout(() => { beginDrag(card, e, pid); teardown(); }, DRAG_HOLD);
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (Math.abs(ev.clientX - sx) > DRAG_SLOP || Math.abs(ev.clientY - sy) > DRAG_SLOP) { clearTimeout(hold); teardown(); }
    };
    const up = () => { clearTimeout(hold); teardown(); };
    const teardown = () => {
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', up);
      card.removeEventListener('pointercancel', up);
    };
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  });
}
function beginDrag(card, e, pid) {
  const list = card.parentElement, col = card.closest('.boardCol');
  const origPrev = prevTkt(card), origNext = nextTkt(card);
  const rect = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add('tktGhost');
  ghost.style.width = rect.width + 'px';
  document.body.appendChild(ghost);
  const ph = document.createElement('div'); ph.className = 'tktPlaceholder'; ph.style.height = rect.height + 'px';
  list.insertBefore(ph, card.nextSibling);
  card.classList.add('tktDragSrc');                          // hidden but kept (re-homed on drop)
  document.body.classList.add('boardDragging');
  const board = $('boardBody'); board.style.touchAction = 'none';
  try { board.setPointerCapture(pid); } catch {}
  drag = {
    card, ghost, ph, pid, fromList: list, fromCol: col, targetCol: col,
    offX: e.clientX - rect.left, offY: e.clientY - rect.top, x: e.clientX, y: e.clientY,
    origPrevId: origPrev ? origPrev.dataset.id : null, origNextId: origNext ? origNext.dataset.id : null,
    raf: 0,
  };
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
  positionGhost();
  drag.raf = requestAnimationFrame(autoScrollTick);
}
function positionGhost() { if (drag) drag.ghost.style.transform = `translate(${drag.x - drag.offX}px, ${drag.y - drag.offY}px) scale(1.03)`; }
function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  e.preventDefault();
  drag.x = e.clientX; drag.y = e.clientY;
  positionGhost();
  updatePlaceholder();
}
function updatePlaceholder() {
  const cols = [...$('boardBody').querySelectorAll('.boardCol')];
  if (!cols.length) return;
  let target = null;
  for (const c of cols) { const r = c.getBoundingClientRect(); if (drag.x >= r.left && drag.x <= r.right) { target = c; break; } }
  if (!target) { let best = Infinity; for (const c of cols) { const r = c.getBoundingClientRect(); const d = Math.abs((r.left + r.right) / 2 - drag.x); if (d < best) { best = d; target = c; } } }
  drag.targetCol = target;
  const list = target.querySelector('.boardColList');
  const cards = [...list.querySelectorAll('.tkt')].filter((c) => c !== drag.card);
  let before = null;
  for (const c of cards) { const r = c.getBoundingClientRect(); if (drag.y < r.top + r.height / 2) { before = c; break; } }
  const mk = list.querySelector('.boardEmpty'); if (mk) mk.remove();
  if (before) list.insertBefore(drag.ph, before); else list.appendChild(drag.ph);
}
function autoScrollTick() {
  if (!drag) return;
  const board = $('boardBody'), br = board.getBoundingClientRect();
  if (drag.x < br.left + DRAG_EDGE) board.scrollLeft -= 14;
  else if (drag.x > br.right - DRAG_EDGE) board.scrollLeft += 14;
  if (drag.targetCol) {
    const list = drag.targetCol.querySelector('.boardColList'), lr = list.getBoundingClientRect();
    if (drag.y < lr.top + DRAG_EDGE) list.scrollTop -= 12;
    else if (drag.y > lr.bottom - DRAG_EDGE) list.scrollTop += 12;
  }
  updatePlaceholder();
  drag.raf = requestAnimationFrame(autoScrollTick);
}
async function endDrag(e) {
  if (!drag) return;
  if (e && e.pointerId != null && e.pointerId !== drag.pid) return;
  const d = drag; drag = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  const board = $('boardBody');
  try { board.releasePointerCapture(d.pid); } catch {}
  board.style.touchAction = '';
  document.body.classList.remove('boardDragging');
  d.ghost.remove();
  // re-home the real card where the placeholder landed
  const targetList = d.ph.parentElement, targetCol = d.ph.closest('.boardCol');
  d.card.classList.remove('tktDragSrc');
  targetList.insertBefore(d.card, d.ph);
  d.ph.remove();
  d.card._justDragged = true; setTimeout(() => { d.card._justDragged = false; }, 60);   // swallow the post-drag click
  recountCol(d.fromCol); recountCol(targetCol);
  // did anything actually change?
  const movedCols = targetCol !== d.fromCol;
  const prev = prevTkt(d.card), next = nextTkt(d.card);
  const fpId = prev ? prev.dataset.id : null, fnId = next ? next.dataset.id : null;
  if (!movedCols && fpId === d.origPrevId && fnId === d.origNextId) return;   // dropped back in place
  const newStateId = targetCol.dataset.stateId || '';
  if (movedCols && !newStateId) { toast('couldn’t move'); refreshBoard(true); return; }
  // midpoint sortOrder between the new neighbours (ascending = top)
  const ps = prev ? parseFloat(prev.dataset.sort) : null;
  const ns = next ? parseFloat(next.dataset.sort) : null;
  let newSort;
  if (ps == null && ns == null) newSort = 0;
  else if (ps == null) newSort = ns - 1;
  else if (ns == null) newSort = ps + 1;
  else newSort = (ps + ns) / 2;
  d.card.dataset.sort = newSort;
  if (d.card._t) { d.card._t.sortOrder = newSort; if (movedCols) d.card._t.stateId = newStateId; }
  const payload = { sortOrder: newSort };
  if (movedCols && newStateId) payload.stateId = newStateId;
  const id = d.card.dataset.id;
  try {
    const r = await (await api(`/api/linear/${id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
    if (!r.ok) { toast(r.error || 'move failed'); refreshBoard(true); return; }
    if (movedCols) toast(`${id} → ${r.state || targetCol.dataset.stateName}`);
    refreshBoard(true);   // reconcile sortOrder/labels in the background (DOM is already correct)
  } catch { toast('move failed'); refreshBoard(true); }
}
function prevTkt(el) { let n = el.previousElementSibling; while (n && !n.classList.contains('tkt')) n = n.previousElementSibling; return n; }
function nextTkt(el) { let n = el.nextElementSibling; while (n && !n.classList.contains('tkt')) n = n.nextElementSibling; return n; }
initBoardDnd();

/* ---------- board search (instant local filter + server search of all Linear) ---------- */
let boardSearchDeb = null, boardSearchSeq = 0;
$('boardSearchBtn').onclick = boardSearchToggle;
$('boardSearchClear').onclick = () => { $('boardSearchInput').value = ''; setBoardQuery(''); $('boardSearchInput').focus(); };
$('boardSearchInput').addEventListener('input', (e) => {
  clearTimeout(boardSearchDeb); const v = e.target.value;
  boardSearchDeb = setTimeout(() => setBoardQuery(v), 130);
});
$('boardSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') boardSearchClose(); });
function boardSearchToggle() {
  const bar = $('boardSearch');
  if (bar.classList.contains('hidden')) { bar.classList.remove('hidden'); paintIcons(bar); $('boardSearchInput').focus(); }
  else boardSearchClose();
}
function boardSearchClose() {
  $('boardSearch').classList.add('hidden');
  $('boardSearchInput').value = '';
  if (boardQuery) setBoardQuery('');
}
function setBoardQuery(q) {
  q = (q || '').trim(); boardQuery = q;
  if (!q) {
    $('boardResults').classList.add('hidden'); $('boardBody').classList.remove('hidden');
    if (boardCache) $('boardMeta').textContent = `${boardCache.total} open`;
    return;
  }
  $('boardBody').classList.add('hidden'); $('boardResults').classList.remove('hidden');
  runBoardSearch();
}
async function runBoardSearch() {
  const q = boardQuery; if (!q) return;
  const seq = ++boardSearchSeq;
  const local = localBoardMatches(q);
  renderBoardResults(local, q, false);              // instant local hits
  let extra = [];
  try { extra = (await (await api('/api/linear-search?q=' + encodeURIComponent(q))).json()).issues || []; } catch {}
  if (seq !== boardSearchSeq || boardQuery !== q) return;
  const seen = new Set(local.map((x) => x.id));
  renderBoardResults(local.concat(extra.filter((x) => !seen.has(x.id))), q, true);
}
function localBoardMatches(q) {
  const ql = q.toLowerCase(); const out = [];
  for (const col of ((boardCache && boardCache.columns) || [])) {
    for (const t of (col.issues || [])) {
      const hay = `${t.id} ${t.title} ${(t.labels || []).join(' ')} ${t.assignee || ''}`.toLowerCase();
      if (hay.includes(ql)) out.push({ ...t, state: col.name });
    }
  }
  return out;
}
function renderBoardResults(list, q, done) {
  const box = $('boardResults');
  $('boardMeta').textContent = `${list.length} match${list.length === 1 ? '' : 'es'}`;
  if (!list.length) { box.innerHTML = `<p class="empty">${done ? 'No tickets match “' + esc(q) + '”.' : 'Searching…'}</p>`; return; }
  box.innerHTML = '';
  for (const t of list) box.appendChild(resultRow(t));
}
function resultRow(t) {
  const row = document.createElement('div'); row.className = 'bres';
  const [, pcolor] = PRIO[t.priority] || [];
  row.innerHTML = `<span class="tktPrio${pcolor ? '' : ' bresNoPrio'}" ${pcolor ? `style="background:${pcolor}"` : ''}></span>`
    + `<div class="bresMain"><div class="bresTop"><span class="tktId"></span><span class="bresState"></span></div><div class="bresTitle"></div></div>`;
  row.querySelector('.tktId').textContent = t.id;
  row.querySelector('.bresState').textContent = t.state || '';
  row.querySelector('.bresTitle').textContent = t.title || '(untitled)';
  row.onclick = () => { issueOrigin = { kind: 'board' }; openIssue(t.id); };
  return row;
}

/* ---------- Linear issue workspace (view · comment · status · dismiss · delegate · create) ---------- */
let linearMeta = null;          // { states:[{id,name,type}], labels:[{id,name,color}] }
let curIssue = null;            // the open issue detail object
let curIssueSessions = [];      // sessions whose transcript references the open issue
let boardDirty = false;         // a mutation happened → refetch the board on back
let issueOrigin = null;         // where openIssue was entered from: {kind:'board'} or {kind:'chat', chat}
async function loadLinearMeta() {
  if (linearMeta) return linearMeta;
  try { linearMeta = await (await api('/api/linear-meta')).json(); } catch { linearMeta = { states: [], labels: [] }; }
  return linearMeta;
}
// Step the history stack back — it naturally returns to wherever the issue was
// opened from (the board, or the chat's bell Linear tab), since that screen is the
// previous history entry. Returning to the board re-renders it (always fresh).
$('issueBack').onclick = () => history.back();
$('issueLinear').onclick = () => { if (curIssue && curIssue.url) window.open(curIssue.url, '_blank'); };
$('issueCommentSend').onclick = sendIssueComment;
$('issueComment').onkeydown = (e) => { if (e.key === 'Enter') sendIssueComment(); };

async function openIssue(id) {
  navTo({ view: 'issue', id });
  show('issue'); paintIcons($('issue'));
  $('issueId').textContent = id; $('issueScroll').innerHTML = '<p class="empty">Loading…</p>';
  $('issueBar').innerHTML = ''; $('issueComment').value = '';
  let d;
  try { d = await (await api(`/api/linear/${id}/detail`)).json(); }
  catch { $('issueScroll').innerHTML = '<p class="empty">Could not load issue.</p>'; return; }
  if (d.error) { $('issueScroll').innerHTML = `<p class="empty">${esc(d.error)}</p>`; return; }
  curIssue = d; renderIssue(d);
  // find sessions that filed/worked this ticket (so the user can jump back in)
  curIssueSessions = [];
  try {
    const sj = await (await api(`/api/linear/${id}/sessions?exclude=${encodeURIComponent(cur.id || '')}`)).json();
    curIssueSessions = sj.sessions || []; renderIssueSessions(curIssueSessions);
  } catch {}
}
function renderIssueSessions(list) {
  const box = $('issueScroll'); const old = box.querySelector('.issueSess'); if (old) old.remove();
  if (!list.length) return;
  const delegId = (curIssue && (latestDeleg(curIssue.delegations) || {}).sessionId) || null;
  const sec = document.createElement('div'); sec.className = 'issueSess';
  sec.innerHTML = '<div class="issueCmtHd">Sessions that worked on this</div>';
  for (const s of list) {
    const row = document.createElement('div'); row.className = 'sessRow';
    const deleg = s.id && s.id === delegId;
    row.innerHTML = `<span class="sessIc">${agentIcon(s.agent)}</span><div class="sessMain"><div class="sessTitle"></div><div class="sessSub"></div></div><span class="sessGo">→</span>`;
    row.querySelector('.sessTitle').textContent = s.title;
    row.querySelector('.sessSub').textContent = `${s.agent}${s.category === 'auto' ? ' · auto' : ''} · ${s.mentions}× · ${relTime(s.mtime)}${deleg ? ' · 🤖 delegated' : ''}`;
    if (deleg) row.classList.add('sessDeleg');
    row.onclick = () => openChat({ id: s.id, title: s.title, cwd: s.cwd, agent: s.agent });
    sec.appendChild(row);
  }
  $('issueScroll').appendChild(sec);
}
// The current (most recent) delegation record for an open issue, or null.
function latestDeleg(arr) { return (Array.isArray(arr) && arr.length) ? arr[arr.length - 1] : null; }
function renderIssue(d) {
  $('issueId').textContent = d.identifier;
  const [plabel, pcolor] = PRIO[d.priority] || [];
  const sc = (d.state && d.state.color) || '#9aa0a6';
  const box = $('issueScroll'); box.innerHTML = '';
  const wrap = document.createElement('div'); wrap.className = 'issueDetail';
  const h = document.createElement('div'); h.className = 'issueTitle'; h.textContent = d.title; wrap.appendChild(h);
  const chips = document.createElement('div'); chips.className = 'issueChips';
  chips.innerHTML =
    `<span class="iChip iState" style="--c:${sc}">${esc((d.state && d.state.name) || '')}</span>` +
    (pcolor ? `<span class="iChip"><span class="tktPrio" style="background:${pcolor}"></span>${plabel}</span>` : '') +
    (d.assignee ? `<span class="iChip">@${esc(d.assignee)}</span>` : '') +
    (d.labels || []).map((l) => `<span class="iChip" style="--c:${l.color || '#9aa0a6'}">${esc(l.name)}</span>`).join('');
  wrap.appendChild(chips);
  const dates = document.createElement('div'); dates.className = 'issueDates';
  dates.textContent = `updated ${relTime(Date.parse(d.updatedAt))} · created ${relTime(Date.parse(d.createdAt))}`;
  wrap.appendChild(dates);
  // the agent the user delegated this to — highlighted + one tap into the session
  const dl = latestDeleg(d.delegations);
  if (dl) {
    const who = dl.sessionTitle || `${agentLabel(dl.agent)} agent`;
    const card = document.createElement('div'); card.className = 'delegCard' + (dl.sessionId ? ' clk' : '');
    card.innerHTML = `<div class="delegHd">🤖 Delegated to</div><div class="delegRow"><span class="sessIc">${agentIcon(dl.agent)}</span><div class="sessMain"><div class="delegName"></div><div class="delegSub"></div></div>${dl.sessionId ? '<span class="sessGo">→</span>' : ''}</div>`;
    card.querySelector('.delegName').textContent = who;
    card.querySelector('.delegSub').textContent = `${dl.agent}${dl.kind === 'resume' ? ' · resumed' : ''} · delegated ${relTime(dl.ts)}`;
    if (dl.sessionId) card.onclick = () => openChat({ id: dl.sessionId, title: who, agent: dl.agent });
    wrap.appendChild(card);
  }
  if (d.pr) {
    const pr = document.createElement('a'); pr.className = 'issuePr'; pr.href = d.pr.url; pr.target = '_blank';
    pr.innerHTML = `<span class="prState ${esc(d.pr.state || 'open')}">${esc(d.pr.state || 'PR')}</span> ${esc(d.pr.repo)}#${d.pr.number}${d.pr.title ? ' · ' + esc(d.pr.title) : ''}`;
    wrap.appendChild(pr);
  }
  if (d.description && d.description.trim()) {
    const desc = document.createElement('div'); desc.className = 'issueDesc attnMd'; desc.innerHTML = md(d.description);
    wrap.appendChild(desc); paintIcons(desc);
  }
  const cs = document.createElement('div'); cs.className = 'issueComments';
  if (d.comments && d.comments.length) {
    cs.innerHTML = `<div class="issueCmtHd">${d.comments.length} comment${d.comments.length > 1 ? 's' : ''}</div>`;
    for (const c of d.comments) {
      const el = document.createElement('div'); el.className = 'issueCmt';
      el.innerHTML = `<div class="issueCmtMeta"><b>${esc(c.user)}</b> · ${relTime(Date.parse(c.createdAt))}</div><div class="issueCmtBody attnMd"></div>`;
      el.querySelector('.issueCmtBody').innerHTML = md(c.body || '');
      cs.appendChild(el);
    }
  }
  wrap.appendChild(cs); box.appendChild(wrap); box.scrollTop = 0;
  const bar = $('issueBar'); bar.innerHTML = '';
  const act = (label, fn, cls) => { const b = document.createElement('button'); b.className = 'iAct' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = fn; bar.appendChild(b); };
  act('🤖 Delegate', () => delegateIssue(d));
  act('Status', () => changeStatus(d));
  if (d.pr && d.pr.state !== 'merged') act('Merge PR', () => mergeIssuePr(d), 'accent');
  act('Dismiss', () => dismissIssue(d), 'danger');
}
async function sendIssueComment() {
  if (!curIssue) return;
  const inp = $('issueComment'); const body = inp.value.trim(); if (!body) return;
  inp.value = ''; inp.disabled = true;
  try {
    const r = await (await api(`/api/linear/${curIssue.identifier}/comment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) })).json();
    if (r.ok) { toast('comment added'); await openIssue(curIssue.identifier); } else { toast(r.error || 'comment failed'); inp.value = body; }
  } catch { toast('comment failed'); inp.value = body; }
  inp.disabled = false;
}
async function changeStatus(d) {
  const meta = await loadLinearMeta();
  openSheet('Set status', (meta.states || []).map((s) => ({
    ic: (d.state && s.name === d.state.name) ? '✓' : '', label: s.name, sel: !!(d.state && s.name === d.state.name),
    fn: () => setIssueState(d.identifier, s.id, s.name),
  })));
}
async function setIssueState(id, stateId, name, reload = true) {
  try {
    const r = await (await api(`/api/linear/${id}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stateId }) })).json();
    if (r.ok) { toast(`→ ${r.state || name}`); boardDirty = true; if (reload && curIssue && curIssue.identifier === id) await openIssue(id); }
    else toast(r.error || 'failed');
    return r.ok;
  } catch { toast('failed'); return false; }
}
function dismissIssue(d) {
  openSheet(`Dismiss ${d.identifier}?`, [
    { ic: '🚫', label: 'Cancel issue (dismiss)', desc: 'Move to Canceled', fn: () => dismissTo(d, 'canceled', 'Canceled') },
    { ic: '✓', label: 'Mark Done', desc: 'Move to Done', fn: () => dismissTo(d, 'completed', 'Done') },
  ]);
}
async function dismissTo(d, type, name) {
  const m = await loadLinearMeta(); const s = (m.states || []).find((x) => x.type === type);
  if (!s) { toast(`no ${name} state`); return; }
  if (await setIssueState(d.identifier, s.id, name, false)) { boardDirty = false; openBoard(); }
}
async function mergeIssuePr(d) {
  toast('merging…');
  try { const r = await (await api(`/api/linear/${d.identifier}/merge`, { method: 'POST' })).json(); toast(r.merged ? 'merged ✓' : (r.error || 'merge failed')); if (r.merged) await openIssue(d.identifier); }
  catch { toast('merge failed'); }
}
// Delegate an issue: resume the original session that worked it (full context) OR spin up a fresh agent.
function delegateIssue(d) {
  const rows = [];
  for (const s of (curIssueSessions || []).slice(0, 4)) {
    rows.push({ ic: '↻', label: `Resume: ${s.title}`.slice(0, 46), desc: `${s.agent} · ${s.mentions}× · ${relTime(s.mtime)} — continue with full context`, fn: () => resumeIssueSession(s, d) });
  }
  rows.push({ ic: agentIcon('claude'), label: 'New Claude agent', desc: 'Fresh Claude Code session', fn: () => spawnIssueAgent(d, 'claude') });
  rows.push({ ic: agentIcon('codex'), label: 'New Codex agent', desc: 'Fresh Codex session on the box', fn: () => spawnIssueAgent(d, 'codex') });
  if (agentEnabled('gemini')) rows.push({ ic: agentIcon('gemini'), label: 'New Gemini agent', desc: 'Fresh Gemini session on the box', fn: () => spawnIssueAgent(d, 'gemini') });
  if (agentEnabled('agy')) rows.push({ ic: agentIcon('agy'), label: 'New Antigravity agent', desc: 'Fresh agy session on the box', fn: () => spawnIssueAgent(d, 'agy') });
  openSheet(`Delegate ${d.identifier}`, rows);
}
// Our own delegation breadcrumb comments — filtered out of the context we hand back to
// an agent (they're noise and would compound across re-delegations).
function isDelegationMarker(body) {
  const b = String(body || '').trim();
  return /box-session:/.test(b) || /^🤖 (Delegated to|Resumed in) a box/.test(b) || /^↻ Resumed in a box/.test(b);
}
// Assemble a rich, self-contained context block from the issue detail we ALREADY have
// loaded (description + every real comment + labels + the agents that touched it). This
// gets baked into the delegation prompt so the agent doesn't have to go re-fetch the
// Linear ticket and is GUARANTEED the context/comments we already hold.
function fmtIssueDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
function buildIssueContext(d, sessions) {
  const L = [`# ${d.identifier} — ${d.title}`];
  const meta = [];
  if (d.state && d.state.name) meta.push(`State: ${d.state.name}`);
  const pr0 = PRIO[d.priority]; if (pr0) meta.push(`Priority: ${pr0[0]}`);
  if (d.assignee) meta.push(`Assignee: ${d.assignee}`);
  const labels = (d.labels || []).map((l) => l.name).filter((n) => !/^agent[:-]/.test(n));
  if (labels.length) meta.push(`Labels: ${labels.join(', ')}`);
  if (meta.length) L.push(meta.join(' · '));
  const dates = [`Created: ${fmtIssueDate(d.createdAt) || d.createdAt || 'unknown'}`, `Updated: ${fmtIssueDate(d.updatedAt) || d.updatedAt || 'unknown'}`];
  L.push(dates.join(' · '));
  if (d.url) L.push(`Linear: ${d.url}`);
  if (d.pr) L.push(`PR: ${d.pr.url} (${d.pr.state || 'open'})`);
  L.push('', '## Description', (d.description && d.description.trim()) ? d.description.trim() : '(no description)');
  const attachments = (d.attachments || []).filter((a) => a && (a.url || a.title));
  if (attachments.length) {
    L.push('', `## Attachments (${attachments.length})`);
    for (const a of attachments) L.push(`- ${a.title || a.url}${a.url && a.title ? `: ${a.url}` : ''}`);
  }
  const cmts = (d.comments || []).filter((c) => !isDelegationMarker(c.body));
  if (cmts.length) {
    L.push('', `## Comments (${cmts.length}) — context already gathered; read these before re-deriving anything`);
    for (const c of cmts) L.push('', `### ${c.user || 'someone'} · ${fmtIssueDate(c.createdAt) || c.createdAt || 'unknown time'}`, (c.body || '').trim());
  }
  if (sessions && sessions.length) {
    L.push('', '## Agents that have already worked on this');
    for (const s of sessions.slice(0, 8)) L.push(`- ${s.title} (${s.agent}, ${s.mentions}× mentions, last active ${fmtIssueDate(s.mtime) || relTime(s.mtime)})`);
    L.push('If you are one of these, you already hold the full transcript — keep using that context.');
  }
  return L.join('\n');
}
function buildIssueDelegationPrompt(d, sessions, agent = 'claude') {
  const slug = d.identifier.toLowerCase();
  return `Work the Linear issue ${d.identifier}: "${d.title}".

Everything the Box app already knows about this ticket is below: title, state, priority, assignee, labels, dates, links, description, attachments, every non-delegation comment, and agents that already touched it. Read it before re-deriving anything. Do not re-fetch the Linear ticket unless you need fresh data beyond this snapshot.

${buildIssueContext(d, sessions)}

How to work it:
- Do not edit a shared clone. Create an isolated git worktree for your branch off the latest default branch. Use a unique branch name for this ticket, for example:
  git worktree add ../${slug} -b ${agentBranch(agent)}/${slug} && cd ../${slug}
- Implement and verify the change, open or refresh the PR, and post the PR link as a comment on ${d.identifier}.
- When done, set ${d.identifier} to In Review, or comment your status and blockers.`;
}
// Wait for a freshly-spawned chat's session id to resolve (the RC bridge reports it via
// the {type:'session'} WS event a beat after spawn). Keyed to this chat so navigating
// away can't bind the wrong id; resolves null on timeout (delegation still records, just
// without a deep-link).
function awaitSessionId(key, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function tick() {
      if (cur && cur.key === key && cur.id) return resolve(cur.id);
      if (Date.now() - t0 > timeoutMs) return resolve(null);
      setTimeout(tick, 250);
    })();
  });
}
// Record (server-side) which session a ticket was delegated to — drives the board badge
// + the clickable "Delegated to" card — and claims the ticket in Linear (In Progress +
// agent:delegated label + breadcrumb comment).
async function recordDelegation(inc, { agent, kind, sessionId, sessionTitle, key }) {
  let sid = sessionId || null;
  if (!sid && key) sid = await awaitSessionId(key);
  try {
    await api(`/api/linear/${inc}/delegation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, sessionTitle: sessionTitle || '', agent, kind }) });
  } catch {}
  boardDirty = true;   // so the badge shows when the user returns to the board
}
// Resume the existing session that already has this issue's context and tell it to continue.
async function resumeIssueSession(s, d) {
  const cont = `Continue working on ${d.identifier}: "${d.title}".

You worked on this earlier — pick up where you left off. The full CURRENT ticket context (description, every comment, and who else touched it) is included below so you don't need to re-fetch the Linear ticket:

${buildIssueContext(d, curIssueSessions)}

How to continue:
- If you already have a worktree/branch for it, keep using it; otherwise create one off the latest default branch:
  git worktree add ../${d.identifier.toLowerCase()} -b ${agentBranch(s.agent)}/${d.identifier.toLowerCase()} && cd ../${d.identifier.toLowerCase()}
- Finish the work, open/refresh the PR, and post the PR link + a status comment on ${d.identifier}.`;
  await openChat({ id: s.id, title: s.title, cwd: s.cwd, agent: s.agent });
  enqueueText(cont, { displayText: `↻ Continue ${d.identifier}: ${d.title}` });
  await recordDelegation(d.identifier, { agent: s.agent, kind: 'resume', sessionId: s.id, sessionTitle: s.title });
  toast(`Resumed ${d.identifier} in ${AGENT_LABEL[s.agent] || s.agent}`);
}
async function spawnIssueAgent(d, agent) {
  const seed = buildIssueDelegationPrompt(d, curIssueSessions, agent);
  const title = `${d.identifier}: ${d.title}`.slice(0, 60);
  setAgent(agent);
  await openChat({ id: null, title, cwd: defaultCwd, agent });
  enqueueText(seed, { displayText: `🤖 Work ${d.identifier}: ${d.title}`, title });
  toast(`Dispatching ${AGENT_LABEL[agent]} agent...`);
  await recordDelegation(d.identifier, { agent, kind: 'new', sessionTitle: title, key: cur.key });
  toast(`Dispatched ${d.identifier} to ${AGENT_LABEL[agent]}`);
}

/* ---------- new Linear issue ---------- */
const PRIO_OPTS = [[0, 'None'], [1, 'Urgent'], [2, 'High'], [3, 'Medium'], [4, 'Low']];
let icrPrio = 0, icrStateId = '';
$('boardNew').onclick = openIssueNew;
$('icrBack').onclick = () => history.back();
$('icrCreate').onclick = createIssue;
async function openIssueNew() {
  navTo({ view: 'issueNew' });
  show('issueNew'); paintIcons($('issueNew'));
  $('icrTitle').value = ''; $('icrDesc').value = ''; icrPrio = 0; icrStateId = '';
  const pr = $('icrPrio'); pr.innerHTML = '';
  for (const [v, lbl] of PRIO_OPTS) { const c = document.createElement('button'); c.className = 'icrChip' + (v === icrPrio ? ' sel' : ''); c.textContent = lbl; c.onclick = () => { icrPrio = v; [...pr.children].forEach((x, i) => x.classList.toggle('sel', PRIO_OPTS[i][0] === v)); }; pr.appendChild(c); }
  const meta = await loadLinearMeta();
  const st = $('icrState'); st.innerHTML = '';
  const def = (meta.states || []).find((s) => s.type === 'backlog') || (meta.states || [])[0];
  icrStateId = def ? def.id : '';
  for (const s of (meta.states || [])) { const c = document.createElement('button'); c.className = 'icrChip' + (s.id === icrStateId ? ' sel' : ''); c.textContent = s.name; c.onclick = () => { icrStateId = s.id; [...st.children].forEach((x) => x.classList.toggle('sel', x === c)); }; st.appendChild(c); }
  setTimeout(() => $('icrTitle').focus(), 60);
}
async function createIssue() {
  const title = $('icrTitle').value.trim(); if (!title) { toast('title required'); return; }
  const description = $('icrDesc').value.trim();
  $('icrCreate').disabled = true;
  try {
    const r = await (await api('/api/linear/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description, priority: icrPrio, stateId: icrStateId }) })).json();
    if (r.ok && r.identifier) { toast(`created ${r.identifier}`); boardDirty = true; issueOrigin = { kind: 'board' }; openIssue(r.identifier); }
    else toast(r.error || 'create failed');
  } catch { toast('create failed'); }
  $('icrCreate').disabled = false;
}

// Harness activity feed: the event stream (meetings/emails/Linear/locks/session-outcomes)
// + active resource locks — what's happening across the agent fleet, where the user looks.
const ACT_ICON = { meeting: '📋', email: '✉️', signal: '✉️', linear: '🔷', linear_comment: '💬', lock: '🔒', 'session-outcome': '✳️', project: '🧠', learning: '🧠', deal: '🤝', person: '👤', company: '🏢', note: '•' };
function activityCard(a) {
  const card = document.createElement('div'); card.className = 'pipeCard';
  const locks = a.locks || [], events = a.events || [];
  const head = document.createElement('div'); head.className = 'pipeHead';
  head.innerHTML = `<span class="pipeTitle">⚡ Activity</span><span class="pipeMeta">${events.length} recent${locks.length ? ` · ${locks.length} 🔒 held` : ''}</span>`;
  card.appendChild(head);
  for (const l of locks) {
    const row = document.createElement('div'); row.className = 'pipeRow';
    row.innerHTML = `<div class="pipeRowMain"><div class="pipeRowTitle"></div><div class="pipeRowSub"></div></div>`;
    row.querySelector('.pipeRowTitle').textContent = `🔒 ${l.resource} — ${l.agent}`;
    row.querySelector('.pipeRowSub').textContent = `${l.ageMin}m · ${l.task || ''}`;
    card.appendChild(row);
  }
  for (const e of events) {
    const row = document.createElement('div'); row.className = 'pipeRow';
    row.innerHTML = `<div class="pipeRowMain"><div class="pipeRowTitle"></div><div class="pipeRowSub"></div></div>`;
    row.querySelector('.pipeRowTitle').textContent = `${ACT_ICON[e.type] || '•'} ${(e.title || '').replace(/^[🔒🔓📨✳️]\s*/, '')}`.slice(0, 92);
    row.querySelector('.pipeRowSub').textContent = [relTime(e.ts), (e.summary || '').replace(/\s+/g, ' ').slice(0, 80)].filter(Boolean).join(' · ');
    if (e.url) { row.classList.add('tap'); row.onclick = () => window.open(e.url, '_blank'); }
    card.appendChild(row);
  }
  if (!events.length && !locks.length) { const x = document.createElement('div'); x.className = 'pipeEmpty'; x.textContent = 'No recent activity.'; card.appendChild(x); }
  return card;
}
function dreamCard(dr) {
  const card = document.createElement('div'); card.className = 'pipeCard';
  const head = document.createElement('div'); head.className = 'pipeHead';
  head.innerHTML = `<span class="pipeTitle">🌀 Dream-cycle</span><span class="pipeMeta">${dr.lastRunAt ? 'ran ' + relTime(Date.parse(dr.lastRunAt)) : ''}</span>`;
  card.appendChild(head);
  if (dr.summary || dr.found) {
    const s = document.createElement('div'); s.className = 'pipeEmpty';
    s.textContent = (dr.found ? dr.found + ' candidates · ' : '') + (dr.summary || '');
    card.appendChild(s);
  }
  const decs = dr.decisions || [];
  for (const dec of decs) {
    const row = document.createElement('div'); row.className = 'pipeRow';
    row.innerHTML = `<span class="pipeFlag dec-${dec.action}"></span><div class="pipeRowMain"><div class="pipeRowSub"></div></div>`;
    row.querySelector('.pipeFlag').textContent = dec.action;
    row.querySelector('.pipeRowSub').textContent = dec.text;
    card.appendChild(row);
  }
  if (!decs.length) { const e = document.createElement('div'); e.className = 'pipeEmpty'; e.textContent = 'No recent run decisions.'; card.appendChild(e); }
  return card;
}
function healthCard(h) {
  const card = document.createElement('div'); card.className = 'pipeCard';
  const worst = h.checks.some((c) => c.status === 'fail') ? 'fail' : h.checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  const head = document.createElement('div'); head.className = 'pipeHead';
  head.innerHTML = `<span class="pipeTitle">🩺 Health</span><span class="pipeMeta">checked ${relTime(Date.parse(h.checkedAt))}</span>`;
  card.appendChild(head);
  for (const c of h.checks) {
    const row = document.createElement('div'); row.className = 'pipeRow';
    row.innerHTML = `<span class="hdot ${c.status}"></span><div class="pipeRowMain"><div class="pipeRowTitle"></div><div class="pipeRowSub"></div></div>`;
    row.querySelector('.pipeRowTitle').textContent = c.label;
    row.querySelector('.pipeRowSub').textContent = c.detail;
    card.appendChild(row);
  }
  card.dataset.worst = worst;
  return card;
}
function pipeCard(title, sec, mapper) {
  const card = document.createElement('div'); card.className = 'pipeCard';
  const items = (sec && sec.items) || [];
  const total = (sec && sec.count) || 0;
  const last = items[0] ? relTime(items[0].mtime) : '—';
  const head = document.createElement('div'); head.className = 'pipeHead';
  head.innerHTML = `<span class="pipeTitle"></span><span class="pipeMeta">${total} total · last ${last}</span>`;
  head.querySelector('.pipeTitle').textContent = title;
  card.appendChild(head);
  if (!items.length) { const e = document.createElement('div'); e.className = 'pipeEmpty'; e.textContent = 'Nothing recorded yet.'; card.appendChild(e); return card; }
  for (const it of items) {
    const m = mapper(it);
    const row = document.createElement('div'); row.className = 'pipeRow';
    row.innerHTML = `<div class="pipeRowMain"><div class="pipeRowTitle"></div><div class="pipeRowSub"></div></div>${m.flag ? '<span class="pipeFlag"></span>' : ''}`;
    row.querySelector('.pipeRowTitle').textContent = m.title;
    row.querySelector('.pipeRowSub').textContent = m.sub;
    if (m.flag) row.querySelector('.pipeFlag').textContent = m.flag;
    if (it.path) { row.classList.add('tap'); row.onclick = () => openPipeDetail(it.path, m.title); }
    card.appendChild(row);
  }
  return card;
}
async function openPipeDetail(path, title) {
  const body = $('pipesBody'); body.innerHTML = '<p class="empty">Loading…</p>';
  let r; try { r = await (await api('/api/fs?path=' + encodeURIComponent(path))).json(); }
  catch { body.innerHTML = '<p class="empty">Could not load.</p>'; return; }
  body.innerHTML = ''; pipeView = 'detail';
  const back = document.createElement('button'); back.className = 'tab'; back.style.margin = '10px 14px 4px';
  back.textContent = '‹ Pipelines'; back.onclick = openPipelines; body.appendChild(back);
  const doc = document.createElement('div'); doc.className = 'pipeDoc';
  if (r.tooBig) doc.textContent = 'File too large to preview.';
  else doc.innerHTML = md((r.content || '').replace(/^---\n[\s\S]*?\n---\n/, '')); // drop frontmatter
  body.appendChild(doc);
  $('pipesBody').scrollTop = 0;
}

/* ---------- chat ---------- */
let wsLastMsg = 0, wsWatchdog = null;
function resetWsWatchdog() {
  wsLastMsg = Date.now();
  if (wsWatchdog) return;
  wsWatchdog = setInterval(() => {
    if (!ws || $('chat').classList.contains('hidden')) return;
    if (Date.now() - wsLastMsg > 40000) {
      // no message in 40s → zombie socket; force close to trigger reconnect
      try { ws.close(); } catch {}
      ws = null;
      clearInterval(wsWatchdog); wsWatchdog = null;
      connectWS();
    }
  }, 10000);
}
function subscribeCurrentWS() {
  if (!cur.key || !ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify({ type: 'subscribe', key: cur.key })); } catch {}
}
function connectWS() {
  if (ws && ws.readyState <= 1) { if (ws.readyState === 1) subscribeCurrentWS(); return; }
  if (wsWatchdog) { clearInterval(wsWatchdog); wsWatchdog = null; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.onmessage = (e) => { resetWsWatchdog(); onServer(JSON.parse(e.data)); };
  ws.onopen = () => { resetWsWatchdog(); subscribeCurrentWS(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onclose = () => { if (wsWatchdog) { clearInterval(wsWatchdog); wsWatchdog = null; } if (!$('chat').classList.contains('hidden')) setTimeout(connectWS, 800); };
}
function setNewChatIntro(on) {
  const chat = $('chat');
  if (chat) chat.classList.toggle('newChatIntro', !!on);
}
async function openChat(s) {
  const renderSeq = ++chatRenderSeq;
  const key = s.id || ('new-' + Math.random().toString(16).slice(2, 10));
  cur = { id: s.id || null, key, cwd: s.cwd || defaultCwd, title: s.title || 'New chat', mode: 'normal', agent: s.agent || cur.agent || 'claude', archived: !!s.archived, parentId: s.parentId || null, parentTitle: s.parentTitle || '', settings: normalizeSettings(s.settings || cur.settings), context: s.context || null, firstUser: null, hadHistory: !!s.id };
  navTo({ view: 'chat', id: cur.id, title: cur.title, agent: cur.agent, key: cur.key, archived: cur.archived });
  images = []; renderAttach(); renderQueue([]); setMode('normal'); setAgent(cur.agent);
  restoreDraft();   // per-chat composer text (replaces whatever was left from the previous chat)
  $('chatTitle').textContent = cur.title;
  updateArchiveButton();
  renderContextMeter();
  $('messages').innerHTML = ''; live = null; running = false; waitingState = null;  // drop any stale waiting-prompt state from the chat we just left, else submit() stays blocked here
  if ($('attnPanel')) closeAttention();   // never open the attention page on top of a freshly-opened chat
  show('chat');
  setNewChatIntro(!s.id && !(s.carry && s.carry.length));
  // Linear-agent session → show an approval bar (merge PR / mark done / archive)
  const inc = (s.subcat === 'linear' || /linear-dispatch/.test(s.cwd || '')) && (String(s.cwd || '') + ' ' + (s.title || '')).match(/INC-\d+/);
  renderLinearBar(inc ? inc[0] : null, s.id);
  cur.histCursor = 0; cur.hasMoreHistory = false; cur.loadingEarlier = false;
  if (s.id) {
    const h = await (await api(`/api/sessions/${s.id}/history`)).json();
    if (renderSeq !== chatRenderSeq) return;
    cur.cwd = h.cwd || cur.cwd; cur.settings = normalizeSettings(h.settings || cur.settings); if (h.agent) setAgent(h.agent); else refreshAgentChip();
    if (typeof h.archived === 'boolean') { cur.archived = h.archived; updateArchiveButton(); }
    cur.parentId = h.parentId || cur.parentId || null; cur.parentTitle = h.parentTitle || cur.parentTitle || '';
    cur.context = h.context || cur.context; renderContextMeter();
    cur.histCursor = h.cursor || 0; cur.hasMoreHistory = !!h.hasMore;
    await renderHistoryBatch(h.messages, renderSeq);
    if (renderSeq !== chatRenderSeq) return;
    scrollBottom();
  } else if (s.carry && s.carry.length) {
    // Agent switch: render the prior transcript inline so it reads as ONE continuous
    // conversation, capped to the last 40 messages for snappiness (the agent still gets
    // the fuller context via the seed prompt).
    await renderHistoryBatch(s.carry.slice(-40), renderSeq);
    if (renderSeq !== chatRenderSeq) return;
    addSwitchDivider(s.carryFrom || 'previous agent', cur.agent === 'codex' ? 'Codex' : 'Claude');
    scrollBottom();
  } else {
    addNote(cur.parentId ? `Forked from ${cur.parentTitle || cur.parentId.slice(0, 8)}. The first turn includes parent context.` : `New ${agentLabel(cur.agent)} chat in ${shortCwd(cur.cwd)} — say anything to begin.`);
    renderContextMeter();
  }
  connectWS();
  refreshButton();
  setAttnBadge(0); // reset badge on every new chat; refreshAttnBadge below will set the real count
  refreshAttnBadge();
  setTimeout(() => $('input').focus(), 100);
}
async function renderLinearBar(inc, sessionId) {
  const bar = $('linearBar'); if (!bar) return;
  if (!inc) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden'); bar.innerHTML = `<span class="lbLoad">Loading ${inc}…</span>`;
  let d; try { d = await (await api('/api/linear/' + inc)).json(); } catch { bar.innerHTML = `<span class="lbLoad">${inc} — Linear unavailable</span>`; return; }
  if (d.error) { bar.innerHTML = `<span class="lbLoad">${inc}: ${esc(d.error)}</span>`; return; }
  const done = d.state && d.state.type === 'completed';
  const pr = d.pr;
  bar.innerHTML = '';
  const top = document.createElement('div'); top.className = 'lbTop';
  top.innerHTML = `<a href="${d.url}" target="_blank" class="lbId"></a><span class="lbState ${d.state ? d.state.type : ''}"></span><div class="lbTitle"></div>`;
  top.querySelector('.lbId').textContent = d.identifier;
  top.querySelector('.lbState').textContent = d.state ? d.state.name : '';
  top.querySelector('.lbTitle').textContent = d.title || '';
  bar.appendChild(top);
  if (pr) { const p = document.createElement('div'); p.className = 'lbPr'; p.innerHTML = `PR <a href="${pr.url}" target="_blank">#${pr.number}</a> <span class="lbState ${pr.state || 'open'}">${pr.state || 'open'}</span>`; bar.appendChild(p); }
  else { const p = document.createElement('div'); p.className = 'lbPr muted'; p.textContent = 'no PR linked'; bar.appendChild(p); }
  const actions = document.createElement('div'); actions.className = 'lbActions';
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'lbBtn ' + cls; b.textContent = label; b.onclick = async () => { b.disabled = true; await fn(); b.disabled = false; }; actions.appendChild(b); };
  if (pr && pr.state !== 'merged') btn('Merge PR', 'merge', async () => {
    if (!confirm(`Squash-merge PR #${pr.number}?`)) return;
    const r = await (await api(`/api/linear/${inc}/merge`, { method: 'POST' })).json();
    toast(r.ok ? '✅ PR merged' : (r.error || 'merge failed'), 3000); renderLinearBar(inc, sessionId);
  });
  if (!done) btn('Mark Done', 'done', async () => {
    const r = await (await api(`/api/linear/${inc}/done`, { method: 'POST' })).json();
    toast(r.ok ? `✅ ${inc} → Done` : (r.error || 'failed'), 3000); renderLinearBar(inc, sessionId);
  });
  if (sessionId) btn('Archive', 'arch', async () => openArchiveConfirm({ id: sessionId, title: cur.title, archived: false }, { leaveChat: true }));
  bar.appendChild(actions);
}
// Back from the chat, kept in lock-step with the browser history stack: the
// attention overlay and (for a fork) the parent chat are their own entries /
// forward jumps; everything else just steps history back — so the browser Back
// button, this arrow, and swipe-back all do the same thing. (ws is closed by
// renderRoute when the popped route leaves the chat.)
function goBackFromChat() {
  if (attnMode) return history.back();   // pops the chatAttn entry → renderRoute closes the overlay
  if (cur.parentId) return openChat({ id: cur.parentId, title: cur.parentTitle || 'Parent chat', cwd: cur.cwd || defaultCwd, agent: 'codex', settings: cur.settings });
  return history.back();                  // step back to the previous screen (usually the list)
}
$('backBtn').onclick = goBackFromChat;

function addNote(t) { const e = document.createElement('div'); e.className = 'muted'; e.style.textAlign = 'center'; e.style.fontSize = '13px'; e.textContent = t; $('messages').appendChild(e); }
// Visual seam in a switched chat: everything above came from the previous agent; the
// new agent picks up below with the full prior context.
function addSwitchDivider(fromLabel, toLabel) {
  const e = document.createElement('div');
  e.className = 'switchDivider';
  e.innerHTML = `<span></span>`;
  e.querySelector('span').textContent = `↪ continued in ${toLabel} from ${fromLabel}`;
  $('messages').appendChild(e);
}
function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = Date.now(), diff = now - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function buildHistElement(m) {
  const wrap = document.createElement('div'); wrap.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
  const body = document.createElement('div'); body.className = 'body';
  let rawText = '';
  for (const p of m.parts) {
    if (p.t === 'text') {
      let text = p.text;
      if (m.role === 'user') {
        const paths = [...text.matchAll(/\[Image attached at (.+?) —/g)].map((x) => x[1]);
        text = text.replace(/^\[Image attached at .+?\]\n?/gm, '').trim();
        if (paths.length) body.appendChild(userAttachmentGrid(paths));
      }
      rawText += (rawText ? '\n' : '') + text;
      if (text) { const d = document.createElement('div'); d.innerHTML = m.role === 'user' ? esc(text) : md(text); body.appendChild(d); }
    } else if (m.role === 'user' && (p.t === 'image' || p.t === 'file') && p.path) {
      body.appendChild(userAttachmentGrid([p.path]));
    } else if (p.t === 'tool') body.appendChild(toolChip(p.name, summarize(p.name, p.input), { input: p.detail || p.input, result: p.result }));
  }
  rawText = rawText.trim();
  wrap.dataset.rawText = rawText;
  if (m.ts) wrap.dataset.ts = m.ts;   // stable key so "My messages" can jump to this exact message
  if (!rawText) wrap.classList.add('toolonly');   // tool-only step → no copy/timestamp footer (native-style)
  wrap.appendChild(body);
  // Only show the copy/timestamp footer on messages with actual text — tool-only steps
  // stay clean (no "1m ago" + copy between every tool row).
  if (rawText) {
    const acts = document.createElement('div'); acts.className = 'msgActions';
    const cpBtn = document.createElement('button'); cpBtn.className = 'iconbtn ghost msgCopy'; cpBtn.title = 'copy'; cpBtn.innerHTML = ICONS.copy;
    cpBtn.onclick = () => navigator.clipboard.writeText(rawText || body.innerText).then(() => toast('Copied!')).catch(() => {});
    if (m.ts) { const ts = document.createElement('span'); ts.className = 'msgTs'; ts.textContent = fmtTs(m.ts); acts.appendChild(ts); }
    acts.appendChild(cpBtn); wrap.appendChild(acts);
  }
  return wrap;
}
function addHistMessage(m) { const el = buildHistElement(m); $('messages').appendChild(el); return el.querySelector('.body'); }
function nextPaint() {
  return new Promise((resolve) => {
    if (window.requestAnimationFrame) requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
async function renderHistoryBatch(messages, seq) {
  const list = messages || [];
  const batchSize = list.length > 140 ? 12 : 24;
  for (let i = 0; i < list.length; i += batchSize) {
    if (seq !== chatRenderSeq) return false;
    const frag = document.createDocumentFragment();
    for (const m of list.slice(i, i + batchSize)) frag.appendChild(buildHistElement(m));
    $('messages').appendChild(frag);
    if (i + batchSize < list.length) await nextPaint();
  }
  return true;
}

/* load older history when user scrolls to top */
async function loadEarlierMessages() {
  if (!cur.id || !cur.hasMoreHistory || cur.loadingEarlier) return;
  cur.loadingEarlier = true;
  const container = $('messages');
  const loader = document.createElement('div'); loader.className = 'histLoader'; loader.textContent = 'Loading earlier…';
  container.insertBefore(loader, container.firstChild);
  const prevHeight = container.scrollHeight;
  try {
    const h = await (await api(`/api/sessions/${cur.id}/history?before=${cur.histCursor}`)).json();
    loader.remove();
    if (!h.messages || !h.messages.length) { cur.hasMoreHistory = false; const note = document.createElement('div'); note.className = 'histEnd'; note.textContent = '— beginning of conversation —'; container.insertBefore(note, container.firstChild); return; }
    // prepend in order (oldest first = same as h.messages array order)
    for (let i = h.messages.length - 1; i >= 0; i--) {
      container.insertBefore(buildHistElement(h.messages[i]), container.firstChild);
    }
    cur.histCursor = h.cursor; cur.hasMoreHistory = h.hasMore;
    if (!cur.hasMoreHistory) { const note = document.createElement('div'); note.className = 'histEnd'; note.textContent = '— beginning of conversation —'; container.insertBefore(note, container.firstChild); }
    // restore scroll position — shift by how much content was added above
    container.scrollTop += container.scrollHeight - prevHeight;
  } catch { loader.remove(); }
  finally { cur.loadingEarlier = false; }
}
$('messages').addEventListener('scroll', () => {
  if ($('messages').scrollTop < 400 && cur.hasMoreHistory && !cur.loadingEarlier) loadEarlierMessages();
});
function fileExtIcon(ext) {
  const e = (ext || '').toLowerCase();
  if (['txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml'].includes(e)) return ICONS.copy;
  if (['pdf'].includes(e)) return ICONS.folder;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) return ICONS.copy;
  return ICONS.copy;
}
function sendFileCards(files, caption) {
  const wrap = document.createElement('div'); wrap.className = 'fileCards';
  if (caption) { const cap = document.createElement('div'); cap.className = 'fileCaption'; cap.textContent = caption; wrap.appendChild(cap); }
  for (const fp of (files || [])) {
    const fname = fp.split('/').pop();
    const ext = fname.includes('.') ? fname.split('.').pop() : '';
    const card = document.createElement('div');
    card.className = 'fileCard';
    card.innerHTML = `<span class="fileCardIcon">${ICONS.copy}</span><span class="fileCardName">${esc(fname)}</span><span class="fileCardExt">${ext ? esc(ext.toUpperCase()) : 'FILE'}</span><span class="fileCardDl">${ICONS['arrow-down']}</span>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.fileCardDl')) return;
      openFile(fp);
    });
    card.querySelector('.fileCardDl').addEventListener('click', (e) => {
      e.stopPropagation();
      fetch(rawFileUrl(fp)).then((r) => r.blob()).then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fname; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }).catch(() => window.open(rawFileUrl(fp), '_blank'));
    });
    wrap.appendChild(card);
  }
  return wrap;
}
function toolChip(name, info, data) {
  // AskUserQuestion → interactive card with tappable options
  if (name === 'AskUserQuestion') {
    let questions = (data && data.input && data.input.questions) || [];
    // Defensive shape fallbacks so a slightly different payload still renders.
    if (!questions.length && data && data.input) {
      if (Array.isArray(data.input)) questions = data.input;
      else if (data.input.question) questions = [data.input];
    }
    const wrap = document.createElement('div'); wrap.className = 'askUserCard';
    // Never render a SILENT empty card — that's what made the chat look stuck. If the
    // options didn't come through, show a clear, visible prompt so the user knows a question
    // is waiting and can just type the answer to continue.
    if (!questions.length) {
      const fb = document.createElement('div'); fb.className = 'askUserQ askUserFallback';
      fb.innerHTML = '<div class="askUserQuestion">⚠️ A question is waiting for your answer, but its options couldn’t be rendered here. Type your answer below to continue (or open this chat on desktop).</div>';
      wrap.appendChild(fb);
      return wrap;
    }
    for (const q of questions) {
      const qEl = document.createElement('div'); qEl.className = 'askUserQ';
      if (q.header) { const h = document.createElement('div'); h.className = 'askUserHeader'; h.textContent = q.header; qEl.appendChild(h); }
      if (q.question) { const qt = document.createElement('div'); qt.className = 'askUserQuestion'; qt.textContent = q.question; qEl.appendChild(qt); }
      for (const opt of (q.options || [])) {
        const btn = document.createElement('button'); btn.className = 'askUserOpt';
        btn.innerHTML = `<span class="askOptLabel">${esc(opt.label)}</span>` + (opt.description ? `<span class="askOptDesc">${esc(opt.description)}</span>` : '');
        btn.onclick = () => {
          if (btn.classList.contains('selected')) return;
          wrap.querySelectorAll('.askUserOpt').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          enqueueText(opt.label, { force: true, displayText: opt.label });
        };
        qEl.appendChild(btn);
      }
      // "Other" — just focuses the composer so they can type freely
      const other = document.createElement('button'); other.className = 'askUserOpt askUserOther'; other.textContent = 'Other…';
      other.onclick = () => { try { $('input').focus(); } catch {} };
      qEl.appendChild(other);
      wrap.appendChild(qEl);
    }
    return wrap;
  }
  // SendUserFile → render as tappable file download cards instead of a generic chip
  if (name === 'SendUserFile') {
    const files = data && data.input && data.input.files || [];
    const caption = data && data.input && data.input.caption || '';
    return sendFileCards(files, caption);
  }
  const c = document.createElement('div'); c.className = 'toolchip clickable';
  const rawInput = (data && data.input) || {};
  const path = rawInput.file_path;
  const isImg = name === 'Read' && path && /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(path);
  // Native-style subtle row: bold verb + muted description + chevron. For Bash, prefer
  // the human-readable description over the raw command (matches the desktop app).
  let desc = info;
  if (name === 'Bash' && rawInput.description) desc = rawInput.description;
  const mono = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob'].includes(name);
  c.innerHTML = `<div class="tchipHead"><span class="tverb">${esc(toolVerb(name))}</span>` +
    (desc ? `<span class="tdesc${mono ? ' mono' : ''}">${esc(desc)}</span>` : '') +
    `<span class="tgo">›</span></div>`;
  if (isImg) {
    c.classList.add('imgchip');
    const preview = document.createElement('img'); preview.src = rawFileUrl(path); preview.className = 'tchipThumb';
    c.appendChild(preview);
    preview.onclick = (e) => {
      e.stopPropagation();
      const all = [...$('messages').querySelectorAll('.umgs img, .tchipThumb')];
      window.openImageLightbox(all.map((i) => i.src), all.indexOf(preview));
    };
  }
  c.onclick = () => openToolDetail(name, data || {});
  return c;
}
function summarize(name, input) {
  if (!input) return '';
  if (name === 'Bash') return (input.command || '').slice(0, 60);
  if (['Read', 'Edit', 'Write'].includes(name)) return (input.file_path || '').split('/').slice(-1)[0];
  if (['Grep', 'Glob'].includes(name)) return input.pattern || '';
  if (name === 'Task') return input.description || '';
  return '';
}
// Friendly past-tense verb per tool (native-app style: "Read index.mjs", "Ran <desc>").
const TOOL_VERB = { Read: 'Read', Bash: 'Ran', Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', NotebookEdit: 'Edited', Grep: 'Searched', Glob: 'Searched', Task: 'Delegated', WebFetch: 'Fetched', WebSearch: 'Searched', TodoWrite: 'Updated plan', SlashCommand: 'Ran', ApplyPatch: 'Edited', MCP: 'Tool' };
const toolVerb = (name) => TOOL_VERB[name] || name;

/* busy / stop / queue state — server is the source of truth */
let running = false;     // a turn is currently running for this session
let recording = false;   // mic is recording (live transcription in progress)
let attnMode = false;    // the needs-attention reply page is open → composer is Send-only (never Stop)
let attnLinear = true;   // Linear tab: show the INC issues this session touched, or the global board queue
function refreshButton() {
  const hasText = !!($('input').value.trim() || images.length);
  const btn = $('sendBtn');
  $('stopBtn').classList.add('hidden');   // merged into the one send/stop button
  // On the needs-attention page the composer is a REPLY box: it must NEVER turn into a Stop
  // button (the user was — rightly — afraid that tapping stop there would kill the running session).
  // A reply is always Send-only; it gets queued and delivered to the session, stopping nothing.
  if (running && !hasText && !recording && !attnMode) { // empty box while a turn runs → the button becomes Stop
    btn.classList.add('stop'); btn.innerHTML = ICONS.stop; btn._painted = 1; btn.disabled = false; btn.dataset.act = 'stop';
  } else {                                 // otherwise it's Send (queues if a turn is already running)
    btn.classList.remove('stop'); btn.innerHTML = ICONS.send; btn._painted = 1; btn.disabled = recording || !hasText; btn.dataset.act = 'send';
  }
}
function updateSend() { refreshButton(); }

/* Per-chat composer drafts. Unsent text is scoped to its chat (keyed by cur.key) and
   persisted to localStorage, so it survives switching chats AND reloading the app — but
   does NOT bleed across chats the way a single shared <input> value did. */
const draftKey = (k) => 'box_draft:' + (k || '');
function loadDraft(k) { try { return LS.getItem(draftKey(k)) || ''; } catch { return ''; } }
function saveDraft(k, text) { try { if (text && text.trim()) LS.setItem(draftKey(k), text); else LS.removeItem(draftKey(k)); } catch {} }
function restoreDraft() { const inp = $('input'); inp.value = loadDraft(cur.key); autoGrow(); updateSend(); }

/* queued (pending) messages shown above the composer, each removable / tap-to-edit */
function renderQueue(items) {
  const area = $('queueArea'); area.innerHTML = '';
  const all = items || [];
  area.classList.toggle('hidden', all.length === 0);
  for (const q of all) {
    const imgs = Array.isArray(q.images) ? q.images : [];
    const el = document.createElement('div'); el.className = 'qchip' + (q.running ? ' running' : '');
    el.innerHTML = `${q.agent && q.agent !== 'claude' ? `<span class="qmode">${esc(q.agent)}</span>` : q.mode === 'bash' ? '<span class="qmode">bash</span>' : ''}${imgs.length ? '<span class="qthumbs"></span>' : ''}<span class="qt"></span><span class="qx"></span>`;
    if (imgs.length) { const th = el.querySelector('.qthumbs'); imgs.forEach((p) => { const im = document.createElement('img'); im.src = imgUrl(p); th.appendChild(im); }); }
    el.querySelector('.qt').textContent = q.text || (imgs.length ? `${imgs.length} image${imgs.length > 1 ? 's' : ''}` : '');
    const x = el.querySelector('.qx'); x.innerHTML = ICONS.close;
    if (q.running) {
      x.style.opacity = '0'; x.style.pointerEvents = 'none';
    } else {
      el.title = 'Tap to edit · ✕ to remove';
      x.onclick = (e) => { e.stopPropagation(); try { ws.send(JSON.stringify({ type: 'dequeue', key: cur.key, qid: q.qid })); } catch {} };
      // tap chip body → pull it back into the composer (and remove from the queue) for editing.
      // Don't clobber half-typed text: if the box already has content, append on a new line.
      el.addEventListener('click', (e) => {
        if (e.target.closest('.qx')) return;
        if (!q.text) { try { ws.send(JSON.stringify({ type: 'dequeue', key: cur.key, qid: q.qid })); } catch {} return; }
        const inp = $('input');
        const existing = inp.value.trim();
        inp.value = existing ? existing + '\n' + q.text : q.text;
        saveDraft(cur.key, inp.value);
        autoGrow(); updateSend(); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
        try { ws.send(JSON.stringify({ type: 'dequeue', key: cur.key, qid: q.qid })); } catch {}
      });
    }
    area.appendChild(el);
  }
}

/* live turn rendering */
let live = null;
function startAssistant() {
  killGhostIndicators();
  const wrap = document.createElement('div'); wrap.className = 'msg assistant';
  const body = document.createElement('div'); body.className = 'body';
  wrap.appendChild(body); $('messages').appendChild(wrap);
  const loading = document.createElement('div'); loading.className = 'loading'; loading.innerHTML = '<span></span><span></span><span></span>'; body.appendChild(loading);
  const textEl = document.createElement('div'); textEl.className = 'cursor'; body.appendChild(textEl);
  live = { body, raw: '', textEl, loading }; running = true; refreshButton(); scrollBottom();
}
function clearLoading() { if (live && live.loading) { live.loading.remove(); live.loading = null; } }
// remove orphaned streaming indicators (blinking cursor / loading dots) left by a previous
// turn or a reconnect — prevents stray ghost indicators lingering in the transcript.
function killGhostIndicators() { $('messages').querySelectorAll('.cursor').forEach((e) => e.classList.remove('cursor')); $('messages').querySelectorAll('.loading').forEach((e) => e.remove()); }
const imgUrl = (p) => '/api/img?path=' + encodeURIComponent(p) + '&token=' + encodeURIComponent(TOKEN);
// For arbitrary filesystem paths (e.g. tool Read on an image), use /api/raw which has no dir restriction
const rawFileUrl = (p) => '/api/raw?path=' + encodeURIComponent(p) + '&token=' + encodeURIComponent(TOKEN);
// Remember the last user bubble we drew, so a re-echoed copy of the SAME message (e.g. the
// server's own injected-echo suppression desyncing on a force-queue + Stop, which leaks the
// echo back as a `remote_user`) can be dropped instead of rendering the message twice.
let lastUserRender = { text: '', at: 0 };
function isRecentDupUser(text) { return (text || '') === lastUserRender.text && (Date.now() - lastUserRender.at) < 15000; }
function userAttachmentGrid(paths) {
  const r = document.createElement('div'); r.className = 'umgs';
  (paths || []).forEach((p) => {
    if (isImagePath(p)) { const im = document.createElement('img'); im.src = imgUrl(p); r.appendChild(im); }
    else { const fc = document.createElement('div'); fc.className = 'umgFile'; fc.innerHTML = `<span class="umgFileIcon">${ICONS.file}</span><span class="umgFileName">${esc(String(p).split('/').pop())}</span>`; r.appendChild(fc); }
  });
  return r;
}
function addUser(text, images) {
  setNewChatIntro(false);
  lastUserRender = { text: text || '', at: Date.now() };
  const wrap = document.createElement('div'); wrap.className = 'msg user';
  wrap.dataset.rawText = text || '';
  const body = document.createElement('div'); body.className = 'body';
  if (images && images.length) {
    body.appendChild(userAttachmentGrid(images));
  }
  if (text) { const t = document.createElement('div'); t.textContent = text; body.appendChild(t); }
  wrap.appendChild(body);
  const acts = document.createElement('div'); acts.className = 'msgActions';
  const cpBtn = document.createElement('button'); cpBtn.className = 'iconbtn ghost msgCopy'; cpBtn.title = 'copy'; cpBtn.innerHTML = ICONS.copy;
  cpBtn.onclick = () => navigator.clipboard.writeText(text || '').then(() => toast('Copied!')).catch(() => {});
  acts.appendChild(cpBtn); wrap.appendChild(acts);
  $('messages').appendChild(wrap);
}
function beginTurn(text, images) { clearWaitingCard(); addUser(text || '', images); startAssistant(); running = true; refreshButton(); }

function onServer(o) {
  if (o.type === 'ping') return; // server heartbeat — onmessage wrapper already reset watchdog
  if (o.type === 'sync') return onSync(o);
  // cur.hadHistory MUST flip true once the real id is known: a brand-new chat opens with
  // hadHistory=false, renders the user bubble from turn_start, THEN learns its id here. If
  // the WS later reconnects mid-first-turn, onSync re-adds the user bubble (guarded only by
  // !cur.hadHistory) → the message renders twice. Marking it now suppresses that re-add.
  if (o.type === 'session') { cur.id = o.id; cur.hadHistory = true; if (o.agent) setAgent(o.agent); if (o.parentId) cur.parentId = o.parentId; if (o.parentTitle) cur.parentTitle = o.parentTitle; if (o.title) { cur.title = o.title; $('chatTitle').textContent = o.title; } return; }
  if (o.type === 'settings') { cur.settings = normalizeSettings(o.settings); refreshAgentChip(); return; }
  // a user message typed from ANOTHER device (desktop / official app) — sync it in.
  // Drop it if it just duplicates a bubble we rendered moments ago (a leaked self-echo from
  // force-queue + Stop), so the message doesn't render twice.
  if (o.type === 'remote_user') { if (isRecentDupUser(o.text || '')) return; if (live) finishTurn({ sessionId: cur.id }); beginTurn(o.text || '', []); return; }
  if (o.type === 'queue') return renderQueue(o.queue);
  if (o.type === 'attention_updated') { refreshAttnBadge(); if (attnMode) showAttention(); return; }
  if (o.type === 'context') { cur.context = o.context || null; renderContextMeter(); return; }
  if (o.type === 'turn_start') return beginTurn(o.text, o.images);
  if (o.type === 'idle') { running = false; killGhostIndicators(); refreshButton(); return; }
  if (o.type === 'thinking') { if (live) { clearLoading(); if (!live.think) { live.think = document.createElement('div'); live.think.className = 'thinking'; live.body.insertBefore(live.think, live.textEl); } live.think.textContent += o.delta; } }
  else if (o.type === 'text') { if (!live) startAssistant(); clearLoading(); live.raw += o.delta; queueRender(); }
  else if (o.type === 'tool') {
    if (!live) startAssistant(); clearLoading();
    live.textEl.classList.remove('cursor'); live.textEl.innerHTML = md(live.raw);
    const data = { input: o.detail }; (live.toolData = live.toolData || {})[o.id] = data;
    // Place the chip AFTER the text that preceded it. live.textEl holds the just-streamed
    // pre-tool text; inserting the chip BEFORE it pushed that text below the chip — so a
    // summary written right before an AskUserQuestion rendered UNDER the question card.
    const chip = toolChip(o.name, o.input || '', data);
    live.textEl.insertAdjacentElement('afterend', chip);
    live.raw = ''; const nt = document.createElement('div'); nt.className = 'cursor'; chip.insertAdjacentElement('afterend', nt); live.textEl = nt; maybeScroll();
    // AskUserQuestion pauses the turn waiting for user input — clear the running/loading state so Send shows
    if (o.name === 'AskUserQuestion') { live.textEl.classList.remove('cursor'); running = false; killGhostIndicators(); refreshButton(); }
  }
  else if (o.type === 'tool_result') { if (live && live.toolData && live.toolData[o.id]) live.toolData[o.id].result = o.content; }
  else if (o.type === 'bash_out') { if (!live) startAssistant(); clearLoading(); if (!live.bash) { live.bash = document.createElement('div'); live.bash.className = 'bashout'; live.body.appendChild(live.bash); } live.bash.textContent += o.text; maybeScroll(); }
  else if (o.type === 'notice') { if (!live) startAssistant(); const n = document.createElement('div'); n.className = 'notice'; n.textContent = o.text; live.body.appendChild(n); maybeScroll(); }
  else if (o.type === 'error') { if (!live) startAssistant(); clearLoading(); const e = document.createElement('div'); e.className = 'err'; e.textContent = o.msg; live.body.appendChild(e); }
  else if (o.type === 'blocked') renderBlocked(o);
  else if (o.type === 'waiting') renderWaiting(o);
  else if (o.type === 'waiting_clear') clearWaitingCard();
  else if (o.type === 'done') finishTurn(o);
}
function onSync(o) {
  // restore in-flight turn + pending queue after a (re)connect
  if (o.sessionId) cur.id = o.sessionId;
  // Only let the server's agent win for a REAL, already-created session. A brand-new chat
  // has no server-side session yet, so subscribe returns the default agent ('claude') — applying
  // it here would clobber the agent the user just picked (e.g. Codex), making the menu flip back
  // to Claude a tick after opening. The local pick stays authoritative until the session exists.
  if (o.agent && o.sessionId) setAgent(o.agent);
  if (o.parentId) cur.parentId = o.parentId;
  if (o.parentTitle) cur.parentTitle = o.parentTitle;
  if (o.title && isPlaceholderChatTitle(cur.title)) { cur.title = o.title; $('chatTitle').textContent = o.title; }
  if (typeof o.archived === 'boolean') { cur.archived = o.archived; updateArchiveButton(); }
  if (o.settings) { cur.settings = normalizeSettings(o.settings); refreshAgentChip(); }
  if (o.context) { cur.context = o.context; renderContextMeter(); }
  // Remove stale live bubble from DOM before recreating it below (prevents duplicate
  // assistant bubbles when the WS reconnects mid-stream and onSync fires again).
  if (live && live.body && live.body.parentElement) live.body.parentElement.remove();
  live = null; killGhostIndicators();
  if (o.running) {
    // Reopening/reloading a session whose latest turn is still in-flight would render
    // that turn TWICE: REST /history already drew the in-flight turn's assistant blocks
    // (they're flushed to the JSONL as the turn runs), and the live path below redraws
    // the SAME turn from curParts. When history is present (cur.hadHistory), drop its
    // copy of the in-flight assistant turn — every node after the last user bubble — so
    // only the live rebuild remains. The user bubble itself stays (history owns it).
    if (cur.hadHistory) {
      const kids = [...$('messages').children];
      let lastUser = -1;
      kids.forEach((el, i) => { if (el.classList && el.classList.contains('msg') && el.classList.contains('user')) lastUser = i; });
      if (lastUser >= 0) for (let i = kids.length - 1; i > lastUser; i--) kids[i].remove();
    }
    if (!cur.hadHistory && (o.curUser || (o.curUserImages || []).length) && !isRecentDupUser(o.curUser || '')) addUser(o.curUser, o.curUserImages);  // existing sessions already have it in history; skip if we just drew it
    startAssistant();
    if (Array.isArray(o.curParts) && o.curParts.length) {
      // Rebuild the in-flight turn in its REAL order — interleaved tool chips and
      // SEPARATE text segments — mirroring the live text/tool handlers exactly, so a
      // mid-turn reconnect doesn't jam every message into one block.
      for (const p of o.curParts) {
        if (p.t === 'tool') {
          live.textEl.classList.remove('cursor'); live.textEl.innerHTML = md(live.raw);
          (live.toolData = live.toolData || {})[p.id] = { input: p.detail, result: p.result };
          // chip AFTER the preceding text segment (not before live.textEl) — keep real order
          const chip = toolChip(p.name, p.input || '', live.toolData[p.id]);
          live.textEl.insertAdjacentElement('afterend', chip);
          live.raw = ''; const nt = document.createElement('div'); nt.className = 'cursor'; chip.insertAdjacentElement('afterend', nt); live.textEl = nt;
        } else if (p.t === 'text' && p.text) { clearLoading(); live.raw += p.text; live.textEl.innerHTML = md(live.raw); }
      }
    } else {
      // legacy fallback (server snapshot without curParts)
      (o.curTools || []).forEach((t) => { live.textEl.classList.remove('cursor'); live.body.insertBefore(toolChip(t.name, t.input || '', { input: t.detail, result: t.result }), live.textEl); const nt = document.createElement('div'); nt.className = 'cursor'; live.body.appendChild(nt); live.textEl = nt; });
      if (o.curText) { clearLoading(); live.raw = o.curText; live.textEl.innerHTML = md(live.raw); }
    }
    running = true;
    // If the in-flight turn is parked on an AskUserQuestion (tool emitted, no result yet),
    // claude is waiting on the user — surface it as ANSWERABLE (enable the composer) just
    // like the live handler does, so a reconnect doesn't leave the question looking like
    // it's still "running" with no way to respond.
    const parts = (o.curParts && o.curParts.length) ? o.curParts : (o.curTools || []);
    const lastTool = [...parts].reverse().find((p) => (p.t === 'tool' || p.name) && p.name);
    if (lastTool && lastTool.name === 'AskUserQuestion' && !lastTool.result) { running = false; killGhostIndicators(); }
  } else running = false;
  renderQueue(o.queue); refreshButton(); scrollBottom();
}
let raf = 0;
function queueRender() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (live) { live.textEl.innerHTML = md(live.raw); maybeScroll(); } }); }
function finishTurn(o) {
  if (live) {
    clearLoading(); live.textEl.classList.remove('cursor'); live.textEl.innerHTML = md(live.raw);
    if (o.canceled) { const s = document.createElement('div'); s.className = 'stoppedTag'; s.textContent = 'stopped'; live.body.appendChild(s); }
    const rawText = live.raw; const msgWrap = live.body.parentElement;
    if (msgWrap) {
      msgWrap.dataset.rawText = rawText;
      const acts = document.createElement('div'); acts.className = 'msgActions';
      const cpBtn = document.createElement('button'); cpBtn.className = 'iconbtn ghost msgCopy'; cpBtn.title = 'copy'; cpBtn.innerHTML = ICONS.copy;
      cpBtn.onclick = () => navigator.clipboard.writeText(rawText).then(() => toast('Copied!')).catch(() => {});
      acts.appendChild(cpBtn); msgWrap.appendChild(acts);
    }
  }
  live = null; killGhostIndicators();
  running = false; refreshButton();
  if (o.sessionId && !cur.id) cur.id = o.sessionId;
  if (isPlaceholderChatTitle(cur.title) && cur.firstUser) { cur.title = cur.firstUser.slice(0, 50); $('chatTitle').textContent = cur.title; }
  maybeScroll();
}

function normalizeSettings(settings) {
  return {
    codex: { ...DEFAULT_SETTINGS.codex, ...((settings && settings.codex) || {}) },
    gemini: { ...DEFAULT_SETTINGS.gemini, ...((settings && settings.gemini) || {}) },
    agy: { ...DEFAULT_SETTINGS.agy, ...((settings && settings.agy) || {}) },
    claude: { ...DEFAULT_SETTINGS.claude, ...((settings && settings.claude) || {}) },
  };
}
function sendSettings() {
  cur.settings = normalizeSettings(cur.settings);
  refreshAgentChip();
  const payload = { type: 'settings', key: cur.key, settings: cur.settings };
  connectWS();
  const go = () => { try { ws.send(JSON.stringify(payload)); } catch {} };
  if (ws.readyState === 1) go();
  else ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'subscribe', key: cur.key })); go(); }, { once: true });
}

/* send = enqueue (server owns the queue; it persists + auto-sends even if you leave) */
function enqueueText(text, opts = {}) {
  const payload = { type: 'enqueue', key: cur.key, text, images: opts.images || [], mode: cur.mode, agent: cur.agent || 'claude', cwd: cur.cwd };
  if (opts.force) payload.force = true;  // take-over: spawn the box's bridge even though a foreign owner is live
  if (opts.displayText != null) payload.displayText = opts.displayText;
  if (opts.parentId || cur.parentId) payload.parentId = opts.parentId || cur.parentId;
  if (opts.parentTitle || cur.parentTitle) payload.parentTitle = opts.parentTitle || cur.parentTitle;
  if (opts.title) payload.title = opts.title;
  connectWS();
  const go = () => { try { ws.send(JSON.stringify(payload)); } catch {} };
  if (ws.readyState === 1) go();
  else ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'subscribe', key: cur.key })); go(); }, { once: true });
  refreshButton(); scrollBottom();
}
function submit() {
  const text = $('input').value.trim();
  if (!text && !images.length) return;
  hideSuggest();
  // A pending question/plan is up → a typed reply is a free-text ("Other") answer to it.
  if (waitingState && waitingState.answerable) {
    if (!text) return;
    // A MENU is up (AskUserQuestion / plan): a typed reply only maps to its free-text ("Other")
    // option — if the menu has none, the user must tap a button. But a permission / generic
    // "Claude is waiting for your input" prompt has NO menu (hasOptions=false); there the typed
    // reply IS the answer and must go straight through. (This case used to be wrongly blocked,
    // so you could never answer a permission prompt from the phone.)
    if (waitingState.hasOptions && !(waitingState.freeTextIndex >= 1)) {
      toast('Tap an option above, or answer on desktop'); return;
    }
    const ft = waitingState.freeTextIndex; const hadMenu = waitingState.hasOptions; waitingState = null;   // optimistic
    $('input').value = ''; saveDraft(cur.key, ''); autoGrow(); addUser(text, []);
    const sel = (hadMenu && ft >= 1) ? { text, freeTextIndex: ft } : { text };
    try { ws.send(JSON.stringify({ type: 'answer_waiting', key: cur.key, sel })); } catch {}
    document.querySelectorAll('.waitingCard').forEach((el) => el.remove());
    refreshButton(); scrollBottom();
    return;
  }
  if (!cur.firstUser) cur.firstUser = text;
  const imgPaths = images.map((i) => i.path);
  $('input').value = ''; saveDraft(cur.key, ''); autoGrow(); images = []; renderAttach();
  setNewChatIntro(false);
  enqueueText(text, { images: imgPaths });
  // If they were answering on the needs-attention page, drop back to the chat to watch it land.
  if (!$('attnPanel').classList.contains('hidden')) closeAttention();
}
// Only shown for a REAL external owner: this chat is live on your laptop / the
// official Claude app (NOT a box-side twin — those are now reattached to
// automatically, so directing a box session "just works"). Opening a second
// remote-control bridge here would make the two owners archive-loop each other, so
// the box held the message. One-tap take-over: re-send with force — the box becomes
// the live owner. (Close the chat on the other device first to avoid a brief fight.)
function renderBlocked(o) {
  if (!live) startAssistant();
  clearLoading();
  running = false; killGhostIndicators(); refreshButton();
  const box = document.createElement('div'); box.className = 'blocked';
  const msg = document.createElement('div'); msg.className = 'blockedMsg';
  msg.textContent = 'This chat is open live on another device (your laptop or the official Claude app). To avoid the two fighting, it wasn’t sent. Close it there, then take over — or tap below to take over now.';
  const btn = document.createElement('button'); btn.className = 'takeover'; btn.textContent = 'Take over here';
  btn.onclick = () => { box.remove(); enqueueText(o.text || '', { images: o.images || [], force: true }); };
  box.appendChild(msg); box.appendChild(btn);
  live.body.appendChild(box); maybeScroll();
}
// A pending interactive prompt (AskUserQuestion / plan approval / permission). These never reach
// the JSONL until answered, so the server detects the parked state + scrapes the TUI and pushes it
// here; tapping an option (or typing a reply) injects the answer back into the live session.
function clearWaitingCard() {
  waitingState = null;
  document.querySelectorAll('.waitingCard').forEach((el) => el.remove());
  $('input').placeholder = cur.mode === 'bash' ? 'Run a command on the box…' : 'Message…';
  refreshButton();
}
function renderWaiting(o) {
  clearWaitingCard();                 // never stack two cards
  if (!live) startAssistant();
  clearLoading(); running = false; killGhostIndicators();
  waitingState = { answerable: !!o.answerable, freeTextIndex: null, hasOptions: false };
  const card = document.createElement('div'); card.className = 'waitingCard';
  const p = o.prompt;
  if (p && Array.isArray(p.options) && p.options.length) {
    waitingState.hasOptions = true;
    if (p.header) { const h = document.createElement('div'); h.className = 'waitHeader'; h.textContent = p.header; card.appendChild(h); }
    const q = document.createElement('div'); q.className = 'waitQuestion';
    q.textContent = p.title || (p.kind === 'plan' ? 'Review the plan and choose how to proceed' : 'Claude is asking a question');
    card.appendChild(q);
    const ft = p.options.find((x) => x.freeText); if (ft) waitingState.freeTextIndex = ft.n;
    for (const opt of p.options) {
      if (opt.freeText) continue;                          // the composer is the free-text path
      if (/^chat about this$/i.test(opt.label)) continue;  // TUI escape, not a real answer
      const btn = document.createElement('button'); btn.className = 'waitOpt';
      btn.innerHTML = `<span class="waitOptLabel">${esc(opt.label)}</span>` + (opt.desc ? `<span class="waitOptDesc">${esc(opt.desc)}</span>` : '');
      if (o.answerable) btn.onclick = () => chooseWaiting(opt.n, btn); else btn.disabled = true;
      card.appendChild(btn);
    }
    const hint = document.createElement('div'); hint.className = 'waitHint';
    hint.textContent = o.answerable ? 'or type your own answer below ↓' : 'This session is running on another device — answer it there.';
    card.appendChild(hint);
  } else {
    const q = document.createElement('div'); q.className = 'waitQuestion';
    q.textContent = '⏸ Claude is waiting for your input' + (o.waitingFor ? ` (${o.waitingFor})` : '') + '.';
    card.appendChild(q);
    const hint = document.createElement('div'); hint.className = 'waitHint';
    hint.textContent = o.answerable
      ? 'Type a reply below to continue — for a yes/no or numbered menu, type the option number (e.g. 1).'
      : 'Open this chat on desktop to answer.';
    card.appendChild(hint);
  }
  live.body.appendChild(card); maybeScroll();
  if (o.answerable) $('input').placeholder = 'Type your answer…';
  refreshButton();
}
function chooseWaiting(index, btn) {
  if (!waitingState || !waitingState.answerable) return;
  document.querySelectorAll('.waitOpt').forEach((b) => { b.disabled = true; b.classList.remove('chosen'); });
  if (btn) btn.classList.add('chosen');
  waitingState = null;   // optimistic; server confirms with waiting_clear
  try { ws.send(JSON.stringify({ type: 'answer_waiting', key: cur.key, sel: { index } })); } catch {}
}
function stopCurrent() {
  try { ws.send(JSON.stringify({ type: 'cancel', key: cur.key })); } catch {}
  if (live) { clearLoading(); live.textEl.classList.remove('cursor'); if (live.raw) live.textEl.innerHTML = md(live.raw); }
  // optimistic: if the server doesn't confirm within 1.5s, release the UI anyway
  setTimeout(() => { if (running) { running = false; refreshButton(); } }, 1500);
}
$('stopBtn').onclick = stopCurrent;
$('sendBtn').onclick = () => { if ($('sendBtn').dataset.act === 'stop') stopCurrent(); else submit(); };
$('copyInputBtn').onclick = () => {
  const text = $('input').value;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => toast('Copied!')).catch(() => {
    /* fallback for older mobile browsers */
    const t = $('input'); t.select(); t.setSelectionRange(0, t.value.length);
    document.execCommand('copy'); toast('Copied!');
  });
};
// Enter behavior: on desktop (mouse/fine pointer) Enter sends, Shift+Enter inserts a newline.
// On mobile (coarse/touch pointer) Enter inserts a newline (default); send via the ↑ button.
// ⌘/Ctrl+Enter always sends on either. IME composition (e.g. Chinese) is never treated as send.
const isTouchDevice = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
$('input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return;            // mid-IME-composition: let it confirm, don't send
  if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit(); return; }  // ⌘/Ctrl+Enter sends anywhere
  if (isTouchDevice) return;                                 // mobile: Enter = newline (default)
  if (e.shiftKey) return;                                    // desktop: Shift+Enter = newline (default)
  e.preventDefault(); submit();                              // desktop: Enter = send
});

/* textarea autogrow + @// triggers */
function autoGrow() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.38) + 'px'; }
$('input').addEventListener('input', () => { autoGrow(); onType(); updateSend(); saveDraft(cur.key, $('input').value); });

/* ---------- mode (normal / bash) ---------- */
function setMode(m) { cur.mode = m; $('modeLabel').textContent = m; $('modeChip').title = m; $('modeChip').classList.toggle('bash', m === 'bash'); $('input').placeholder = m === 'bash' ? 'Run a command on the box…' : 'Message…'; }
$('modeChip').onclick = () => openSheet('Mode', [
  { ic: '⌗', label: 'normal', sel: cur.mode === 'normal', desc: `Chat with ${agentLabel(cur.agent)}`, fn: () => setMode('normal') },
  { ic: '⌘', label: 'bash', sel: cur.mode === 'bash', desc: 'Run commands on the box', fn: () => setMode('bash') },
]);
function refreshAgentChip() {
  const agent = agentType(cur.agent);
  const cfg = (cur.settings || {})[agent];
  const rawModel = (cfg && cfg.model) || (agent === 'codex' ? 'gpt-5.5' : agent === 'gemini' ? 'gemini-3.5-flash' : agent === 'agy' ? '' : 'opus');
  const effort = agent === 'codex' ? (cfg && cfg.reasoningEffort) : (agent === 'claude' ? (cfg && cfg.effort) : '');
  const modelName = agent === 'agy' && !rawModel ? 'Antigravity' : agentModelLabel(agent, rawModel);
  $('agentLabel').textContent = effort ? `${modelName} · ${effort}` : modelName;
  $('agentChip').classList.toggle('codex', agent === 'codex');
  $('agentChip').classList.toggle('gemini', agent === 'gemini');
  $('agentChip').classList.toggle('agy', agent === 'agy');
}
function setAgent(agent) {
  cur.agent = agentType(agent);
  LS.setItem('box_agent', cur.agent);
  refreshAgentChip();
  renderContextMeter();
}
$('agentChip').onclick = () => {
  const rows = [
    { ic: agentIcon('claude'), label: 'Claude', sel: cur.agent === 'claude', desc: 'Remote-control Claude Code', fn: () => setAgent('claude') },
    { ic: agentIcon('codex'), label: 'Codex', sel: cur.agent === 'codex', desc: 'Run Codex on the box', fn: () => setAgent('codex') },
  ];
  if (agentEnabled('gemini') || cur.agent === 'gemini') rows.push({ ic: agentIcon('gemini'), label: 'Gemini', sel: cur.agent === 'gemini', desc: 'Run Gemini on the box', fn: () => setAgent('gemini') });
  if (agentEnabled('agy') || cur.agent === 'agy') rows.push({ ic: agentIcon('agy'), label: 'Antigravity', sel: cur.agent === 'agy', desc: 'Use local agy / AI Pro', fn: () => setAgent('agy') });
  if (cur.id) {
    for (const row of rows) {
      const target = row.label === 'Antigravity' ? 'agy' : row.label.toLowerCase();
      row.desc = cur.agent === target ? 'Current agent' : `Continue this transcript in ${row.label}`;
      row.fn = () => (cur.agent === target ? openModelSheet() : continueWithAgent(target));
    }
    rows.push({ ic: '', label: 'Model settings', desc: 'Change options for the active agent', fn: () => openModelSheet() });
  }
  openSheet('Agent', rows);
};

/* ---------- attach files (images + any file type) ---------- */
// Straight to the native iOS picker (it already offers Take Photo / Photo Library / Choose Files).
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => uploadFiles(e.target.files);
$('camInput').onchange = (e) => uploadFiles(e.target.files);
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif|tiff?)$/i;
const isImageFile = (f) => /^image\//.test((f && f.type) || '') || IMG_EXT_RE.test((f && f.name) || '');
const isImagePath = (p) => IMG_EXT_RE.test(p || '');
// Desktop web: attach by pasting (Cmd/Ctrl+V) or dragging onto the page. Accepts ANY file type.
// Works for both ClipboardEvent.clipboardData and DragEvent.dataTransfer (same DataTransfer API).
function filesFrom(dt) {
  const out = [];
  for (const it of (dt && dt.items) || []) {
    if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); }
  }
  if (!out.length && dt && dt.files) for (const f of dt.files) out.push(f);
  return out;
}
$('input').addEventListener('paste', (e) => {
  const files = filesFrom(e.clipboardData);
  if (!files.length) return;          // plain text/other paste → let it through unchanged
  e.preventDefault();                // don't also dump raw file bytes as junk text
  uploadFiles(files);
});
// Full-screen drop zone: drag a file anywhere over the window → overlay appears → drop to attach.
// Window-scoped so a near-miss drop can't make the browser navigate away to the file.
const dragHasFiles = (e) => { const t = e.dataTransfer && e.dataTransfer.types; return !!t && [...t].includes('Files'); };
let dragDepth = 0;
const setDragHint = (on) => { const o = $('dropOverlay'); if (o) o.classList.toggle('show', on); };
window.addEventListener('dragenter', (e) => { if (dragHasFiles(e)) { dragDepth++; setDragHint(true); } });
window.addEventListener('dragover', (e) => { if (dragHasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => { if (dragHasFiles(e)) { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setDragHint(false); } });
window.addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; setDragHint(false);
  const files = filesFrom(e.dataTransfer);
  if (files.length) uploadFiles(files);
});
// `images` is the composer's attachment buffer — images AND other files. Each entry:
// { path, url (object-url preview for images, '' otherwise), name, isImage }.
async function uploadFiles(files) {
  if (!files || !files.length) return;
  const picked = [...files].slice(0, 6);
  const fd = new FormData(); picked.forEach((f) => fd.append('images', f));
  toast('uploading…');
  try {
    const d = await (await api('/api/upload', { method: 'POST', body: fd })).json();
    d.paths.forEach((p, i) => {
      const f = picked[i]; const img = isImageFile(f);
      images.push({ path: p, url: img ? URL.createObjectURL(f) : '', name: (f && f.name) || p.split('/').pop(), isImage: img });
    });
    renderAttach();
  } catch { toast('upload failed'); }
}
function renderAttach() {
  const row = $('attachRow'); row.innerHTML = ''; row.classList.toggle('hidden', !images.length);
  images.forEach((im, i) => {
    const t = document.createElement('div');
    if (im.isImage) {
      t.className = 'thumb';
      t.innerHTML = `<img src="${im.url}"><div class="x">✕</div>`;
      t.querySelector('img').onclick = () => { const imgs = images.filter((x) => x.isImage); window.openImageLightbox(imgs.map((x) => x.url), imgs.indexOf(im)); };
    } else {
      t.className = 'thumb fileThumb';
      const ext = ((im.name || '').split('.').pop() || '').toUpperCase();
      t.innerHTML = `<span class="fileThumbIcon">${ICONS.file}</span><span class="fileThumbName">${esc(im.name || 'file')}</span><span class="fileThumbExt">${esc(ext.slice(0, 4)) || 'FILE'}</span><div class="x">✕</div>`;
    }
    t.querySelector('.x').onclick = () => { images.splice(i, 1); renderAttach(); };
    row.appendChild(t);
  });
  updateSend();
}

/* ---------- @ files and / commands ---------- */
let suggestOpen = false;
function hideSuggest() { suggestOpen = false; $('suggest').classList.add('hidden'); }
function curToken() {
  const t = $('input'); const pos = t.selectionStart; const upto = t.value.slice(0, pos);
  const m = upto.match(/(^|\s)([@/][^\s]*)$/);
  return m ? { trigger: m[2][0], frag: m[2].slice(1), start: pos - m[2].length, end: pos } : null;
}
async function onType() {
  const tok = curToken();
  if (!tok) return hideSuggest();
  if (tok.trigger === '/') return showCommands(tok);
  if (tok.trigger === '@') return showFiles(tok);
}
// Built-in CLI slash commands, shown for the ACTIVE agent. Agent-specific skills
// and custom commands are loaded from /api/commands?agent=...
const BUILTIN_CMDS = {
  claude: [
    { name: 'login', desc: 'Add / switch Claude accounts (pool & failover)', action: 'accounts' },
    { name: 'accounts', desc: 'Manage Claude accounts on the box', action: 'accounts' },
    { name: 'switch', desc: 'Move THIS chat to another Claude account', action: 'switch-account' },
    { name: 'theme', desc: 'Switch Box light/dark appearance', action: 'theme' },
    { name: 'model', desc: 'Switch the Claude model', action: 'model' },
    { name: 'compact', desc: 'Summarize & compact the conversation', send: true },
    { name: 'clear', desc: 'Clear conversation history', send: true },
    { name: 'context', desc: 'Show context / token usage', send: true },
    { name: 'review', desc: 'Review the current diff', action: 'review' },
  ],
  codex: [
    { name: 'theme', desc: 'Switch Box light/dark appearance', action: 'theme' },
    { name: 'model', desc: 'Switch the Codex model / reasoning effort', action: 'model' },
    { name: 'permissions', desc: 'Change approval & sandbox mode', action: 'approvals' },
    { name: 'approvals', desc: 'Change approval & sandbox mode', action: 'approvals' },
    { name: 'status', desc: 'Show current Box/Codex thread state', action: 'status' },
    { name: 'compact', desc: 'Summarize & compact the thread', send: true },
    { name: 'fork', desc: 'Branch this thread into a child with parent context', action: 'fork' },
    { name: 'new', desc: 'Start a fresh Codex thread', action: 'new' },
    { name: 'diff', desc: 'Show the working-tree diff', send: true },
    { name: 'review', desc: 'Review the current working-tree diff', action: 'review' },
  ],
  gemini: [
    { name: 'theme', desc: 'Switch Box light/dark appearance', action: 'theme' },
    { name: 'model', desc: 'Switch the Gemini model', action: 'model' },
    { name: 'compact', desc: 'Summarize & compact the conversation', send: true },
    { name: 'clear', desc: 'Clear conversation history', send: true },
    { name: 'context', desc: 'Show context / token usage', send: true },
    { name: 'review', desc: 'Review the current diff', send: true },
    { name: 'new', desc: 'Start a fresh Gemini thread', action: 'new' },
  ],
  agy: [
    { name: 'theme', desc: 'Switch Box light/dark appearance', action: 'theme' },
    { name: 'model', desc: 'Switch the Antigravity model', action: 'model' },
    { name: 'compact', desc: 'Summarize & compact the conversation', send: true },
    { name: 'clear', desc: 'Clear conversation history', send: true },
    { name: 'context', desc: 'Show context / token usage', send: true },
    { name: 'review', desc: 'Review the current diff', send: true },
    { name: 'new', desc: 'Start a fresh Antigravity thread', action: 'new' },
  ],
};
async function showCommands(tok) {
  const agent = agentType(cur.agent);
  let list = (BUILTIN_CMDS[agent] || []).map((c) => ({ ...c, kind: 'builtin' }));
  if (!commandsCache[agent]) commandsCache[agent] = (await (await api('/api/commands?agent=' + agent)).json()).commands;
  list = list.concat(commandsCache[agent]);
  const items = list.filter((c) => c.name.toLowerCase().startsWith(tok.frag.toLowerCase())).slice(0, 80)
    .map((c) => ({ ic: c.kind === 'builtin' ? '⚙' : '', nm: '/' + c.name, ds: c.desc || '', fn: () => runSlashCommand(c, tok) }));
  renderSuggest(items);
}
async function showFiles(tok) {
  const slash = tok.frag.lastIndexOf('/');
  const dir = slash >= 0 ? tok.frag.slice(0, slash + 1) : '';
  const partial = slash >= 0 ? tok.frag.slice(slash + 1) : tok.frag;
  const base = dir.startsWith('/') ? dir : (cur.cwd + '/' + dir);
  let d; try { d = await (await api('/api/fs?path=' + encodeURIComponent(base))).json(); } catch { return hideSuggest(); }
  if (d.type !== 'dir') return hideSuggest();
  const items = d.entries.filter((e) => e.name.toLowerCase().startsWith(partial.toLowerCase())).slice(0, 40).map((e) => ({
    ic: e.dir ? '📁' : '📄', nm: e.name, ds: '', file: true,
    fn: () => { const full = '@' + dir + e.name + (e.dir ? '/' : ' '); insertToken(full, tok); if (e.dir) setTimeout(onType, 30); },
  }));
  renderSuggest(items);
}
function messageText(m) {
  return (m.parts || []).map((p) => {
    if (p.t === 'text') return p.text || '';
    if (p.t === 'tool') return `[tool ${p.name || 'unknown'} ${summarize(p.name, p.input || {})}]`;
    return '';
  }).filter(Boolean).join('\n').trim();
}
function compactTranscript(messages, maxChars = 14000, maxMsgs = 28) {
  const rows = [];
  for (const m of (messages || []).slice(-maxMsgs)) {
    let text = messageText(m).replace(/\s+\n/g, '\n').trim();
    if (!text) continue;
    if (text.length > 1800) text = text.slice(0, 900) + '\n[...trimmed...]\n' + text.slice(-700);
    rows.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}:\n${text}`);
  }
  let out = rows.join('\n\n---\n\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}
function buildForkPrompt(parent, messages) {
  const transcript = compactTranscript(messages);
  return `You are a forked child Codex thread created in the Box mobile app.

Parent thread: ${parent.title}
Parent id: ${parent.id}
Workspace: ${parent.cwd}

Use the transcript below as prior context for this child branch. Treat this as a separate branch: do not assume future parent-thread messages are visible here, and do not write back to the parent. Do not run commands or edit files in this seed turn.

Parent transcript:
${transcript || '(No parent transcript was available.)'}

For this seed turn, briefly acknowledge that the fork is ready and mention the parent thread title. Wait for the next user instruction.`;
}
function buildSwitchPrompt(source, targetAgent, messages) {
  // Carry the prior conversation at high fidelity (last ~60 turns, ~40k chars) so the
  // hand-off feels like the SAME session continuing — not a fresh chat with a summary.
  const transcript = compactTranscript(messages, 40000, 60);
  const sourceAgent = agentLabel(agentType(source.agent));
  const target = agentLabel(agentType(targetAgent));
  return `You are continuing a Box mobile conversation in ${target} after switching from ${sourceAgent}.

Source thread: ${source.title}
Source id: ${source.id}
Workspace: ${source.cwd}

Use the transcript below as prior context. Continue as the same working conversation, but do not assume future messages in the source thread are visible here unless they are pasted later.

Source transcript:
${transcript || '(No source transcript was available.)'}

For this first turn, briefly acknowledge that ${target} has the prior context and is ready to continue. Do not run commands or edit files until the next user instruction.`;
}
async function continueWithAgent(targetAgent) {
  targetAgent = agentType(targetAgent);
  if (!agentEnabled(targetAgent) && targetAgent !== cur.agent) return toast(`${AGENT_LABEL[targetAgent]} is not configured`);
  if (running) return toast('Wait for the current turn to finish before switching');
  if (!cur.id) { setAgent(targetAgent); return toast(`${AGENT_LABEL[targetAgent]} selected`); }
  if (targetAgent === cur.agent) return openModelSheet();
  let h;
  try { h = await (await api(`/api/sessions/${cur.id}/history`)).json(); }
  catch { return toast('Could not load current transcript'); }
  const source = {
    id: cur.id,
    title: cur.title || 'Box chat',
    cwd: h.cwd || cur.cwd || defaultCwd,
    agent: agentType(cur.agent),
  };
  // Don't stack "Codex: Claude: …" titles across repeated switches.
  const baseTitle = source.title.replace(/^(Claude|Codex|Gemini|Antigravity):\s*/, '');
  const title = `${AGENT_LABEL[targetAgent]}: ${baseTitle}`.slice(0, 80);
  const messages = h.messages || [];
  const prompt = buildSwitchPrompt(source, targetAgent, messages);
  // carry = the prior transcript, rendered into the new chat so it reads as ONE continuous
  // conversation; the target agent also gets it as context via the seed prompt.
  await openChat({ id: null, title, cwd: source.cwd, agent: targetAgent, settings: normalizeSettings(h.settings || cur.settings), parentId: source.id, parentTitle: source.title, carry: messages, carryFrom: AGENT_LABEL[source.agent] });
  cur.firstUser = `Continued from ${source.title}`;
  enqueueText(prompt, { parentId: source.id, parentTitle: source.title, title, displayText: `↪ Continued in ${AGENT_LABEL[targetAgent]} — full prior context carried over` });
  toast(`Continuing in ${AGENT_LABEL[targetAgent]}`);
}
async function forkCurrent() {
  if (cur.agent !== 'codex') return toast('/fork is Codex-only in Box right now');
  if (running) return toast('Wait for the current turn to finish before forking');
  if (!cur.id) return toast('Send at least one message before forking');
  let h;
  try { h = await (await api(`/api/sessions/${cur.id}/history`)).json(); }
  catch { return toast('Could not load parent history'); }
  const parent = { id: cur.id, title: cur.title || 'Parent chat', cwd: h.cwd || cur.cwd || defaultCwd, settings: normalizeSettings(h.settings || cur.settings) };
  const childTitle = (`Fork: ${parent.title}`).slice(0, 80);
  const prompt = buildForkPrompt(parent, h.messages || []);
  await openChat({ id: null, title: childTitle, cwd: parent.cwd, agent: 'codex', settings: parent.settings, parentId: parent.id, parentTitle: parent.title });
  cur.firstUser = `Forked from ${parent.title}`;
  enqueueText(prompt, { parentId: parent.id, parentTitle: parent.title, title: childTitle, displayText: `Forked from ${parent.title}` });
  toast('Fork created');
}
function openStatusSheet() {
  cur.settings = normalizeSettings(cur.settings);
  const agent = agentType(cur.agent);
  const cfg = cur.settings[agent];
  const cx = currentContext();
  const rows = [
    { ic: '', label: 'Thread', desc: cur.id || 'New unsaved chat', fn: () => {} },
    { ic: '', label: 'Agent', desc: agentLabel(agent), fn: () => {} },
    { ic: '', label: 'State', desc: running ? 'Running' : 'Idle', fn: () => {} },
    { ic: '', label: 'Context', desc: `${cx.percent}% · ${fmtTokens(cx.usedTokens)} / ${fmtTokens(cx.windowTokens)}${cx.source !== 'reported' ? ' est' : ''}`, fn: () => {} },
    { ic: '', label: 'Workspace', desc: shortCwd(cur.cwd || defaultCwd), fn: () => {} },
  ];
  if (cur.parentId) rows.push({ ic: '', label: 'Parent', desc: `${cur.parentTitle || 'Parent chat'} (${cur.parentId.slice(0, 8)})`, fn: () => {} });
  if (agent === 'codex') rows.push({ ic: '', label: 'Model', desc: `${cfg.model || 'default'} / ${cfg.reasoningEffort || 'default'}`, fn: () => {} });
  else if (agent === 'gemini') rows.push({ ic: '', label: 'Model', desc: `${cfg.model || 'default'}`, fn: () => {} });
  else if (agent === 'agy') rows.push({ ic: '', label: 'Model', desc: `${cfg.model || 'Antigravity default'}`, fn: () => {} });
  else rows.push({ ic: '', label: 'Model', desc: `${cfg.model || 'default'} / ${cfg.effort || 'default'}`, fn: () => {} });
  if (cur.id) rows.push({
    ic: cur.agent === 'codex' ? '⌘' : '◆',
    label: `Continue in ${cur.agent === 'codex' ? 'Claude' : 'Codex'}`,
    desc: 'Translate this transcript into a linked new session',
    fn: () => continueWithAgent(cur.agent === 'codex' ? 'claude' : 'codex'),
  });
  if (cur.id && cur.agent !== 'codex') rows.push({ ic: '', label: 'Switch account', desc: 'move this chat to another Claude account', fn: () => openAccountSwitch() });
  openSheet('Status', rows);
}
function reviewCurrent() {
  if (cur.agent !== 'codex') return toast('/review is Codex-only in Box right now');
  enqueueText('Review the current working tree. Prioritize bugs, behavioral regressions, security risks, and missing tests. Lead with findings ordered by severity and include file/line references where possible.', { displayText: '/review' });
}
function insertToken(text, tok) {
  const t = $('input'); t.value = t.value.slice(0, tok.start) + text + t.value.slice(tok.end);
  const np = tok.start + text.length; t.setSelectionRange(np, np); t.focus(); autoGrow();
  if (!text.endsWith('/')) hideSuggest();
}
function removeToken(tok) {
  const t = $('input');
  t.value = (t.value.slice(0, tok.start) + t.value.slice(tok.end)).replace(/[ \t]+$/g, '');
  const np = Math.min(tok.start, t.value.length);
  t.setSelectionRange(np, np); t.focus(); autoGrow(); updateSend(); hideSuggest();
}
function runSlashCommand(cmd, tok) {
  removeToken(tok);
  $('input').blur();
  if (cmd.action === 'accounts') return openAccounts();
  if (cmd.action === 'switch-account') return openAccountSwitch();
  if (cmd.action === 'model') return openModelSheet();
  if (cmd.action === 'theme') return toggleTheme();
  if (cmd.action === 'approvals') return openApprovalsSheet();
  if (cmd.action === 'status') return openStatusSheet();
  if (cmd.action === 'fork') return forkCurrent();
  if (cmd.action === 'new') return openChat({ id: null, title: `New ${agentLabel(cur.agent)} chat`, cwd: cur.cwd || defaultCwd, agent: cur.agent, settings: cur.settings });
  if (cmd.action === 'review' && (cur.agent === 'gemini' || cur.agent === 'agy')) return enqueueText('Review the current working tree. Prioritize bugs, behavioral regressions, security risks, and missing tests. Lead with findings ordered by severity and include file/line references where possible.');
  if (cmd.action === 'review') return reviewCurrent();
  if (cmd.kind === 'skill' && (cur.agent === 'codex' || cur.agent === 'gemini' || cur.agent === 'agy')) return enqueueText(`Use the ${cmd.name} skill.`);
  enqueueText('/' + cmd.name);
}
function renderSuggest(items) {
  const s = $('suggest'); s.innerHTML = '';
  if (!items.length) return hideSuggest();
  for (const it of items) { const el = document.createElement('div'); el.className = 'si' + (it.file ? ' file' : ''); el.innerHTML = `${it.ic ? `<span class="ic">${it.ic}</span>` : ''}<div class="t"><div class="nm"></div><div class="ds"></div></div>`; el.querySelector('.nm').textContent = it.nm; el.querySelector('.ds').textContent = it.ds || ''; el.onclick = it.fn; s.appendChild(el); }
  s.classList.remove('hidden'); suggestOpen = true;
}

const CODEX_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5', desc: 'Strongest coding model' },
  { id: 'gpt-5.4', label: 'GPT-5.4', desc: 'Balanced frontier model' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', desc: 'Faster everyday work' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', desc: 'Previous Codex model' },
  { id: 'gpt-5.2', label: 'GPT-5.2', desc: 'Older fallback' },
];
const GEMINI_MODELS = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', desc: 'Fast and low cost' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', desc: 'Stronger reasoning' },
];
const AGY_MODELS = [
  { id: '', label: 'Antigravity default', desc: 'Use the signed-in agy default model' },
  { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash Low', desc: 'Fastest Gemini route through agy' },
  { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash Medium', desc: 'Balanced Gemini route through agy' },
  { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash High', desc: 'Deeper Gemini route through agy' },
  { id: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro Low', desc: 'Faster Pro route through agy' },
  { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro High', desc: 'Stronger Pro route through agy' },
];
const CODEX_EFFORTS = [
  { id: 'low', label: 'Low', desc: 'Fastest' },
  { id: 'medium', label: 'Medium', desc: 'Balanced' },
  { id: 'high', label: 'High', desc: 'Deeper reasoning' },
  { id: 'xhigh', label: 'XHigh', desc: 'Maximum depth' },
];
const CLAUDE_MODELS = [
  { id: 'opus', label: 'Opus 4.8', desc: 'Default — 1M context, most capable' },
  { id: 'sonnet', label: 'Sonnet', desc: 'Faster, lower cost' },
  { id: 'fable', label: 'Fable', desc: 'Latest Claude alias' },
];
const CLAUDE_EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
  { id: 'max', label: 'Max' },
];
function settingRow(item, selected, fn) {
  return { ic: selected ? '✓' : '', label: item.label, desc: item.desc || item.id, sel: selected, fn };
}
function openModelSheet() {
  cur.settings = normalizeSettings(cur.settings);
  const agent = agentType(cur.agent);
  const cfg = cur.settings[agent];
  const rows = [];
  if (agent === 'codex') {
    rows.push({ ic: '', label: 'Model', desc: 'Applies to the next Codex turn in this Box chat', fn: () => openModelSheet() });
    for (const m of CODEX_MODELS) rows.push(settingRow(m, cfg.model === m.id, () => { cur.settings.codex.model = m.id; sendSettings(); toast(`Codex model: ${m.label}`); openModelSheet(); }));
    rows.push({ ic: '', label: 'Reasoning effort', desc: 'Higher is slower but more thorough', fn: () => openModelSheet() });
    for (const e of CODEX_EFFORTS) rows.push(settingRow(e, cfg.reasoningEffort === e.id, () => { cur.settings.codex.reasoningEffort = e.id; sendSettings(); toast(`Codex effort: ${e.label}`); openModelSheet(); }));
    return openSheet('Codex model', rows);
  }
  if (agent === 'gemini') {
    rows.push({ ic: '', label: 'Model', desc: 'Used on the next Gemini turn in this Box chat', fn: () => openModelSheet() });
    for (const m of GEMINI_MODELS) rows.push(settingRow(m, cfg.model === m.id, () => { cur.settings.gemini.model = m.id; sendSettings(); toast(`Gemini model: ${m.label}`); openModelSheet(); }));
    openSheet('Gemini model', rows);
    return;
  }
  if (agent === 'agy') {
    rows.push({ ic: '', label: 'Model', desc: 'Passed to agy --model on the next turn', fn: () => openModelSheet() });
    for (const m of AGY_MODELS) rows.push(settingRow(m, (cfg.model || '') === m.id, () => { cur.settings.agy.model = m.id; sendSettings(); toast(`Antigravity model: ${m.label}`); openModelSheet(); }));
    openSheet('Antigravity model', rows);
    return;
  }
  rows.push({ ic: '', label: 'Model', desc: 'Used when Box starts or reopens the Claude bridge', fn: () => openModelSheet() });
  for (const m of CLAUDE_MODELS) rows.push(settingRow(m, cfg.model === m.id, () => { cur.settings.claude.model = m.id; sendSettings(); toast(`Claude model: ${m.label}`); openModelSheet(); }));
  rows.push({ ic: '', label: 'Effort', desc: 'Used when Box starts or reopens the Claude bridge', fn: () => openModelSheet() });
  for (const e of CLAUDE_EFFORTS) rows.push(settingRow(e, cfg.effort === e.id, () => { cur.settings.claude.effort = e.id; sendSettings(); toast(`Claude effort: ${e.label}`); openModelSheet(); }));
  openSheet('Claude model', rows);
}
function openApprovalsSheet() {
  openSheet('Codex approvals', [
    { ic: '✓', label: 'Box YOLO', desc: 'danger-full-access, never ask; current Box default', fn: () => toast('Box YOLO already active') },
  ]);
}

/* ---------- rename ---------- */
// Rename any chat (from the in-chat header button OR the swipe Edit button) without
// having to open it. Updates the open-chat header too if it's the same session.
function renameChat(s, onDone) {
  const cleanCur = (s.title && !isPlaceholderChatTitle(s.title)) ? s.title : '';
  const inner = $('sheetInner'); inner.innerHTML = '<h3>Rename chat</h3>';
  const inp = document.createElement('input'); inp.className = 'sheetInput'; inp.value = cleanCur; inp.placeholder = 'Chat name';
  inner.appendChild(inp);
  const row = document.createElement('div'); row.className = 'sheetRow sel'; row.innerHTML = '<span class="ic">✓</span>Save';
  row.onclick = async () => {
    const name = inp.value.trim();
    if (name) {
      s.title = name;
      if (cur && s.id && s.id === cur.id) { cur.title = name; $('chatTitle').textContent = name; }
      if (s.id) { try { await api(`/api/sessions/${s.id}/rename`, { method: 'POST', body: JSON.stringify({ name }) }); } catch {} }
    }
    closeSheet();
    if (onDone) onDone(name);
  };
  inner.appendChild(row); showSheet();
  // Focus synchronously, still inside the tap gesture — iOS only raises the soft keyboard for a
  // user-initiated focus(). A setTimeout breaks that gesture chain, so the keyboard stays down and
  // you have to tap the field again. The sheet un-hides instantly (no transition), so it's focusable now.
  inp.focus(); inp.select();
}
$('renameBtn').onclick = () => renameChat(cur);

/* ---------- file explorer + reader ---------- */
let expPath = '';
const parentOf = (p) => p.replace(/\/[^/]+\/?$/, '') || '/';
$('filesBtn').onclick = () => { $('explorer').classList.remove('hidden'); paintIcons($('explorer')); browseExp(cur.cwd || defaultCwd); };

/* ---- my messages overlay ---- */
function closeMyMsgs() { $('myMsgsOverlay').classList.add('hidden'); }
$('myMsgsClose').onclick = closeMyMsgs;
$('myMsgsDownload').onclick = async () => {
  if (!cur.id) return toast('No session yet');
  toast('Preparing download…');
  try {
    const r = await fetch(`/api/sessions/${cur.id}/export?token=${encodeURIComponent(TOKEN)}`);
    if (!r.ok) { toast('Export failed'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${(cur.title || 'conversation').replace(/[^a-z0-9]/gi, '-').slice(0, 50)}.md`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch { toast('Download failed'); }
};
$('myMsgsBtn').onclick = async () => {
  if (!cur.id) return toast('No session yet');
  const overlay = $('myMsgsOverlay'), list = $('myMsgsList');
  overlay.classList.remove('hidden'); paintIcons(overlay);
  list.innerHTML = '<div class="histLoader">Loading…</div>';
  let msgs;
  try { msgs = (await (await api(`/api/sessions/${cur.id}/user-messages`)).json()).messages; }
  catch { list.innerHTML = '<div class="histLoader">Failed to load</div>'; return; }
  list.innerHTML = '';
  if (!msgs || !msgs.length) { list.innerHTML = '<div class="histLoader">No messages found</div>'; return; }
  // msgs is [{text, ts}] — normalise in case server returns plain strings (old format)
  msgs = msgs.map((m) => typeof m === 'string' ? { text: m, ts: null } : m);
  $('myMsgsCopyAll').onclick = () => {
    navigator.clipboard.writeText(msgs.map((m) => m.text).join('\n\n---\n\n')).then(() => toast(`Copied ${msgs.length} messages`)).catch(() => {});
  };
  const total = msgs.length;
  msgs.forEach(({ text, ts }, i) => {
    const card = document.createElement('div'); card.className = 'myMsgCard';
    const left = document.createElement('div'); left.className = 'myMsgLeft';
    const topRow = document.createElement('div'); topRow.className = 'myMsgTopRow';
    const num = document.createElement('span'); num.className = 'myMsgNum'; num.textContent = `#${i + 1}`;
    topRow.appendChild(num);
    if (ts) { const tsel = document.createElement('span'); tsel.className = 'myMsgTs'; tsel.textContent = fmtTs(ts); topRow.appendChild(tsel); }
    const body = document.createElement('div'); body.className = 'myMsgBody'; body.textContent = text;
    left.appendChild(topRow); left.appendChild(body);
    // expand toggle for long messages
    const isLong = text.length > 280 || text.split('\n').length > 5;
    if (isLong) {
      let open = false;
      const exp = document.createElement('button'); exp.className = 'myMsgExpand'; exp.textContent = 'Show more';
      exp.onclick = (e) => { e.stopPropagation(); open = !open; body.classList.toggle('expanded', open); exp.textContent = open ? 'Show less' : 'Show more'; };
      left.appendChild(exp);
    }
    const cp = document.createElement('button'); cp.className = 'iconbtn ghost'; cp.title = 'copy'; cp.innerHTML = ICONS.copy;
    cp.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(text).then(() => toast('Copied!')).catch(() => {}); };
    card.appendChild(left); card.appendChild(cp);
    // tap card → find that exact message in the chat and scroll to it. Match by the
    // message TIMESTAMP (a unique, stable key present on both the API and the rendered
    // history) — never by list position, which silently diverges when the chat DOM and
    // the user-messages API filter user messages differently (e.g. image-only messages),
    // making every click land on the wrong/same message.
    const flash = (el) => { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('msgFlash'); setTimeout(() => el.classList.remove('msgFlash'), 1800); };
    const findInDom = () => {
      const domMsgs = [...$('messages').querySelectorAll('.msg.user')];
      return (ts && domMsgs.find((el) => el.dataset.ts === String(ts))) || domMsgs.find((el) => el.dataset.rawText === text) || null;
    };
    card.addEventListener('click', (e) => {
      if (e.target.closest('.iconbtn') || e.target.closest('.myMsgExpand')) return;
      const target = findInDom();
      if (target) { closeMyMsgs(); flash(target); return; }
      if (cur.hasMoreHistory) {
        closeMyMsgs();
        // silently page backwards until the message appears, then scroll to it
        toast('Finding message…', 1200);
        const tryFind = async () => {
          if (!cur.hasMoreHistory) { toast('Not found — tap ↓ in My messages to download the full conversation', 3000); return; }
          await loadEarlierMessages();
          const found = findInDom();
          if (found) flash(found); else setTimeout(tryFind, 120);
        };
        tryFind();
      } else {
        toast('Not found — tap ↓ in My messages to download the full conversation', 3000);
      }
    });
    list.appendChild(card);
  });
};

/* ---- /clear + "needs attention" page ----
   A dedicated page that takes the messages area's place, so the REAL composer below (with its
   voice button) handles the reply. Back returns to the chat. Items are shown as clean cards. */
// Paint bell icon (attnBtn has a badge child, so we use insertAdjacentHTML not data-icon/paintIcons)
$('attnBtn').insertAdjacentHTML('afterbegin', ICONS.bell);
function updateArchiveButton() {
  const b = $('archiveBtn'); if (!b) return;
  const isArchived = !!(cur && cur.archived);
  b.dataset.icon = isArchived ? 'unarchive' : 'archive';
  b.title = isArchived ? 'Unarchive this conversation' : 'Archive this conversation';
  b.setAttribute('aria-label', b.title);
  b._painted = 0; b.innerHTML = ''; paintIcons(b.parentElement || document);
}
function openArchiveConfirm(s, opts = {}) {
  const inner = $('sheetInner');
  inner.innerHTML = '<h3>Archive chat?</h3><p class="sheetText">This moves the chat to Archived and stops its running Claude bridge so it no longer consumes box resources. You can unarchive it later from Archived or from this chat.</p>';
  const rows = [
    { ic: '🗄', label: 'Archive', desc: 'Stop the bridge and move it out of active chats', fn: async () => {
      const j = await doArchive(s, true);
      if (j && opts.leaveChat) { if (ws) ws.close(); openSessions(); }
    } },
    { ic: '✕', label: 'Cancel', fn: () => {} },
  ];
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'sheetRow' + (r.label === 'Archive' ? ' danger' : '');
    el.innerHTML = `<span class="ic">${r.ic || ''}</span><div><div>${esc(r.label)}</div>${r.desc ? `<div class="muted" style="font-size:12.5px">${esc(r.desc)}</div>` : ''}</div>`;
    el.onclick = () => { closeSheet(); r.fn(); };
    inner.appendChild(el);
  }
  showSheet();
}
$('archiveBtn').onclick = async () => {
  if (!cur.id) return toast('Nothing to archive yet');
  const s = { id: cur.id, title: cur.title, archived: !!cur.archived };
  if (s.archived) { await doArchive(s, false); return; }
  openArchiveConfirm(s, { leaveChat: true });
};
$('attnBtn').onclick = () => {
  attnLinear = !!(((CFG && CFG.features) || {}).linear);
  navTo({ view: 'chatAttn', id: cur.id, title: cur.title, agent: cur.agent, key: cur.key });
  showAttention();
};
$('copyChatBtn').onclick = () => {
  const TURNS = 10;
  const msgs = [...$('messages').querySelectorAll('.msg.user, .msg.assistant')];
  const last = msgs.slice(-(TURNS * 2));
  const lines = last.map((m) => {
    const role = m.classList.contains('user') ? 'You' : 'Claude';
    // Only use rawText — never fall back to innerText (which includes tool chip DOM garbage).
    // Skip tool-only turns where there's no text content.
    const text = (m.dataset.rawText || '').trim();
    return text ? `${role}: ${text}` : null;
  }).filter(Boolean);
  if (!lines.length) { toast('No messages yet'); return; }
  navigator.clipboard.writeText(lines.join('\n\n')).then(() => toast(`Copied ${lines.length} messages`)).catch(() => {});
};
$('attnTabStatus').onclick = () => { attnLinear = false; showAttention(); };
$('attnTabLinear') && ($('attnTabLinear').onclick = () => { attnLinear = true; showAttention(); });
$('attnList').addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('.attnDismiss'); if (b) { e.preventDefault(); e.stopPropagation(); dismissAttn(b.dataset.key, b.dataset.title, b.dataset.identifier); } });
function closeAttention() {
  attnMode = false;
  $('attnPanel').classList.add('hidden'); $('messages').classList.remove('hidden');
  $('composer').classList.remove('attn-mode');
  $('attnComposeHint').classList.add('hidden');
  $('input').placeholder = cur.mode === 'bash' ? 'Run a command on the box…' : 'Message…';
  refreshButton();
}
// Render one global inbox card (one needs-me Linear issue).
function attnCard(it) {
  const color = it.status === '🔴' ? '#e0533a' : it.status === '🟡' ? '#e0a23a' : it.status === '🟢' ? '#3aa55e' : '#9aa';
  const need = it.status === '🔴';
  const parts = [];
  parts.push(`<div class="attnTitle"><span class="attnDot" style="background:${color}"></span>${esc(it.title)}${it.date ? `<span class="attnDate">${esc(it.date)}</span>` : ''}</div>`);
  if (it.what) parts.push(`<div class="attnWhat">${esc(it.what)}</div>`);
  if (it.decision) parts.push(`<div class="attnDecision"><span class="attnLabel">${need ? 'Needs your call' : 'Decision'}</span>${esc(it.decision)}</div>`);
  if (it.rec) parts.push(`<div class="attnRec"><span class="attnLabel">My rec</span>${esc(it.rec)}</div>`);
  if (!it.decision && it.plan) parts.push(`<div class="attnRec"><span class="attnLabel">Plan</span>${esc(it.plan)}</div>`);
  if (it.statusLine) parts.push(`<div class="attnStatusLine">${esc(it.statusLine)}</div>`);
  if (it.open) parts.push(`<div class="attnActions"><button class="attnDismiss" data-key="${esc(attnKey(it))}" data-title="${esc(it.title)}" data-identifier="${esc(it.identifier || '')}">Resolve</button></div>`);
  return `<div class="attnItem${need ? ' need' : ''}">${parts.join('')}</div>`;
}
const attnKey = (it) => `${it.date || ''}|${it.title || ''}`;
const attnDismissedSet = () => { try { return new Set(JSON.parse(LS.getItem('attn_dismissed') || '[]')); } catch { return new Set(); } };
function attnSection(markdown, heading) {
  const m = String(markdown || '').match(new RegExp(`(^##\\s*${heading}[\\s\\S]*?)(?=^##\\s|\\s*$)`, 'im'));
  return m ? m[1].trim() : '';
}
function attnSectionBody(section) {
  return String(section || '').replace(/^##[^\n]*\n?/i, '').trim();
}
function hasUsefulAttnSection(section) {
  const body = attnSectionBody(section)
    .replace(/\*\*/g, '')
    .replace(/[_`]/g, '')
    .trim()
    .toLowerCase();
  if (!body) return false;
  return !/^\(?\s*(none|n\/a|nothing|no blockers?|all clear)\s*\)?[.!]*$/.test(body);
}
function buildBriefMarkdown(markdown) {
  const needs = attnSection(markdown, 'needs your input');
  const inProgress = attnSection(markdown, 'in progress');
  const done = attnSection(markdown, 'done recently');
  const parts = [];
  if (hasUsefulAttnSection(needs)) parts.push(needs);
  if (hasUsefulAttnSection(inProgress)) parts.push(inProgress);
  if (hasUsefulAttnSection(done)) parts.push(done);
  return { markdown: parts.join('\n\n').trim(), hasNeeds: hasUsefulAttnSection(needs) };
}
// Items are Linear issues (label needs-me). Dismiss = actually resolve the issue
// (move it to Done) via the existing /api/linear/:id/done endpoint, so it clears for
// every session — not just hidden locally. Falls back to local-hide if there's no
// identifier (shouldn't happen) or the resolve call fails.
async function dismissAttn(key, title, identifier) {
  if (!confirm(`Resolve "${title}"?\n\nThis closes the Linear issue${identifier ? ` (${identifier})` : ''} for all sessions.`)) return;
  const s = attnDismissedSet(); s.add(key); LS.setItem('attn_dismissed', JSON.stringify([...s]));
  if (identifier) {
    try {
      const r = await api(`/api/linear/${identifier}/done`, { method: 'POST' });
      if (!r.ok) throw new Error('resolve failed');
    } catch { alert(`Couldn't auto-resolve ${identifier} — hidden here; resolve it in Linear.`); }
  }
  showAttention();
}
async function showAttention() {
  // Linear is the default surface because it is the durable work queue. Brief is the
  // per-session status doc, merged into one page instead of split across empty tabs.
  const perSession = cur.id;
  const seg = $('attnSeg');
  if (seg) seg.classList.remove('hidden');
  $('attnTabLinear') && $('attnTabLinear').classList.toggle('active', attnLinear);
  $('attnTabStatus') && $('attnTabStatus').classList.toggle('active', !attnLinear);
  if (attnLinear) {
    await renderSessionLinear(perSession);
  } else if (perSession) {
    $('attnList').innerHTML = '<div class="attnLead">Loading…</div>';
    let markdown = null;
    try { const d = await (await api(`/api/sessions/${cur.id}/attention`)).json(); markdown = d.markdown || null; } catch {}
    if (markdown) {
      const brief = buildBriefMarkdown(markdown);
      const hasNeeds = brief.hasNeeds;
      setAttnBadge(hasNeeds ? 1 : 0);
      if (brief.markdown) {
        const lead = hasNeeds
          ? 'Session brief — blockers first. Reply below to unblock it.'
          : 'Session brief — no blocker detected; recent status is below.';
        $('attnList').innerHTML = `<div class="attnLead">${lead}</div><div class="attnMd">${md(brief.markdown)}</div>`;
      } else {
        $('attnList').innerHTML = '<div class="attnEmpty">Nothing useful in the session brief yet.</div>';
      }
    } else {
      setAttnBadge(0);
      $('attnList').innerHTML = '<div class="attnEmpty">No brief yet — it will appear after a few turns.</div>';
    }
  } else {
    // Global fallback: needs-me Linear inbox with card UI
    let all = [];
    try { const d = await (await api('/api/needs-attention')).json(); all = d.items || []; setAttnBadge((d.items || []).filter((i) => i.open).length); } catch {}
    const dis = attnDismissedSet();
    const items = all.filter((i) => !dis.has(attnKey(i)));
    const lead = `Cross-session queue. Reply below, or resolve a card when it no longer needs you.`;
    $('attnList').innerHTML = items.length
      ? `<div class="attnLead">${lead}</div>` + items.map(attnCard).join('')
      : '<div class="attnEmpty">Nothing tracked yet.</div>';
  }
  $('messages').classList.add('hidden');
  $('attnPanel').classList.remove('hidden');
  attnMode = true;
  $('composer').classList.add('attn-mode');
  $('attnComposeHint').classList.remove('hidden');
  $('input').placeholder = 'Reply to your inbox…';
  refreshButton();
  paintIcons($('attnPanel'));
  try { $('input').focus(); } catch {}
}
// "Linear" tab of the bell — the INC issues THIS session has referenced (most first),
// resolved to title + workflow state. Tap a row to open the in-app issue workspace.
async function renderSessionLinear(perSession) {
  if (!perSession) { await renderLinearQueuePreview(); return; }
  $('attnList').innerHTML = '<div class="attnLead">Loading…</div>';
  let issues = [];
  try { const d = await (await api(`/api/sessions/${perSession}/linear`)).json(); issues = d.issues || []; } catch {}
  if (!issues.length) { await renderLinearQueuePreview('No Linear issue is tied to this session yet. Here is the active queue.'); return; }
  const STYPE = { completed: '#3aa55e', canceled: '#9aa', started: '#e0a23a', unstarted: '#5b8def', backlog: '#9aa', triage: '#e0533a' };
  const rows = issues.map((it) => {
    const stCol = it.state ? (STYPE[it.state.type] || '#9aa') : '#9aa';
    const sub = [it.state && it.state.name, `${it.mentions}× referenced`].filter(Boolean).join(' · ');
    return `<div class="sessRow linRow" data-id="${esc(it.identifier)}"><span class="sessIc">◎</span>`
      + `<div class="sessMain"><div class="sessTitle">${esc(it.identifier)}${it.title ? ' · ' + esc(it.title) : ''}</div>`
      + `<div class="sessSub"><span class="attnDot" style="background:${stCol}"></span>${esc(sub)}</div></div>`
      + `<span class="sessGo">→</span></div>`;
  }).join('');
  $('attnList').innerHTML = `<div class="attnLead">Linear issues this session has worked on — tap to open.</div>${rows}`;
  $('attnList').querySelectorAll('.linRow').forEach((row) => {
    row.onclick = () => {
      // Remember we came from THIS chat so issueBack returns here, not to the board.
      issueOrigin = { kind: 'chat', chat: { id: cur.id, title: cur.title, cwd: cur.cwd, agent: cur.agent, settings: cur.settings } };
      openIssue(row.dataset.id);
    };
  });
}
async function renderLinearQueuePreview(prefix) {
  $('attnList').innerHTML = '<div class="attnLead">Loading…</div>';
  let d = null;
  try { d = await (await api('/api/linear-board')).json(); } catch {}
  const issues = [];
  for (const col of ((d && d.columns) || [])) {
    if (col.recent) continue;
    for (const t of (col.issues || [])) issues.push({ ...t, stateName: col.name, stateType: col.type });
  }
  if (!issues.length) {
    $('attnList').innerHTML = '<div class="attnEmpty">No open Linear issues.</div>';
    return;
  }
  issues.sort((a, b) => (a.stateType === 'started' ? -1 : b.stateType === 'started' ? 1 : 0) || (Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)));
  const rows = issues.slice(0, 12).map((it) => {
    const [plabel, pcolor] = PRIO[it.priority] || [];
    const sub = [it.stateName, plabel, it.assignee && `@${it.assignee}`].filter(Boolean).join(' · ');
    return `<div class="sessRow linRow" data-id="${esc(it.id)}"><span class="sessIc">◎</span>`
      + `<div class="sessMain"><div class="sessTitle">${esc(it.id)} · ${esc(it.title || '(untitled)')}</div>`
      + `<div class="sessSub">${pcolor ? `<span class="attnDot" style="background:${pcolor}"></span>` : ''}${esc(sub)}</div></div>`
      + `<span class="sessGo">→</span></div>`;
  }).join('');
  const lead = prefix || 'Active Linear queue — tap an issue to open it.';
  $('attnList').innerHTML = `<div class="attnLead">${esc(lead)}</div>${rows}`;
  $('attnList').querySelectorAll('.linRow').forEach((row) => {
    row.onclick = () => {
      issueOrigin = cur.id
        ? { kind: 'chat', chat: { id: cur.id, title: cur.title, cwd: cur.cwd, agent: cur.agent, settings: cur.settings } }
        : { kind: 'board' };
      openIssue(row.dataset.id);
    };
  });
}
function setAttnBadge(n) {
  const b = $('attnBadge'); if (!b) return;
  if (n > 0) { b.textContent = n; b.classList.remove('hidden'); } else b.classList.add('hidden');
}
async function refreshAttnBadge() {
  if (cur.id) {
    // Per-session: badge = 1 if ATTENTION.md exists with a non-empty "Needs your input" section
    try {
      const d = await (await api(`/api/sessions/${cur.id}/attention`)).json();
      const hasNeeds = d.markdown && buildBriefMarkdown(d.markdown).hasNeeds;
      setAttnBadge(hasNeeds ? 1 : 0);
    } catch { setAttnBadge(0); }
  } else {
    try { const d = await (await api('/api/needs-attention')).json(); setAttnBadge(d.open || 0); } catch {}
  }
}
// Badge refreshes when you open a chat (session-scoped feel) — not via a global interval.

$('readerBack').onclick = () => $('expClose').click();
$('expClose').onclick = () => {
  if (!$('expReader').classList.contains('hidden')) { $('expReader').classList.add('hidden'); if ($('expList').children.length) $('expList').classList.remove('hidden'); else $('explorer').classList.add('hidden'); }
  else $('explorer').classList.add('hidden');
};
$('expUp').onclick = () => browseExp(parentOf(expPath));
async function browseExp(path) {
  $('expReader').classList.add('hidden'); $('expList').classList.remove('hidden');
  let d; try { d = await (await api('/api/fs?path=' + encodeURIComponent(path))).json(); } catch { return; }
  if (d.error) return toast(d.error);
  if (d.type === 'file') { showMedia(path); return; }
  expPath = d.path; $('expPath').textContent = shortCwd(d.path);
  const list = $('expList'); list.innerHTML = '';
  for (const e of d.entries) {
    const row = document.createElement('div'); row.className = 'row';
    const full = (d.path.endsWith('/') ? d.path : d.path + '/') + e.name;
    row.innerHTML = `<span class="ic">${e.dir ? ICONS.fold : ICONS.file}</span><span class="nm"></span>`;
    row.querySelector('.nm').textContent = e.name;
    if (e.dir) { row.onclick = () => browseExp(full); }
    else {
      row.onclick = () => showMedia(full);
      const at = document.createElement('span'); at.className = 'at'; at.innerHTML = ICONS.at;
      at.onclick = (ev) => { ev.stopPropagation(); insertRef(full); }; row.appendChild(at);
    }
    list.appendChild(row);
  }
}

/* ---------- tool detail + media viewer ---------- */
function codeBlock(text, cls) { const p = document.createElement('pre'); p.className = 'codeblk' + (cls ? ' ' + cls : ''); p.textContent = text == null ? '' : String(text); return p; }
function diffView(oldS, newS) {
  const w = document.createElement('pre'); w.className = 'diff';
  (oldS || '').split('\n').forEach((l) => { const d = document.createElement('div'); d.className = 'del'; d.textContent = '- ' + l; w.appendChild(d); });
  (newS || '').split('\n').forEach((l) => { const d = document.createElement('div'); d.className = 'add'; d.textContent = '+ ' + l; w.appendChild(d); });
  return w;
}
function openFileBtn(path) {
  const b = document.createElement('button'); b.className = 'openfile'; b.innerHTML = `${ICONS.file}<span></span>`;
  b.querySelector('span').textContent = 'Open ' + path.split('/').pop();
  b.onclick = () => { closeSheet(); openFile(path); };
  return b;
}
const isImg = (p) => !!p && MEDIA.img.includes((p.split('.').pop() || '').toLowerCase());
function openToolDetail(name, data) {
  const inner = $('sheetInner'); inner.innerHTML = `<h3>${esc(name)}</h3>`;
  const inp = data.input || {};
  const fp = inp.file_path;
  if (fp && isImg(fp)) {                          // image → render directly in the sheet
    const im = document.createElement('img'); im.className = 'mediaimg detailimg'; im.src = rawUrl(fp); im.style.cursor = 'zoom-in'; im.onclick = () => window.openImageLightbox([rawUrl(fp)], 0); inner.appendChild(im);
    inner.appendChild(openFileBtn(fp));           // still open full / @mention
  } else if (name === 'Edit' && inp.old_string != null) { if (fp) inner.appendChild(openFileBtn(fp)); inner.appendChild(diffView(inp.old_string, inp.new_string)); }
  else if (name === 'Write') { if (fp) inner.appendChild(openFileBtn(fp)); inner.appendChild(codeBlock(inp.content || '')); }
  else if (name === 'Read') { if (fp) inner.appendChild(openFileBtn(fp)); if (data.result) inner.appendChild(codeBlock(data.result, 'out')); }
  else if (name === 'Bash') { inner.appendChild(codeBlock('$ ' + (inp.command || ''))); if (data.result) inner.appendChild(codeBlock(data.result, 'out')); }
  else { inner.appendChild(codeBlock(JSON.stringify(inp, null, 2))); if (data.result) inner.appendChild(codeBlock(data.result, 'out')); }
  showSheet();
}
const MEDIA = { img: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'], audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'], video: ['mp4', 'mov', 'webm', 'm4v', 'mkv'] };
const rawUrl = (p) => '/api/raw?path=' + encodeURIComponent(p) + '&token=' + encodeURIComponent(TOKEN);
function openFile(path) { $('explorer').classList.remove('hidden'); paintIcons($('explorer')); showMedia(path); }
function showMedia(path) {
  $('expList').classList.add('hidden'); $('expReader').classList.remove('hidden'); paintIcons($('expReader'));
  $('readerName').textContent = path.split('/').pop();
  $('readerAt').onclick = () => insertRef(path);
  const ext = (path.split('.').pop() || '').toLowerCase();
  const body = $('readerBody'); body.innerHTML = ''; body.classList.remove('astext');
  if (MEDIA.img.includes(ext)) { const im = document.createElement('img'); im.className = 'mediaimg'; im.src = rawUrl(path); body.appendChild(im); }
  else if (MEDIA.audio.includes(ext)) { const a = document.createElement('audio'); a.controls = true; a.src = rawUrl(path); a.className = 'mediael'; body.appendChild(a); }
  else if (MEDIA.video.includes(ext)) { const v = document.createElement('video'); v.controls = true; v.playsInline = true; v.src = rawUrl(path); v.className = 'mediael'; body.appendChild(v); }
  else {
    body.classList.add('astext'); body.textContent = 'Loading…';
    api('/api/fs?path=' + encodeURIComponent(path)).then((r) => r.json()).then((d) => {
      if (d.error) { body.textContent = d.error; return; }
      if (d.tooBig) { body.textContent = `(too large to preview: ${d.size} bytes)`; return; }
      const content = d.content != null ? d.content : '(binary file)';
      if (['html', 'htm'].includes(ext)) { renderHtmlContent(body, content); }
      else if (['md', 'markdown'].includes(ext)) { body.classList.remove('astext'); body.innerHTML = `<div class="mdview"></div>`; body.firstChild.innerHTML = md(content); }
      else {
        body.classList.remove('astext');
        const lang = EXT_LANG[ext];
        body.innerHTML = `<pre class="hl"><code></code></pre>`;
        const code = body.querySelector('code'); code.textContent = content;
        if (lang) code.className = 'language-' + lang;
        if (window.hljs) { try { window.hljs.highlightElement(code); } catch {} }
      }
    }).catch(() => { body.textContent = '(cannot read)'; });
  }
}
function renderHtmlContent(body, content) {
  body.classList.remove('astext');
  body.innerHTML = `<div class="htmlbar"><button class="htmltab on">Preview</button><button class="htmltab">Source</button></div><div class="htmlhost"></div>`;
  const host = body.querySelector('.htmlhost');
  const tabs = body.querySelectorAll('.htmltab');
  const preview = () => { host.innerHTML = ''; const f = document.createElement('iframe'); f.className = 'htmlframe'; f.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms allow-modals'); f.srcdoc = content; host.appendChild(f); };
  const source = () => { host.innerHTML = '<pre class="hl"><code class="language-xml"></code></pre>'; const c = host.querySelector('code'); c.textContent = content; if (window.hljs) { try { hljs.highlightElement(c); } catch {} } };
  tabs[0].onclick = () => { tabs[0].classList.add('on'); tabs[1].classList.remove('on'); preview(); };
  tabs[1].onclick = () => { tabs[1].classList.add('on'); tabs[0].classList.remove('on'); source(); };
  preview();
}
const EXT_LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', html: 'xml', xml: 'xml', css: 'css', scss: 'scss', sql: 'sql', mjs2: 'javascript', vue: 'xml', dockerfile: 'dockerfile', makefile: 'makefile', diff: 'diff', patch: 'diff' };
function insertRef(path) {
  const t = $('input'); t.value += (t.value && !t.value.endsWith(' ') ? ' ' : '') + '@' + path + ' ';
  autoGrow(); updateSend(); $('explorer').classList.add('hidden'); toast('✓ @' + path.split('/').pop());
}

/* ---------- sheet ---------- */
function openSheet(title, rows) {
  const active = document.activeElement;
  if (active && active.id === 'input') active.blur();
  const inner = $('sheetInner'); inner.innerHTML = title ? `<h3>${esc(title)}</h3>` : '';
  for (const r of rows) { const el = document.createElement('div'); el.className = 'sheetRow' + (r.sel ? ' sel' : ''); el.innerHTML = `<span class="ic">${r.ic || ''}</span><div><div>${esc(r.label)}</div>${r.desc ? `<div class="muted" style="font-size:12.5px">${esc(r.desc)}</div>` : ''}</div>`; el.onclick = () => { closeSheet(); r.fn(); }; inner.appendChild(el); }
  showSheet();
}
let sheetDrag = null;
function setSheetDragOffset(y) {
  const sheet = $('sheet');
  const offset = Math.max(0, y || 0);
  sheet.style.setProperty('--sheet-y', offset + 'px');
  sheet.style.setProperty('--sheet-dim', Math.max(.12, .35 * (1 - Math.min(offset, 360) / 420)).toFixed(3));
}
function resetSheetDrag() {
  const sheet = $('sheet');
  sheet.classList.remove('dragging');
  setSheetDragOffset(0);
  sheetDrag = null;
}
function showSheet() {
  resetSheetDrag();
  const inner = $('sheetInner');
  if (inner) inner.scrollTop = 0;
  $('sheet').classList.remove('hidden');
}
function closeSheet() { resetSheetDrag(); $('sheet').classList.add('hidden'); }
$('sheet').onclick = (e) => { if (e.target === $('sheet')) closeSheet(); };
function onSheetTouchStart(e) {
  if ($('sheet').classList.contains('hidden') || e.touches.length !== 1) return;
  const inner = $('sheetInner');
  if (!inner || e.target.closest('input, textarea, select, button, a, iframe, audio, video')) return;
  const y = e.touches[0].clientY;
  sheetDrag = { startY: y, lastY: y, startAt: performance.now(), dragging: false, offset: 0 };
}
function onSheetTouchMove(e) {
  if (!sheetDrag || e.touches.length !== 1) return;
  const inner = $('sheetInner');
  if (!inner) return;
  const y = e.touches[0].clientY;
  const dy = y - sheetDrag.startY;
  sheetDrag.lastY = y;
  if (!sheetDrag.dragging) {
    if (dy <= 8 || inner.scrollTop > 0) return;
    sheetDrag.dragging = true;
    $('sheet').classList.add('dragging');
  }
  e.preventDefault();
  const resisted = dy > 320 ? 320 + ((dy - 320) * .25) : dy;
  sheetDrag.offset = Math.max(0, resisted);
  setSheetDragOffset(sheetDrag.offset);
}
function onSheetTouchEnd() {
  if (!sheetDrag) return;
  const inner = $('sheetInner');
  const dt = Math.max(1, performance.now() - sheetDrag.startAt);
  const velocity = (sheetDrag.lastY - sheetDrag.startY) / dt;
  const threshold = Math.min(150, Math.max(88, ((inner && inner.offsetHeight) || 0) * .24));
  const shouldClose = sheetDrag.dragging && (sheetDrag.offset > threshold || (velocity > .65 && sheetDrag.offset > 44));
  if (shouldClose) closeSheet();
  else resetSheetDrag();
}
$('sheetInner').addEventListener('touchstart', onSheetTouchStart, { passive: true });
$('sheetInner').addEventListener('touchmove', onSheetTouchMove, { passive: false });
$('sheetInner').addEventListener('touchend', onSheetTouchEnd);
$('sheetInner').addEventListener('touchcancel', resetSheetDrag);
// Desktop convenience: Escape dismisses the topmost transient surface (bottom sheet
// or the accounts overlay). The image lightbox owns its own Escape; the chat's
// attention overlay closes with Back (it's a history entry), so it's not handled here.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('sheet').classList.contains('hidden')) { e.preventDefault(); closeSheet(); return; }
  if ($('accountsOverlay') && !$('accountsOverlay').classList.contains('hidden')) { e.preventDefault(); closeAccounts(); return; }
});

/* ---------- desktop keyboard shortcuts ---------- */
// Only fire when you're NOT typing in a field and no modal is up. j/k (or ↑/↓) move
// through the session list, Enter opens the highlighted chat, "/" jumps to the chat
// composer, "?" shows the list. No-ops on touch devices (they never emit these keys).
let kbSel = -1;
const kbCards = () => [...$('sessionList').querySelectorAll('.sCard')];
function kbHighlight() {
  const cards = kbCards();
  cards.forEach((c, i) => c.classList.toggle('kbsel', i === kbSel));
  if (cards[kbSel]) cards[kbSel].scrollIntoView({ block: 'nearest' });
}
function kbMove(d) {
  const cards = kbCards(); if (!cards.length) return;
  kbSel = kbSel < 0 ? (d > 0 ? 0 : cards.length - 1) : Math.max(0, Math.min(cards.length - 1, kbSel + d));
  kbHighlight();
}
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if ((t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) || e.metaKey || e.ctrlKey || e.altKey) return;
  // don't hijack keys while a modal/overlay owns the screen
  if (!$('sheet').classList.contains('hidden') || !$('lightbox').classList.contains('hidden') ||
      ($('accountsOverlay') && !$('accountsOverlay').classList.contains('hidden'))) return;
  const onList = !$('sessions').classList.contains('hidden') || (isDesktopShell() && document.body.dataset.view !== 'login');
  const onChat = !$('chat').classList.contains('hidden');
  if (e.key === '/') { if (onChat && !attnMode) { e.preventDefault(); $('input').focus(); } return; }
  if (e.key === '?') { toast('Shortcuts: n new · b board · p pipelines · j/k move · Enter opens · / composer', 3800); return; }
  if (!onList) return;
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); kbMove(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); kbMove(-1); }
  else if (e.key === 'Enter') { const c = kbCards()[kbSel]; if (c) { e.preventDefault(); c.querySelector('.sCardFront').click(); } }
});

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!$('sheet').classList.contains('hidden') || !$('lightbox').classList.contains('hidden')) return;
  if (!TOKEN || document.body.dataset.view === 'login') return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!$('board').classList.contains('hidden')) boardSearchToggle();
    else sessSearchToggle();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    $('newBtn').click();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() === 'n') { e.preventDefault(); $('newBtn').click(); }
  else if (e.key.toLowerCase() === 'b' && CFG.features && CFG.features.linear) { e.preventDefault(); openBoard(); }
  else if (e.key.toLowerCase() === 'p') { e.preventDefault(); openPipelines(); }
  else if (e.key.toLowerCase() === 's') { e.preventDefault(); openSessions(curFilter || 'all'); }
});

/* ---------- Claude accounts (login / pool / failover) ---------- */
function closeAccounts() { $('accountsOverlay').classList.add('hidden'); }
$('accountsClose').onclick = closeAccounts;
$('accountsAdd').onclick = () => renderAddAccount();

async function openAccounts() {
  const ov = $('accountsOverlay'); ov.classList.remove('hidden'); paintIcons(ov);
  await renderAccountsList();
}

function acctBadge(a) {
  if (!a.usable) return '<span class="acctBadge warn">no creds</span>';
  if (a.cooling) {
    const mins = Math.max(0, Math.round((a.until - Date.now() / 1000) / 60));
    return `<span class="acctBadge cool">cooling ${mins < 90 ? mins + 'm' : (mins / 60).toFixed(1) + 'h'}</span>`;
  }
  return '<span class="acctBadge ok">available</span>';
}

// Live usage bar + a deep-link to manage/buy usage (payment is Anthropic-hosted).
function usageHtml(a, manage) {
  const url = a.type === 'apikey' ? manage.console : manage.subscription;
  const link = `<a class="acctUsageLink" target="_blank" rel="noopener" href="${esc(url)}">Manage / buy usage ↗</a>`;
  const u = a.utilization;
  if (a.type === 'apikey') return `<div class="acctUsage"><span class="muted">metered API key</span>${link}</div>`;
  if (!u || u.max == null) return `<div class="acctUsage"><span class="muted">usage: tap ↻ to load</span>${link}</div>`;
  const lvl = u.max >= 92 ? 'hi' : (u.max >= 70 ? 'mid' : 'lo');
  const parts = [];
  if (u.fiveHour != null) parts.push(`5h ${u.fiveHour}%`);
  if (u.sevenDay != null) parts.push(`7d ${u.sevenDay}%`);
  if (u.opus != null) parts.push(`opus ${u.opus}%`);
  const extra = u.extraUsageEnabled ? ' · extra usage on' : '';
  return `<div class="acctUsage">
    <div class="acctBar"><div class="acctBarFill ${lvl}" style="width:${Math.min(100, u.max)}%"></div></div>
    <div class="acctUsageMeta"><span>${parts.join(' · ') || (u.max + '%')}${extra}</span>${link}</div></div>`;
}

async function renderAccountsList() {
  const body = $('accountsBody'); body.innerHTML = '<div class="histLoader">Loading…</div>';
  let data;
  try { data = await (await api('/api/accounts')).json(); }
  catch { body.innerHTML = '<div class="histLoader">Failed to load accounts</div>'; return; }
  body.innerHTML = '';
  body.dataset.consoleKeysUrl = data.consoleKeysUrl || '';
  const manage = data.manageUsage || { subscription: 'https://claude.ai/settings/usage', console: 'https://console.anthropic.com/settings/billing' };
  if (!data.installed) {
    const n = document.createElement('div'); n.className = 'acctNote';
    n.innerHTML = 'Account pooling not activated — it needs an account broker on this box (set <code>CC_BROKER_JS</code>). Single account works fine without it.';
    body.appendChild(n);
  }
  const intro = document.createElement('div'); intro.className = 'acctIntro';
  intro.innerHTML = '<span>New sessions go to whichever account has headroom; one near its limit is skipped before it blocks.</span> <button id="acctRefreshUsage" class="chip small">↻ Usage</button>';
  body.appendChild(intro);
  intro.querySelector('#acctRefreshUsage').onclick = async (e) => {
    const b = e.target; b.disabled = true; b.textContent = '↻ …';
    try { await api('/api/accounts/refresh-usage', { method: 'POST' }); } catch {}
    renderAccountsList();
  };
  for (const a of (data.accounts || [])) {
    const card = document.createElement('div'); card.className = 'acctCard' + (a.primary ? ' primary' : '');
    card.innerHTML = `<div class="acctTop"><div class="acctName">${a.primary ? '★ ' : ''}${esc(a.label || a.id)} <span class="acctType">${a.type === 'apikey' ? 'API key' : 'subscription'}</span></div>${acctBadge(a)}</div>
      <div class="acctMeta">${esc(a.email || a.id)} · <span class="muted">${esc(a.configDir)}</span></div>
      ${usageHtml(a, manage)}
      <div class="acctActions"></div>`;
    const acts = card.querySelector('.acctActions');
    const btn = (label, fn, cls = '') => { const b = document.createElement('button'); b.className = 'chip small ' + cls; b.textContent = label; b.onclick = fn; acts.appendChild(b); };
    if (!a.primary && a.usable) btn('Make primary', () => acctAction('/api/accounts/primary', { id: a.id }, 'Primary set'));
    if (a.cooling) btn('Clear cooldown', () => acctAction('/api/accounts/clear', { id: a.id }, 'Cooldown cleared'));
    else if (a.usable) btn('Rest 90m', () => acctAction('/api/accounts/cooldown', { id: a.id, minutes: 90 }, 'Resting account'));
    if (a.id !== 'mine' && !a.primary) btn('Remove', () => { if (confirm(`Remove account "${a.label || a.id}"? (its credentials dir is left on disk)`)) acctAction('/api/accounts/remove', { id: a.id }, 'Removed'); }, 'danger');
    body.appendChild(card);
  }
}

async function acctAction(path, payload, okMsg) {
  try {
    const j = await (await api(path, { method: 'POST', body: JSON.stringify(payload) })).json();
    if (j.error) return toast(j.error);
    toast(okMsg); renderAccountsList();
  } catch { toast('Action failed'); }
}

// Move the CURRENT chat to another Claude account (transcript follows; it resumes there
// on your next message — the in-flight turn, if any, restarts).
async function openAccountSwitch() {
  if (!cur.id) return toast('Send a message first — no saved session yet');
  let data; try { data = await (await api('/api/accounts')).json(); } catch { return toast('Could not load accounts'); }
  const accts = (data.accounts || []).filter((a) => a.usable);
  if (accts.length < 2) return toast('Add a second account first (/login)');
  openSheet('Switch this chat to…', accts.map((a) => ({
    ic: a.primary ? '★' : '',
    label: a.label || a.id,
    desc: (a.email || a.id)
      + (a.utilization && a.utilization.max != null ? ` · ${a.utilization.max}% used` : '')
      + (a.cooling ? ' · cooling' : ''),
    fn: () => switchChatAccount(a.id, a.label || a.id),
  })));
}
async function switchChatAccount(accountId, label) {
  if (!cur.id) return toast('No saved session yet');
  toast('Switching…');
  try {
    const j = await (await api(`/api/sessions/${cur.id}/switch-account`, { method: 'POST', body: JSON.stringify({ accountId }) })).json();
    if (j.error) return toast(j.error);
    toast(`Moved to ${label} — your next message continues there`);
  } catch { toast('Switch failed'); }
}

function renderAddAccount() {
  const body = $('accountsBody');
  const keysUrl = body.dataset.consoleKeysUrl || 'https://console.anthropic.com/settings/keys';
  body.innerHTML = `<div class="acctForm">
    <div class="acctTabs"><button class="acctTab sel" data-tab="oauth">Claude subscription</button><button class="acctTab" data-tab="apikey">API key</button></div>
    <div id="acctPaneOauth" class="acctPane">
      <label class="acctLbl">Account name<input id="oaName" class="acctInput" placeholder="e.g. friend" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="acctLbl">Email <span class="muted">(optional — pre-fills the login)</span><input id="oaEmail" class="acctInput" placeholder="friend@example.com" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <button id="oaStart" class="btn primary">Get login link</button>
      <div id="oaStep2" class="hidden">
        <div class="acctNote">1. Open the link and sign in <b>as that account</b> — use a private/incognito window if you're already logged in as someone else.<br>2. Authorize, then copy the code it shows and paste it below.</div>
        <a id="oaLink" class="acctLink" target="_blank" rel="noopener">Open Claude login ↗</a>
        <div class="acctLbl">Paste the code (looks like <code>code#state</code>) — no typing needed</div>
        <button id="oaPaste" class="btn primary">📋 Paste code from clipboard</button>
        <textarea id="oaCode" class="acctInput acctCodeView" rows="3" readonly placeholder="your pasted code shows here"></textarea>
        <button id="oaComplete" class="btn primary">Complete login</button>
      </div>
    </div>
    <div id="acctPaneApikey" class="acctPane hidden">
      <label class="acctLbl">Account name<input id="akName" class="acctInput" placeholder="e.g. work-api" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="acctLbl">API key<input id="akKey" class="acctInput" type="password" placeholder="sk-ant-…" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <button id="akPaste" class="chip small acctPaste">📋 Paste from clipboard</button>
      <a class="acctLink" target="_blank" rel="noopener" href="${esc(keysUrl)}">Create a key on the Anthropic Console ↗</a>
      <div class="acctNote">API-key accounts bill per token (metered), unlike a Max/Pro subscription.</div>
      <button id="akSave" class="btn primary">Save API key</button>
    </div>
    <button id="acctBack" class="chip small acctBack">← Back to accounts</button></div>`;
  body.querySelectorAll('.acctTab').forEach((t) => t.onclick = () => {
    body.querySelectorAll('.acctTab').forEach((x) => x.classList.toggle('sel', x === t));
    $('acctPaneOauth').classList.toggle('hidden', t.dataset.tab !== 'oauth');
    $('acctPaneApikey').classList.toggle('hidden', t.dataset.tab !== 'apikey');
  });
  $('acctBack').onclick = renderAccountsList;
  // Paste straight from the clipboard — no keyboard. The code field is readonly so
  // tapping it never raises the iOS keyboard; if the clipboard API is blocked we
  // un-lock the field and focus it so the user can long-press → Paste (keyboard only
  // as a last resort).
  const pasteInto = async (elId) => {
    const el = $(elId);
    try {
      const t = await navigator.clipboard.readText();
      if (!t || !t.trim()) return toast('Clipboard is empty — copy the code first');
      el.removeAttribute('readonly'); el.value = t.trim(); el.setAttribute('readonly', '');
      toast('Pasted ✓');
    } catch {
      el.removeAttribute('readonly'); el.focus();
      toast('Long-press the field and tap Paste');
    }
  };
  $('oaPaste').onclick = () => pasteInto('oaCode');
  $('akPaste').onclick = () => pasteInto('akKey');
  let flowId = null;
  $('oaStart').onclick = async () => {
    const id = $('oaName').value.trim(); if (!id) return toast('Enter an account name');
    const b = $('oaStart'); b.disabled = true; b.textContent = 'Getting link…';
    try {
      const j = await (await api('/api/accounts/oauth/start', { method: 'POST', body: JSON.stringify({ id, label: id, email: $('oaEmail').value.trim() }) })).json();
      if (j.error) return toast(j.error);
      flowId = j.flowId; $('oaLink').href = j.url; $('oaStep2').classList.remove('hidden');
      toast('Open the link, then paste the code back');
    } catch { toast('Failed to start login'); }
    finally { b.disabled = false; b.textContent = 'Get login link'; }
  };
  $('oaComplete').onclick = async () => {
    const code = $('oaCode').value.trim(); if (!code) return toast('Paste the code first');
    if (!flowId) return toast('Start the login first');
    const b = $('oaComplete'); b.disabled = true; b.textContent = 'Finishing…';
    try {
      const j = await (await api('/api/accounts/oauth/complete', { method: 'POST', body: JSON.stringify({ flowId, code }) })).json();
      if (j.error) return toast(j.error);
      const sub = j.subscriptionType ? j.subscriptionType.toUpperCase() : 'plan unknown';
      toast(`Logged in${j.email ? ' as ' + j.email : ''} · ${sub}`);
      if (j.subscriptionType && j.subscriptionType !== 'max') setTimeout(() => toast('Heads up: not a Max plan'), 1500);
      renderAccountsList();
    } catch { toast('Login failed'); }
    finally { b.disabled = false; b.textContent = 'Complete login'; }
  };
  $('akSave').onclick = async () => {
    const id = $('akName').value.trim(), apiKey = $('akKey').value.trim();
    if (!id) return toast('Enter an account name'); if (!apiKey) return toast('Paste an API key');
    const b = $('akSave'); b.disabled = true; b.textContent = 'Saving…';
    try {
      const j = await (await api('/api/accounts/apikey', { method: 'POST', body: JSON.stringify({ id, label: id, apiKey }) })).json();
      if (j.error) return toast(j.error);
      toast(j.validated ? 'API key saved & validated' : 'API key saved'); renderAccountsList();
    } catch { toast('Save failed'); }
    finally { b.disabled = false; b.textContent = 'Save API key'; }
  };
}

/* ---------- voice (bilingual EN+中文, realtime streaming STT) ---------- */
// Streams mic PCM to our /stt relay → ElevenLabs Scribe v2 Realtime → live partial +
// committed transcripts. Each audio chunk is sent ONCE (cheap, O(n)), and committed
// text lands in the box as you speak, so a dropped connection never loses much.
// A MediaRecorder runs alongside purely as a fallback (batch transcribe) if streaming
// yields nothing.
let sttWs, sttStream, audioCtx, sttProc, recT0, recTimer, recPrefix = '';
let committedText = '', partialText = '', media, chunks = [];
// Full-recording capture: we accumulate the same 16-bit PCM frames we stream to STT
// (browser-agnostic — works on iOS Safari where MediaRecorder is unreliable) and, on
// stop, encode a WAV and batch-transcribe the WHOLE clip (Deepgram nova-3). That batch
// pass is the source of truth, so realtime garble/overwrites never reach the final text.
let pcmFrames = [], pcmRate = 16000, pcmSamples = 0;
const REC_MAX_SEC = 1800;                  // absolute ceiling (30 min) so a left-on mic can't OOM the page
const REC_MAX_BYTES = 23 * 1024 * 1024;    // keep the wav under the server's 25MB upload limit (binds first at high sample rates)
$('micBtn').onclick = () => (recording ? stopRec(true) : startRec());
$('recCancel').onclick = () => stopRec(false);
$('recConfirm').onclick = () => stopRec(true);

const recLiveText = () => (committedText + ' ' + partialText).replace(/\s+/g, ' ').trim();
function updateRecInput() {
  const live = recLiveText(); const t = $('input');
  t.value = recPrefix + (recPrefix && live && !/\s$/.test(recPrefix) ? ' ' : '') + live; autoGrow();
  const rt = $('recText'); if (rt) rt.textContent = live ? '✓ ' + (partialText || committedText).slice(-44) : 'Listening…';
}
// --- transcript accumulation helpers (resilient to Scribe v2 realtime missing/late commits) ---
const normT = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const wordsT = (s) => { const n = normT(s); return n ? n.split(' ') : []; };
// Append a finished segment to committedText, de-duping and upgrading cumulative supersets.
function sealCommitted(text) {
  const seg = (text || '').trim(); if (!seg) return;
  const prev = committedText.trim(); const np = normT(prev), ns = normT(seg);
  if (prev && ns && ns.startsWith(np)) { committedText = seg; return; } // cumulative superset → upgrade in place
  if (prev && ns && np.endsWith(ns)) return;                            // already present (e.g. a pre-sealed partial) → skip dup
  committedText = prev + (prev ? ' ' : '') + seg;                       // distinct segment → append
}
// Is `seg` a refinement/extension of the SAME utterance as `prev`, or a brand-new utterance?
// Re-transcriptions of one utterance keep most words (in order, allowing mid-word corrections
// like "too"→"to"); a brand-new utterance shares almost none. Compare via word-LCS ratio so a
// single corrected word doesn't read as a new sentence (which would duplicate text).
function isSameUtterance(prev, seg) {
  const wp = wordsT(prev), ws = wordsT(seg);
  if (!wp.length || !ws.length) return true;
  const np = normT(prev), ns = normT(seg);
  if (ns.startsWith(np) || np.startsWith(ns)) return true;             // pure growth or in-place backtrack
  const n = ws.length; const dp = new Array(n + 1).fill(0);
  for (let i = 1; i <= wp.length; i++) { let diag = 0; for (let j = 1; j <= n; j++) { const t = dp[j]; dp[j] = wp[i - 1] === ws[j - 1] ? diag + 1 : Math.max(dp[j], dp[j - 1]); diag = t; } }
  // Divide by the LONGER length, not the shorter: a brand-new SHORT utterance ("Okay",
  // "So") that happens to reuse one word from the long prior partial must NOT score 1.0
  // (which read as "same" and let the short partial OVERWRITE the previous sentence).
  return dp[n] / Math.max(wp.length, n) >= 0.5;                        // mostly the same words → same utterance
}
function floatToPCM16(f32, fromRate, toRate) {
  let data = f32;
  if (fromRate !== toRate) { const ratio = fromRate / toRate, len = Math.floor(f32.length / ratio), out = new Float32Array(len); for (let i = 0; i < len; i++) out[i] = f32[Math.floor(i * ratio)] || 0; data = out; }
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) { const s = Math.max(-1, Math.min(1, data[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return pcm.buffer;
}
// Encode accumulated 16-bit mono PCM frames into a WAV Blob (mono, 16-bit, pcmRate).
function encodeWav(frames, sampleRate) {
  let total = 0; for (const f of frames) total += f.length;
  const buf = new ArrayBuffer(44 + total * 2), dv = new DataView(buf);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + total * 2, true); wr(8, 'WAVE');
  wr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, total * 2, true);
  let off = 44; for (const f of frames) { for (let i = 0; i < f.length; i++, off += 2) dv.setInt16(off, f[i], true); }
  return new Blob([buf], { type: 'audio/wav' });
}
// iOS only PERSISTS microphone permission for the app launched from the Home Screen
// (standalone display mode). A plain Safari tab/bookmark re-prompts on every launch —
// so when we detect we're NOT installed, nudge once to "Add to Home Screen" (that's
// the actual fix for "I have to re-grant the mic every time").
const isStandalonePWA = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
let micInstallHintShown = false;
function maybeMicInstallHint() {
  if (isStandalonePWA() || micInstallHintShown) return;
  micInstallHintShown = true;
  toast('Tip: Share → “Add to Home Screen”, then open Box from that icon — iOS will remember mic access instead of asking each time.', 6500);
}

async function startRec() {
  if (recording) return;
  maybeMicInstallHint();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    sttStream = stream; recording = true; recPrefix = $('input').value; committedText = ''; partialText = '';
    pcmFrames = []; pcmSamples = 0;
    $('recorder').classList.remove('hidden'); $('input').placeholder = 'Listening… speak freely';
    const rt = $('recText'); if (rt) rt.textContent = 'Listening…';
    recT0 = Date.now(); recTimer = setInterval(() => { const s = Math.floor((Date.now() - recT0) / 1000); $('recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (s >= REC_MAX_SEC || pcmSamples * 2 >= REC_MAX_BYTES) { toast('mic limit reached — transcribing'); stopRec(true); } }, 250);
    refreshButton();
    // fallback batch recorder (only used if streaming yields nothing)
    chunks = []; try { const mime = ['audio/webm', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)); media = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); media.ondataavailable = (e) => e.data.size && chunks.push(e.data); media.start(1000); } catch { media = null; }
    // realtime streaming pipeline
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try { await audioCtx.resume(); } catch {}
    const native = audioCtx.sampleRate; const allowed = [8000, 16000, 22050, 24000, 44100, 48000];
    const useRate = allowed.includes(native) ? native : 16000;
    pcmRate = useRate;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const openSttWs = () => {
      const ws = new WebSocket(`${proto}://${location.host}/stt?token=${encodeURIComponent(TOKEN)}&rate=${useRate}`);
      ws.onmessage = (e) => {
        let o; try { o = JSON.parse(e.data); } catch { return; }
        if (o.type === 'committed') {
          const seg = (o.text || '').trim();
          if (!seg) return;
          sealCommitted(seg);              // append this finished segment (per-utterance, de-duped)
          partialText = ''; updateRecInput();
        } else if (o.type === 'partial') {
          let seg = o.text || '';
          // Strip already-committed prefix if ElevenLabs sends cumulative (full-session) partials.
          const prev = committedText.trim();
          if (prev && seg.startsWith(prev)) seg = seg.slice(prev.length).trim();
          // Safety net for Scribe's "never commits the turn" behaviour: a brand-new utterance's
          // partial would otherwise REPLACE (and lose) the previous, un-committed sentence. Seal
          // the previous partial into committed text first so nothing said so far is overwritten.
          if (partialText && seg && !isSameUtterance(partialText, seg)) sealCommitted(partialText);
          partialText = seg; updateRecInput();
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => { if (recording) setTimeout(() => { if (recording) sttWs = openSttWs(); }, 600); };
      return ws;
    };
    sttWs = openSttWs();
    const src = audioCtx.createMediaStreamSource(stream);
    sttProc = audioCtx.createScriptProcessor(4096, 1, 1);
    sttProc.onaudioprocess = (ev) => {
      const buf = floatToPCM16(ev.inputBuffer.getChannelData(0), native, useRate);
      if (sttWs && sttWs.readyState === 1) sttWs.send(buf);
      if (recording && pcmSamples * 2 < REC_MAX_BYTES) { const frame = new Int16Array(buf); pcmFrames.push(frame); pcmSamples += frame.length; }
    };
    const sink = audioCtx.createGain(); sink.gain.value = 0;   // run the processor without echoing mic to the speaker
    src.connect(sttProc); sttProc.connect(sink); sink.connect(audioCtx.destination);
  } catch (e) { recording = false; toast('mic blocked'); }
}
function endRec() {
  recording = false; clearInterval(recTimer);
  try { sttProc.disconnect(); } catch {} try { audioCtx.close(); } catch {}
  $('recorder').classList.add('hidden'); $('input').placeholder = cur.mode === 'bash' ? 'Run a command on the box…' : 'Message…';
}
async function stopRec(useIt) {
  if (!recording) return;
  endRec();
  try { if (media && media.state !== 'inactive') media.stop(); } catch {}
  if (!useIt) { try { sttWs.close(); } catch {} try { sttStream.getTracks().forEach((t) => t.stop()); } catch {} $('input').value = recPrefix; autoGrow(); refreshButton(); return; }
  try { sttWs.send(JSON.stringify({ type: 'commit' })); } catch {}   // flush the last segment
  await new Promise((r) => setTimeout(r, 700));
  try { sttWs.close(); } catch {}
  let live = recLiveText();
  // Always run an accurate batch pass (server-side Deepgram nova-3) over the WHOLE
  // recording and PREFER it: the realtime stream is fast for live feedback but garbles
  // long/bilingual speech and can overwrite earlier sentences. The full-recording pass is
  // the source of truth. We build the clip from the PCM frames we already captured (works
  // on every browser incl. iOS Safari, where MediaRecorder is unreliable); MediaRecorder
  // webm/m4a is only a secondary source. The server persists every clip, so even a failed
  // pass is recoverable via /api/retranscribe.
  let clipBlob = null, clipName = 'clip.webm';
  if (pcmFrames.length) { clipBlob = encodeWav(pcmFrames, pcmRate); clipName = 'clip.wav'; }
  else if (chunks.length) { clipBlob = new Blob(chunks, { type: (media && media.mimeType) || 'audio/webm' }); clipName = 'clip.' + (clipBlob.type.includes('mp4') ? 'm4a' : 'webm'); }
  if (clipBlob && clipBlob.size > 1024) {
    const rt = $('recText'); if (rt) rt.textContent = 'transcribing…';
    try { const fd = new FormData(); fd.append('audio', clipBlob, clipName); const d = await (await api('/api/transcribe', { method: 'POST', body: fd })).json(); const hq = (d.text || '').trim(); if (hq) live = hq; } catch {}
  }
  try { sttStream.getTracks().forEach((t) => t.stop()); } catch {}
  const t = $('input'); t.value = recPrefix + (recPrefix && live && !/\s$/.test(recPrefix) ? ' ' : '') + live; autoGrow();
  $('input').focus(); refreshButton();
}

/* ---------- image lightbox / gallery ---------- */
(function lightbox() {
  const lb = $('lightbox'), track = $('lbTrack'), count = $('lbCount');
  let srcs = [];
  $('messages').addEventListener('click', (e) => {
    const img = e.target.closest && e.target.closest('.umgs img'); if (!img) return;
    const all = [...$('messages').querySelectorAll('.umgs img')];
    openAt(all.map((i) => i.src), all.indexOf(img));
  });
  $('lbClose').onclick = close;
  $('lbDownload').onclick = () => {
    const idx = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    const src = srcs[idx]; if (!src) return;
    fetch(src).then((r) => r.blob()).then((blob) => {
      const ext = blob.type.split('/')[1] || 'jpg';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `image.${ext}`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }).catch(() => { window.open(src, '_blank'); });
  };
  function openAt(list, idx) {
    srcs = list; track.innerHTML = '';
    srcs.forEach((s) => { const sl = document.createElement('div'); sl.className = 'lbSlide'; const im = document.createElement('img'); im.src = s; im.draggable = false; attachZoom(im); sl.appendChild(im); sl.addEventListener('click', (ev) => { if (ev.target === sl) close(); }); track.appendChild(sl); });
    lb.classList.remove('hidden'); paintIcons(lb);
    requestAnimationFrame(() => { track.scrollLeft = (idx || 0) * track.clientWidth; updateCount(); });
  }
  function close() { lb.classList.add('hidden'); track.innerHTML = ''; track.classList.remove('nozoom'); }
  function nav(dir) {
    if (lb.classList.contains('hidden') || srcs.length < 2) return;
    const w = Math.max(1, track.clientWidth);
    const i = Math.round(track.scrollLeft / w);
    const next = Math.max(0, Math.min(srcs.length - 1, i + dir));
    track.scrollTo({ left: next * w, behavior: 'smooth' });
  }
  // Desktop web keyboard nav: Esc dismisses, ←/→ step through the thread's gallery.
  document.addEventListener('keydown', (e) => {
    if (lb.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); nav(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nav(1); }
  });
  function updateCount() { const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); count.textContent = srcs.length > 1 ? `${i + 1} / ${srcs.length}` : ''; }
  track.addEventListener('scroll', () => { if (!track.classList.contains('nozoom')) updateCount(); });
  function attachZoom(img) {
    let scale = 1, tx = 0, ty = 0, lastTap = 0, panning = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
    const reset = () => { scale = 1; tx = 0; ty = 0; img.classList.remove('panning'); track.classList.remove('nozoom'); apply(); };
    img.addEventListener('click', (e) => {
      const now = Date.now();
      if (now - lastTap < 280) { e.preventDefault(); if (scale > 1) reset(); else { scale = 2.6; track.classList.add('nozoom'); apply(); } lastTap = 0; }
      else { lastTap = now; setTimeout(() => { if (lastTap && Date.now() - lastTap >= 280 && scale === 1) close(); }, 290); }
    });
    img.addEventListener('touchstart', (e) => { if (scale > 1 && e.touches.length === 1) { panning = true; img.classList.add('panning'); sx = e.touches[0].clientX; sy = e.touches[0].clientY; ox = tx; oy = ty; } }, { passive: true });
    img.addEventListener('touchmove', (e) => { if (panning && scale > 1) { tx = ox + (e.touches[0].clientX - sx); ty = oy + (e.touches[0].clientY - sy); apply(); } }, { passive: true });
    img.addEventListener('touchend', () => { panning = false; img.classList.remove('panning'); });
  }
  window.openImageLightbox = (list, i) => openAt(list, i || 0);
})();

/* ---------- boot ---------- */
// Version label auto-tracks the live app.js: we stamp it from the served file's
// Last-Modified, so it bumps itself on every deploy — no hand-editing a constant.
// (The SW is network-first, so an online relaunch always pulls the fresh app.js.)
const BUILD = 77;  // static fallback if the HEAD probe can't run (offline / old server)
function stampVersion(s) { try { $('ver').textContent = s; } catch {} }
stampVersion('v' + BUILD);
fetch('/app.js', { method: 'HEAD', cache: 'no-store' }).then((r) => {
  const lm = r.headers.get('last-modified'); if (!lm) return;
  const d = new Date(lm), p = (n) => String(n).padStart(2, '0');
  stampVersion('build ' + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + '·' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + 'Z');
}).catch(() => {});
paintIcons();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (TOKEN) { navTo({ view: 'sessions', filter: 'all' }, { replace: true }); loadConfig(); openSessions().catch(() => show('login')); }
else { navTo({ view: 'login' }, { replace: true }); show('login'); }
