import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  agentFinishedLine,
  agentProgressLine,
  archiveSessionPolicy,
  detectListItems,
  paginateText,
  plainLanguageLabel,
  sanitizeVoiceEvent,
  spokenWorkLabel,
  sessionArchiveEligibility,
  summarizeAgentOutput,
  voiceFileAccessPolicy,
  voiceBool,
  voiceResponseStyle,
  voiceTurnDetectionConfig,
  voiceAudioPolicy,
  voiceNumOr,
  voiceNormalizeTokens,
  voiceRealtimeModelUnavailable,
  selfEchoMatch,
  summarizeSelfEchoDiagnostics,
} from './voice-assistant.mjs';

assert.equal(voiceBool(undefined, true), true);
assert.equal(voiceBool('1'), true);
assert.equal(voiceBool('yes'), true);
assert.equal(voiceBool('0'), false);
assert.equal(voiceBool('off'), false);

{
  assert.equal(voiceRealtimeModelUnavailable(404, { code: 'model_not_found' }), true);
  assert.equal(voiceRealtimeModelUnavailable(403, { message: 'Project does not have access to model gpt-realtime-2.1' }), true);
  assert.equal(voiceRealtimeModelUnavailable(403, { message: 'Missing scope api.model.read' }), false);
  assert.equal(voiceRealtimeModelUnavailable(400, { message: 'The model gpt-realtime-2.1 does not exist or you do not have access to it.' }), true);
  assert.equal(voiceRealtimeModelUnavailable(400, { message: 'Invalid value for audio.output.voice' }), false);
  assert.equal(voiceRealtimeModelUnavailable(401, { message: 'Incorrect API key' }), false);
  assert.equal(voiceRealtimeModelUnavailable(429, { message: 'Rate limit reached' }), false);
  assert.equal(voiceRealtimeModelUnavailable(500, { message: 'Server error' }), false);
}

{
  const brief = voiceResponseStyle();
  assert.match(brief, /ONE short spoken sentence/);
  assert.match(brief, /twelve words/);
  assert.match(brief, /Three sentences is the hard cap/);
  assert.doesNotMatch(brief, /3-5 spoken sentences/);
}

{
  const normal = voiceResponseStyle('normal');
  assert.match(normal, /1-3 concise spoken sentences/);
}

{
  const semantic = voiceTurnDetectionConfig();
  assert.deepEqual(semantic, {
    type: 'semantic_vad',
    eagerness: 'low',
    create_response: true,
    interrupt_response: false,
  });
}

{
  const serverVad = voiceTurnDetectionConfig({ mode: 'server', interruptResponse: true });
  assert.equal(serverVad.type, 'server_vad');
  assert.equal(serverVad.interrupt_response, true);
  assert.equal(serverVad.threshold, 0.65);
  assert.equal(serverVad.silence_duration_ms, 800);
}

// ---- voice session archive gating (INC-1085) -------------------------------

{
  assert.equal(sessionArchiveEligibility({ id: 's1', status: 'idle' }).ok, true);
  assert.equal(sessionArchiveEligibility({ id: 's2', status: 'finished' }).ok, true);
  assert.equal(sessionArchiveEligibility({ id: 's3', status: 'done' }).ok, true);
  assert.equal(sessionArchiveEligibility({ id: 's4', status: 'completed' }).ok, true);
}

{
  const working = sessionArchiveEligibility({ id: 's1', status: 'working' });
  assert.equal(working.ok, false);
  assert.equal(working.code, 'working');
  assert.match(working.reason, /still working/);

  const needs = sessionArchiveEligibility({ id: 's2', status: 'needs_input' });
  assert.equal(needs.ok, false);
  assert.equal(needs.code, 'needs_input');
  assert.match(needs.reason, /needs your input/);

  const live = sessionArchiveEligibility({ id: 's3', status: 'idle', live: true });
  assert.equal(live.ok, false);
  assert.equal(live.code, 'live');
  assert.match(live.reason, /still live/);
}

{
  const unknown = sessionArchiveEligibility({ id: 's1', status: 'paused' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'not_idle_or_finished');
  assert.match(unknown.reason, /only archives idle or finished sessions/);

  const archived = sessionArchiveEligibility({ id: 's2', status: 'archived', archived: true });
  assert.equal(archived.ok, true);
  assert.equal(archived.already_archived, true);
}

{
  const ev = sanitizeVoiceEvent({
    ts: 123,
    kind: 'diag',
    source: 'webrtc',
    event: 'inbound_audio_stats',
    data: {
      packetsLostDelta: 2,
      jitterMs: 31.23456,
      nested: { nope: true },
      secret: 'x'.repeat(400),
      'bad key !!!': 'kept',
    },
    ignored: 'drop',
  });
  assert.equal(ev.ts, 123);
  assert.equal(ev.kind, 'diag');
  assert.equal(ev.source, 'webrtc');
  assert.equal(ev.event, 'inbound_audio_stats');
  assert.equal(ev.data.packetsLostDelta, 2);
  assert.equal(ev.data.jitterMs, 31.235);
  assert.equal(ev.data.nested, undefined);
  assert.equal(ev.data.secret.length, 240);
  assert.equal(ev.data['badkey'], 'kept');
  assert.equal(ev.ignored, undefined);
}

{
  const ev = sanitizeVoiceEvent({ kind: 'assistant', text: ' hello '.repeat(1000), name: 'tool'.repeat(20) }, 456);
  assert.equal(ev.ts, 456);
  assert.equal(ev.kind, 'assistant');
  assert.ok(ev.text.length <= 2000);
  assert.ok(ev.name.length <= 40);
}

// ---- guarded session archive policy (INC-1085) ------------------------------

{
  assert.deepEqual(archiveSessionPolicy(null), { ok: false, code: 'not_found', error: 'session not found' });
  assert.equal(archiveSessionPolicy({ id: 's1', title: 'Done', status: 'idle', live: false }).ok, true);
  assert.equal(archiveSessionPolicy({ id: 's1', title: 'Old', archived: true }).already_archived, true);
  assert.equal(archiveSessionPolicy({ id: 's1', title: 'Running', status: 'working' }).code, 'session_not_idle');
  assert.equal(archiveSessionPolicy({ id: 's1', title: 'Question', status: 'needs_input' }).code, 'session_not_idle');
  assert.equal(archiveSessionPolicy({ id: 's1', title: 'Live', live: true }).code, 'session_not_idle');
  assert.equal(archiveSessionPolicy({ id: 's1', title: 'Restore', status: 'live' }, { archived: false }).ok, true);
}

// ---- session artifact retrieval (INC-1080) ----------------------------------

{
  // Numbered ranked list → item bodies without the markers.
  const list = '1. Acme Corp — $2M ARR\n2. Globex — $1.4M\n3. Initech — $900k\n4. Umbrella — $600k';
  const items = detectListItems(list);
  assert.equal(items.length, 4);
  assert.equal(items[0], 'Acme Corp — $2M ARR');
  assert.equal(items[3], 'Umbrella — $600k');
}
{
  // Bulleted list with mixed markers also counts.
  assert.equal(detectListItems('- one\n* two\n• three').length, 3);
  // Fewer than 3 markers is not treated as a list.
  assert.deepEqual(detectListItems('just a sentence.\n- lonely dash'), []);
  // Prose with no markers → empty.
  assert.deepEqual(detectListItems('This is a paragraph with 1 number in it.'), []);
}

{
  // Pagination packs whole lines and never splits an item across pages.
  const SIZE = 200; // pageSize floor is 200 chars
  const lines = Array.from({ length: 40 }, (_, i) => `${i + 1}. ranked target number ${i + 1} in the list`).join('\n');
  const p1 = paginateText(lines, { page: 1, pageSize: SIZE });
  assert.equal(p1.page, 1);
  assert.ok(p1.total_pages > 1);
  assert.equal(p1.has_more, true);
  assert.equal(p1.next_page, 2);
  // Every line on the page is a complete item (never cut mid-item).
  for (const ln of p1.text.split('\n')) assert.match(ln, /^\d+\. ranked target number \d+ in the list$/);
  // No page exceeds the size (whole short lines always fit).
  assert.ok(p1.text.length <= SIZE);
  // Concatenating every page reconstructs the original (single join newline between pages).
  let joined = '';
  for (let i = 1; i <= p1.total_pages; i++) {
    const pg = paginateText(lines, { page: i, pageSize: SIZE });
    assert.ok(pg.text.length <= SIZE);
    joined += (joined ? '\n' : '') + pg.text;
  }
  assert.equal(joined, lines);
  // Last page reports no more.
  const last = paginateText(lines, { page: p1.total_pages, pageSize: SIZE });
  assert.equal(last.has_more, false);
  assert.equal(last.next_page, undefined);
  // Out-of-range page clamps to the last page.
  assert.equal(paginateText(lines, { page: 999, pageSize: SIZE }).page, p1.total_pages);
}
{
  // An over-long single line is hard-split so no page overflows.
  const big = 'x'.repeat(5000);
  const pg = paginateText(big, { page: 1, pageSize: 1000 });
  assert.equal(pg.total_pages, 5);
  assert.equal(pg.text.length, 1000);
  assert.equal(pg.total_chars, 5000);
}
{
  // Empty output is one empty page, not a crash.
  const pg = paginateText('', {});
  assert.equal(pg.total_pages, 1);
  assert.equal(pg.has_more, false);
  assert.equal(pg.text, '');
}

{
  // Summarize a list → count + capped top items.
  const list = Array.from({ length: 12 }, (_, i) => `${i + 1}. target ${i + 1}`).join('\n');
  const sum = summarizeAgentOutput(list, { maxItems: 5 });
  assert.equal(sum.kind, 'list');
  assert.equal(sum.item_count, 12);
  assert.equal(sum.top_items.length, 5);
  assert.equal(sum.has_more_items, true);
  assert.equal(sum.top_items[0], 'target 1');
}
{
  // Summarize prose → headline + size, no items.
  const prose = 'The market is large. Growth is steady. There is room to win share from daisyBill over the next year as more billers churn.';
  const sum = summarizeAgentOutput(prose);
  assert.equal(sum.kind, 'prose');
  assert.equal(sum.item_count, 0);
  assert.ok(sum.total_chars > 0);
  assert.match(sum.headline, /The market is large\. Growth is steady\./);
}

// ---- mediated local-file access (INC-1079) ----------------------------------

{
  const root = mkdtempSync(join(tmpdir(), 'box-voice-file-'));
  try {
    const sheet = join(root, 'attendees.xlsx');
    writeFileSync(sheet, 'not really xlsx, policy only checks metadata');
    const p = voiceFileAccessPolicy({ path: sheet }, { HOME: root, STATE_DIR: root, roots: [root], maxBytes: 1024 });
    assert.equal(p.ok, true);
    assert.equal(p.kind, 'spreadsheet');
    assert.equal(p.direct_access, false);
    assert.equal(p.can_delegate_ingest, true);
    assert.equal(p.needs_permission, true);
    assert.match(p.permission_prompt, /scoped agent/);

    const confirmed = voiceFileAccessPolicy({ path: sheet, user_confirmed: true }, { HOME: root, STATE_DIR: root, roots: [root], maxBytes: 1024 });
    assert.equal(confirmed.needs_permission, false);
    assert.match(confirmed.message, /in scope/);

    const byName = voiceFileAccessPolicy({ path: 'attendees.xlsx' }, { HOME: root, STATE_DIR: root, roots: [root], cwd: root, maxBytes: 1024 });
    assert.equal(byName.ok, true);
    assert.equal(byName.path, sheet);

    const missing = voiceFileAccessPolicy({ path: join(root, 'missing.csv') }, { HOME: root, STATE_DIR: root, roots: [root] });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'not_found');

    const outside = mkdtempSync(join(tmpdir(), 'box-voice-outside-'));
    try {
      const other = join(outside, 'other.csv');
      writeFileSync(other, 'a,b\n1,2\n');
      const blocked = voiceFileAccessPolicy({ path: other }, { HOME: root, STATE_DIR: root, roots: [root] });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.code, 'outside_scope');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    mkdirSync(join(root, '.ssh'));
    const key = join(root, '.ssh', 'id_rsa');
    writeFileSync(key, 'secret');
    const secret = voiceFileAccessPolicy({ path: key }, { HOME: root, STATE_DIR: root, roots: [root] });
    assert.equal(secret.ok, false);
    assert.equal(secret.code, 'sensitive_path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- plain-language work labels (INC-1087) ----------------------------------
// The voice narration must name work by WHAT IT IS, not a bare ticket code.

{
  // Titles collapse to a short topical phrase: leading verbs and scope prefixes drop,
  // the ticket/PR code is stripped, and the most descriptive clause wins.
  assert.equal(
    plainLanguageLabel({ title: 'Voice assistant: avoid code-only ticket references; summarize work in plain language' }),
    'code-only ticket references',
  );
  assert.equal(plainLanguageLabel({ title: 'Fix clearinghouse rejections remediation' }), 'clearinghouse rejections remediation');
  assert.equal(plainLanguageLabel({ title: 'Add mediated voice file access (#100)' }), 'mediated voice file access');
  assert.equal(plainLanguageLabel({ title: 'INC-1080: voice — reliable full session-artifact retrieval' }), 'reliable full session-artifact retrieval');
  // A leading article is dropped after the imperative verb.
  assert.equal(plainLanguageLabel({ title: 'Fix the invoice rounding bug' }), 'invoice rounding bug');
  // Short ALL-CAPS acronyms survive (so the model still spells them), the rest lowercases.
  assert.equal(plainLanguageLabel({ title: 'Implement VOB automation for Rise4 psychiatry intake' }), 'VOB automation for rise4 psychiatry intake');
}

{
  // Brief: never more than the word cap, and the cap is honoured.
  const long = plainLanguageLabel({ title: 'Fix clearinghouse rejection routing across every payer and clearinghouse endpoint nationwide' });
  assert.ok(long.split(' ').length <= 6, `expected <=6 words, got "${long}"`);
  const capped = plainLanguageLabel({ title: 'Reconcile Carisk EOB portal remittances into the ledger automatically' }, { maxWords: 3 });
  assert.ok(capped.split(' ').length <= 3, `expected <=3 words, got "${capped}"`);
}

{
  // Fall back to a fetched summary when the title carries no words (e.g. a bare code).
  assert.equal(plainLanguageLabel({ title: 'INC-1099', summary: 'Fix the Spravato monitoring form submission.' }), 'spravato monitoring form submission');
  assert.equal(plainLanguageLabel({ title: 'INC-1099' }), ''); // nothing derivable → empty, callers add a fallback
  assert.equal(plainLanguageLabel({}), '');
}

{
  // spokenWorkLabel always yields something safe to say, in priority order.
  assert.equal(spokenWorkLabel({ id: 'INC-950', title: 'Fix clearinghouse rejections' }), 'clearinghouse rejections');
  assert.equal(spokenWorkLabel({ id: 'INC-950', title: 'Onboarding' }), 'onboarding');   // title kept when not shortenable further
  assert.equal(spokenWorkLabel({ id: 'INC-950', title: '' }), 'ticket INC-950');          // last resort: humanized code
  assert.equal(spokenWorkLabel({}), 'that work');
}

{
  // The spoken announcement lines LEAD with the descriptor and never the bare code.
  const speakAs = plainLanguageLabel({ title: 'INC-950: Fix clearinghouse rejections remediation' });
  assert.equal(speakAs, 'clearinghouse rejections remediation');

  const done = agentFinishedLine({ agent: 'claude', speakAs, tail: 'Opened PR 42.', truncated: false });
  assert.match(done, /clearinghouse rejections remediation/);
  assert.doesNotMatch(done, /INC-950/);
  assert.doesNotMatch(done, /claude agent/); // the default agent isn't named aloud
  assert.match(done, /just finished its pass/);
  assert.match(done, /Opened PR 42\./);

  const truncated = agentFinishedLine({ agent: 'codex', speakAs, tail: 'A long list…', truncated: true });
  assert.match(truncated, /^The codex agent on "clearinghouse rejections remediation"/); // non-default agent IS named
  assert.match(truncated, /send me the full write-up/);

  const noOutput = agentFinishedLine({ speakAs });
  assert.match(noOutput, /could not read its output/);

  const progress = agentProgressLine({ agent: 'claude', speakAs, minutes: 6, peek: 'reading the spec' });
  assert.match(progress, /clearinghouse rejections remediation/);
  assert.doesNotMatch(progress, /INC-950/);
  assert.match(progress, /about 6 minutes in/);
  assert.match(progress, /Latest: reading the spec/);
  // No peek → no "Latest:" tail.
  assert.doesNotMatch(agentProgressLine({ speakAs, minutes: 2 }), /Latest:/);
}

// ---- audio-pipeline hardening: half-duplex + self-echo guard (INC-1088) -----

{
  // server_vad threshold/silence are now tunable, defaults unchanged.
  const def = voiceTurnDetectionConfig({ mode: 'server' });
  assert.equal(def.threshold, 0.65);
  assert.equal(def.silence_duration_ms, 800);
  const tuned = voiceTurnDetectionConfig({ mode: 'server', threshold: 0.85, silenceMs: 500 });
  assert.equal(tuned.threshold, 0.85);
  assert.equal(tuned.silence_duration_ms, 500);
  // out-of-range values clamp, not crash.
  assert.equal(voiceTurnDetectionConfig({ mode: 'server', threshold: 5 }).threshold, 1);
  assert.equal(voiceTurnDetectionConfig({ mode: 'server', threshold: -1 }).threshold, 0);
  // garbage falls back to the default.
  assert.equal(voiceTurnDetectionConfig({ mode: 'server', threshold: 'abc' }).threshold, 0.65);
  // semantic VAD ignores the server-only knobs.
  assert.equal(voiceTurnDetectionConfig({ threshold: 0.9 }).type, 'semantic_vad');
}

{
  // Half-duplex is ON by default and turns OFF when barge-in is enabled (mutually exclusive).
  const d = voiceAudioPolicy();
  assert.equal(d.halfDuplex, true);
  assert.equal(d.echoGuard, true);
  assert.equal(d.tailMs, 600);
  assert.equal(d.maxHoldMs, 20000);
  assert.equal(d.echoThreshold, 0.8);
  assert.equal(d.echoMinTokens, 4);
  assert.equal(voiceAudioPolicy({ interruptResponse: true }).halfDuplex, false);
  // explicit override wins over the barge-in default, both directions.
  assert.equal(voiceAudioPolicy({ interruptResponse: true, halfDuplex: '1' }).halfDuplex, true);
  assert.equal(voiceAudioPolicy({ halfDuplex: '0' }).halfDuplex, false);
  assert.equal(voiceAudioPolicy({ echoGuard: 'off' }).echoGuard, false);
  // tunables parse + clamp.
  assert.equal(voiceAudioPolicy({ tailMs: '900' }).tailMs, 900);
  assert.equal(voiceAudioPolicy({ maxHoldMs: 100 }).maxHoldMs, 1000);   // floor
  assert.equal(voiceAudioPolicy({ echoThreshold: 0.1 }).echoThreshold, 0.5); // floor
  assert.equal(voiceAudioPolicy({ echoMinTokens: 1 }).echoMinTokens, 2);     // floor
  assert.equal(voiceAudioPolicy({ tailMs: 'x' }).tailMs, 600);               // garbage → default
  // REGRESSION (INC-1088): an absent env var arrives from cfg() as '', not undefined.
  // Number('') is 0 (finite), which must NOT be read as an explicit 0 that clamps to the
  // floor — '' means "unset" → the intended default, exactly like the fully-empty call.
  const empty = voiceAudioPolicy({ tailMs: '', maxHoldMs: '', echoThreshold: '', echoMinTokens: '', halfDuplex: '', echoGuard: '' });
  assert.equal(empty.tailMs, 600);
  assert.equal(empty.maxHoldMs, 20000);
  assert.equal(empty.echoThreshold, 0.8);
  assert.equal(empty.echoMinTokens, 4);
  assert.equal(empty.halfDuplex, true);
  assert.equal(empty.echoGuard, true);
  // An explicit 0 is still honoured where valid (tailMs floor is 0).
  assert.equal(voiceAudioPolicy({ tailMs: 0 }).tailMs, 0);
  assert.equal(voiceAudioPolicy({ tailMs: '0' }).tailMs, 0);
  // Server VAD knobs: '' → defaults, not 0.
  assert.equal(voiceTurnDetectionConfig({ mode: 'server', threshold: '', silenceMs: '' }).threshold, 0.65);
  assert.equal(voiceTurnDetectionConfig({ mode: 'server', threshold: '', silenceMs: '' }).silence_duration_ms, 800);
}

{
  // voiceNumOr: '' / null / undefined / NaN-ish → default; real numbers (incl. 0) pass.
  assert.equal(voiceNumOr('', 600), 600);
  assert.equal(voiceNumOr(null, 600), 600);
  assert.equal(voiceNumOr(undefined, 600), 600);
  assert.equal(voiceNumOr('abc', 600), 600);
  assert.equal(voiceNumOr('0', 600), 0);
  assert.equal(voiceNumOr(0, 600), 0);
  assert.equal(voiceNumOr('900', 600), 900);
  assert.equal(voiceNumOr(1.5, 600), 1.5);
}

{
  assert.deepEqual(voiceNormalizeTokens('Spectrum, ~3,000 bills/month!'), ['spectrum', '3', '000', 'bills', 'month']);
  assert.deepEqual(voiceNormalizeTokens(''), []);
  assert.deepEqual(voiceNormalizeTokens(null), []);
}

{
  // Self-echo: the assistant's own words echoed back are flagged; real user speech is not.
  const asst = ['Spectrum submits about three thousand bills a month right now.'];
  const echo = selfEchoMatch('Spectrum submits about three thousand bills a month', asst);
  assert.equal(echo.isEcho, true);
  assert.ok(echo.score >= 0.8);

  const real = selfEchoMatch('what is our revenue this quarter', asst);
  assert.equal(real.isEcho, false);

  // Short commands must ALWAYS get through even if they overlap (min-token gate).
  assert.equal(selfEchoMatch('stop', asst).isEcho, false);
  assert.equal(selfEchoMatch('yes do that', asst).isEcho, false);

  // Partial echo (a leading fragment of what we just said) still trips the guard.
  const frag = selfEchoMatch('Spectrum submits about three thousand', asst);
  assert.equal(frag.isEcho, true);

  // No assistant history → never an echo.
  assert.equal(selfEchoMatch('Spectrum submits about three thousand bills a month', []).isEcho, false);

  // A high threshold can be demanded; a near-miss then fails.
  const strict = selfEchoMatch('Spectrum submits about three thousand bills a year', asst, { threshold: 0.95 });
  assert.equal(strict.isEcho, false);
}

{
  // Diagnostics rollup counts incident event types + folds in end-of-call totals.
  const lines = [
    JSON.stringify({ kind: 'diag', event: 'half_duplex_gate_closed' }),
    JSON.stringify({ kind: 'diag', event: 'self_interrupt_candidate' }),
    JSON.stringify({ kind: 'diag', event: 'false_interrupt_armed' }),
    JSON.stringify({ kind: 'diag', event: 'self_echo_dropped' }),
    JSON.stringify({ kind: 'diag', event: 'false_interrupt_resume' }),
    JSON.stringify({ kind: 'diag', event: 'audio_incidents', data: { selfInterrupt: 2, misattribution: 1 } }),
    JSON.stringify({ kind: 'user', text: 'ignored — not a diag' }),
    'not json at all',
    '',
  ].join('\n');
  const sum = summarizeSelfEchoDiagnostics(lines);
  assert.equal(sum.half_duplex_gate, 1);
  assert.equal(sum.self_interrupt_candidate, 1);
  assert.equal(sum.self_interrupt_armed, 1);
  assert.equal(sum.self_echo_dropped, 1);
  assert.equal(sum.false_interrupt_resume, 1);
  assert.equal(sum.calls, 1);
  assert.equal(sum.self_interrupt_total, 2);
  assert.equal(sum.misattribution_total, 1);
  assert.equal(sum.total_diag, 6);
  // Accepts an array of lines too.
  assert.equal(summarizeSelfEchoDiagnostics(lines.split('\n')).calls, 1);
}

console.log('voice-assistant helpers ok');
