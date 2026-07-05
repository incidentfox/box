#!/usr/bin/env node
// Voice-assistant smoke test. Drives a RUNNING box server (point it at an isolated-HOME
// test instance — see CLAUDE.md) through the whole voice stack:
//   1. auth + feature flag + /api/voice/status
//   2. every read-safe tool via POST /api/voice/tool
//   3. ephemeral token mint
//   4. a REAL OpenAI Realtime session over WebSocket: text prompt → model calls a tool →
//      we relay it through /api/voice/tool → model answers. (Text-only response, so the
//      only cost is a few hundred tokens.)
//
// Usage: VO_BASE=http://127.0.0.1:7461 VO_TOKEN=votest node scripts/voice-smoke.mjs [--no-ws]

import WebSocket from 'ws';

const BASE = process.env.VO_BASE || 'http://127.0.0.1:7461';
const TOKEN = process.env.VO_TOKEN || 'votest';
const NO_WS = process.argv.includes('--no-ws');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
const api = async (path, opts = {}) => {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const tool = async (name, args = {}) => {
  const r = await api('/api/voice/tool', { method: 'POST', body: JSON.stringify({ name, args, call_id: 'smoke', vsid: 'smoke-test' }) });
  let out = {};
  try { out = JSON.parse(r.json.output || '{}'); } catch {}
  return out;
};

console.log(`\n— voice smoke against ${BASE} —\n`);

// 1. basics
{
  const cfg = await api('/api/config');
  ok('auth + /api/config', cfg.status === 200);
  ok('features.voiceAssistant on', !!(cfg.json.features && cfg.json.features.voiceAssistant));
  const st = await api('/api/voice/status');
  ok('/api/voice/status', st.status === 200 && st.json.enabled === true, `model=${st.json.model} tools=${(st.json.tools || []).length}`);
}

// 2. tools (read-safe set)
{
  const o = await tool('get_overview');
  ok('get_overview', !o.error && Array.isArray(o.recent_sessions), `${(o.recent_sessions || []).length} recent, board=${JSON.stringify(o.board_counts || {}).slice(0, 60)}`);
  const ls = await tool('list_sessions', { filter: 'all' });
  ok('list_sessions', !ls.error && Array.isArray(ls.sessions) && ls.sessions.length > 0, `${(ls.sessions || []).length} sessions`);
  if (ls.sessions && ls.sessions[0]) {
    const cs = await tool('check_session', { query: ls.sessions[0].title.split(' ').slice(0, 2).join(' ') });
    ok('check_session', !!cs.match || !!cs.error, cs.match ? `→ "${cs.match.title}"` : cs.error);
  }
  const bd = await tool('linear_board');
  ok('linear_board', !bd.error && Object.keys(bd).length > 0, Object.keys(bd).slice(0, 4).join(','));
  const nj = await tool('needs_jimmy');
  ok('needs_jimmy', !nj.error && typeof nj.open === 'number', `${nj.open} open`);
  const bs = await tool('brain_search', { query: 'Spectrum' });
  ok('brain_search', !bs.error && Array.isArray(bs.matches), `${(bs.matches || []).length} files`);
  if (bs.matches && bs.matches[0]) {
    const br = await tool('brain_read', { path: bs.matches[0].file });
    ok('brain_read', !br.error && (br.content || '').length > 50, `${(br.content || '').length} chars`);
  }
  const ws1 = await tool('web_search', { query: 'daisyBill workers comp billing software' });
  ok('web_search', !ws1.error && (ws1.results || []).length > 0, `${(ws1.results || []).length} results`);
  const tn = await tool('take_note', { text: 'smoke-test note — safe to ignore', kind: 'thought' });
  ok('take_note', tn.saved === true);
  const rn = await tool('read_notes');
  ok('read_notes', typeof rn.notes === 'string' && rn.notes.includes('smoke-test note'));
  const ct = await tool('check_tasks');
  ok('check_tasks', Array.isArray(ct.running));
  const gb = await tool('get_briefing');
  ok('get_briefing responds', Array.isArray(gb.sections) || /no briefing/.test(gb.error || ''), gb.sections ? gb.sections.join('|').slice(0, 60) : 'not prepared yet');
  const cal = await tool('calendar');
  ok('calendar', !cal.error && typeof cal.personal === 'string', (cal.personal || '').split('\n')[0].slice(0, 60));
}

// 3. token mint + 4. realtime WS round-trip with a live tool call
if (!NO_WS) {
  const t = await api('/api/voice/token', { method: 'POST', body: JSON.stringify({}) });
  ok('token mint', t.status === 200 && String(t.json.clientSecret || '').startsWith('ek_'), `model=${t.json.model} vsid=${t.json.vsid}`);
  if (t.json.clientSecret) {
    await new Promise((resolve) => {
      const finish = (why) => { clearTimeout(guard); try { ws.close(); } catch {} console.log(`  (ws closed: ${why})`); resolve(); };
      const guard = setTimeout(() => { ok('realtime round-trip', false, 'timeout after 90s'); finish('timeout'); }, 90000);
      const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=' + encodeURIComponent(t.json.model), {
        headers: { Authorization: `Bearer ${t.json.clientSecret}` },
      });
      let calledTool = '', finalText = '', gotSession = false, sentOutput = false;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use your get_overview tool right now, then answer in ONE short sentence: how many recent agent sessions do you see?' }] },
        }));
        ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['text'] } }));
      });
      ws.on('message', async (buf) => {
        let ev; try { ev = JSON.parse(buf.toString()); } catch { return; }
        if (ev.type === 'session.created') { gotSession = true; ok('ws session.created', true, `session=${(ev.session && ev.session.id || '').slice(0, 14)}…`); }
        if (ev.type === 'response.output_item.done' && ev.item && ev.item.type === 'function_call') {
          calledTool = ev.item.name;
          finalText = ''; // the answer we care about comes AFTER the tool result
          console.log(`  … model called ${ev.item.name}(${(ev.item.arguments || '').slice(0, 40)})`);
          const r = await api('/api/voice/tool', { method: 'POST', body: JSON.stringify({ name: ev.item.name, args: ev.item.arguments, call_id: ev.item.call_id, vsid: t.json.vsid }) });
          ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.item.call_id, output: r.json.output || '{}' } }));
          ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['text'] } }));
          sentOutput = true;
        }
        if (ev.type === 'response.output_text.delta') finalText += ev.delta || '';
        if (ev.type === 'response.done' && finalText && (!calledTool || sentOutput)) {
          ok('realtime tool round-trip', !!calledTool && finalText.length > 5, `tool=${calledTool} answer="${finalText.slice(0, 110)}"`);
          finish('done');
        }
        if (ev.type === 'error') {
          console.log('  ws error event:', JSON.stringify(ev.error || ev).slice(0, 200));
          if (!gotSession) { ok('realtime round-trip', false, 'ws error before session'); finish('error'); }
        }
      });
      ws.on('error', (e) => { ok('ws connect', false, String(e.message || e)); finish('socket error'); });
    });
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
