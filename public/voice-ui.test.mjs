// Voice kit (public/voice-ui.js): hero captions, tool pills, and graceful no-ops without
// canvas / WAAPI (so voice keeps working where they're missing).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function el(tag = 'div') {
  const e = {
    tag, className: '', innerHTML: '', textContent: '', childNodes: [], style: {}, attrs: {}, listeners: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild(n) { this.childNodes.push(n); n.parentEl = this; return n; },
    removeChild(n) { this.childNodes = this.childNodes.filter((x) => x !== n); },
    get firstChild() { return this.childNodes[0]; },
    remove() { if (this.parentEl) this.parentEl.removeChild(this); },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    scrollTop: 0, scrollHeight: 1000, clientHeight: 400,
  };
  return e;
}
const ctx = { console, setTimeout, clearTimeout, Date, Math, JSON, navigator: {}, document: { createElement: el, documentElement: { dataset: {} }, head: el('head') } };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('./voice-ui.js', import.meta.url), 'utf8'), ctx);
const UI = ctx.VoiceUI;
const has = (n, c) => n.classList.contains(c) || new RegExp(`\\b${c}\\b`).test(n.className);

// ---- captions: newest spoken line is the hero, the previous one echoes, notices/pills don't count ----
const root = el(), jump = el('button');
const caps = UI.createCaptions(root, jump, { hint: 'Just talk.' });
caps.clear();
assert.equal(root.childNodes.length, 1, 'empty state shows the hint');
assert.ok(has(root.childNodes[0], 'voHint'));
const a = caps.line('asst', 'Hey, ready.');
assert.equal(root.childNodes.includes(root.childNodes.find((n) => has(n, 'voHint'))), false, 'first line removes the hint');
const u = caps.line('user', '');
assert.ok(has(a, 'now') && !has(u, 'now'), 'an empty (still streaming) line is not the hero yet');
u.textContent = "What's on my calendar?"; caps.refresh();
assert.ok(has(u, 'now') && has(a, 'prev') && !has(a, 'now'));
const p = caps.pill('Checking calendar…', 'calendar');
caps.notice('Reconnected.');
assert.ok(has(u, 'now'), 'pills and notices never take the hero');
assert.ok(has(p, 'voToolChip') && has(p, 'run'));
u.textContent = 'x'.repeat(200); caps.refresh();
assert.ok(has(u, 'long'), 'long hero lines step down a size');
assert.equal(root.scrollTop, root.scrollHeight, 'follows the newest line');
// a user scroll back pauses follow and shows "Latest"; tapping it resumes
root.listeners.touchmove[0](); root.scrollTop = 0; root.listeners.scroll[0]();
assert.equal(caps.following, false); assert.ok(jump.classList.contains('show'));
caps.line('asst', 'New line while scrolled back');
assert.equal(root.scrollTop, 0, 'does not yank the reader back down');
jump.onclick();
assert.equal(caps.following, true); assert.equal(root.scrollTop, root.scrollHeight);
caps.forget(u);
assert.ok(!root.childNodes.includes(u));
for (let i = 0; i < 150; i++) caps.line('asst', 'line ' + i);
assert.ok(root.childNodes.length <= 120, 'feed is capped');

// ---- pills: outcome classes, icon swap, past-tense label + meta ----
const q = UI.pill('Checking calendar…', 'calendar');
UI.finishPill(q, 'warn', { label: 'Checked calendar', meta: 'personal failed' });
assert.ok(q.classList.contains('done') && q.classList.contains('warn') && !q.classList.contains('run'));
assert.equal(q._name.textContent, 'Checked calendar'); assert.equal(q._meta.textContent, 'personal failed');
assert.equal(q._ic.innerHTML, UI.ICON.warn);
UI.finishPill(q, 'ok'); assert.ok(!q.classList.contains('ok'), 'a pill resolves once');
const r = UI.pill('Checking email…', 'gmail_search');
UI.finishPill(r, true, { ms: 2300 });
assert.ok(r.classList.contains('fail')); assert.equal(r._meta.textContent, '2.3s');
assert.equal(UI.toolIcon('calendar'), UI.ICON.calendar);
assert.equal(UI.toolIcon('mystery'), UI.ICON.bolt);

// ---- graceful no-ops: no canvas context, no WAAPI, no vibrate ----
const orb = UI.createOrb(el('canvas'));
orb.set({ phase: 'live', working: true }); orb.setActive(false); orb.destroy();
assert.equal(orb.mode, 'idle');
await UI.morph({ surface: el(), from: el(), open: true });
await UI.exit(el());
UI.haptic('done'); UI.primeAudio(); UI.cue('start');
assert.deepEqual([...UI.MODES], ['idle', 'connecting', 'listening', 'hearing', 'thinking', 'speaking', 'muted', 'reconnecting', 'error']);
console.log('voice-ui tests ok');
