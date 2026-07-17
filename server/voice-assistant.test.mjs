import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  agentFinishedLine,
  adapterSessionIdFromRows,
  agentProgressLine,
  archiveSessionPolicy,
  buildTranscriptView,
  claudeTurnsFromJsonl,
  codexTurnsFromMessages,
  detectListItems,
  paginateText,
  redactSecrets,
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
  voiceAgentOutputSummary,
  voiceAgentStartKey,
  voiceAutonomyPolicy,
  voiceContextPolicy,
  voiceEventAudible,
  voiceNumOr,
  voiceNormalizeTokens,
  voiceRealtimeModelUnavailable,
  voiceSessionOutputPreview,
  selfEchoMatch,
  shouldResumeAfterBargeIn,
  summarizeSelfEchoDiagnostics,
} from './voice-assistant.mjs';

assert.equal(voiceBool(undefined, true), true);
assert.equal(voiceBool('1'), true);
assert.equal(voiceBool('yes'), true);
assert.equal(voiceBool('0'), false);
assert.equal(voiceBool('off'), false);

assert.equal(adapterSessionIdFromRows([
  { kind: 'assistant', source: 'adapter', agent: 'codex', session_id: 'old-thread' },
  { kind: 'adapter_session', source: 'adapter', agent: 'codex', session_id: 'current-thread' },
], 'codex'), 'current-thread');
assert.equal(adapterSessionIdFromRows([{ kind: 'assistant', source: 'adapter', agent: 'claude', session_id: 'wrong-agent' }], 'codex'), '');

{
  const policy = voiceAutonomyPolicy();
  assert.match(policy, /safe, reversible, and strongly implied/);
  assert.match(policy, /Reuse details already provided/);
  assert.match(policy, /sounds frustrated/);
  assert.match(policy, /already running/);
  assert.match(policy, /destructive or hard-to-reverse/);
}

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
  assert.match(brief, /one or two compact spoken sentences/);
  assert.match(brief, /25-45 words/);
  assert.match(brief, /ONE topic at a time/);
  assert.doesNotMatch(brief, /3-5 spoken sentences/);
}

{
  const policy = voiceContextPolicy();
  assert.match(policy, /WHAT the work is trying to accomplish/);
  assert.match(policy, /WHY it matters/);
  assert.match(policy, /WHAT is happening next/);
  assert.match(policy, /at most two important topics/);
  assert.match(policy, /answer his exact last question in the first sentence/);
  assert.match(policy, /READ-ONLY/);
  assert.match(policy, /overrides the startup context snapshot/);
}

{
  assert.equal(voiceEventAudible('task_done'), false);
  assert.equal(voiceEventAudible('task_progress'), false);
  assert.equal(voiceEventAudible('task_failed'), true);
  assert.equal(voiceEventAudible('watch_pr_ready'), true);
  assert.equal(voiceEventAudible('watch_needs_input'), true);
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
    assert.equal(byName.path, realpathSync(sheet));

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
  assert.doesNotMatch(done, /Want me/);

  const truncated = agentFinishedLine({ agent: 'codex', speakAs, tail: 'A long list…', truncated: true });
  assert.match(truncated, /^The codex agent on "clearinghouse rejections remediation"/); // non-default agent IS named
  assert.match(truncated, /already pulled the complete output/);

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

{
  const full = Array.from({ length: 30 }, (_, i) => `${i + 1}. target ${i + 1} with enough detail for the complete ranked output`).join('\n');
  const preview = voiceSessionOutputPreview(full, 'stale preview', { previewChars: 200, maxItems: 3 });
  assert.equal(preview.output_truncated, true);
  assert.equal(preview.full_chars, full.length);
  assert.equal(preview.full_summary.kind, 'list');
  assert.equal(preview.full_summary.item_count, 30);
  assert.deepEqual(preview.full_summary.top_items, [
    'target 1 with enough detail for the complete ranked output',
    'target 2 with enough detail for the complete ranked output',
    'target 3 with enough detail for the complete ranked output',
  ]);
  assert.match(preview.more, /fetched automatically/);

  const shortOutput = voiceSessionOutputPreview('done', 'stale');
  assert.equal(shortOutput.latest_reply, 'done');
  assert.equal(shortOutput.output_truncated, undefined);

  assert.match(voiceAgentOutputSummary(full, { maxItems: 2 }), /^30 items\. Top results: target 1 with enough detail/);
  assert.equal(voiceAgentOutputSummary('Implemented the fix. Tests pass.'), 'Implemented the fix. Tests pass.');
  assert.equal(
    voiceAgentStartKey({ scope: 'drive-1', agent: 'Codex', project: '/repo/box', title: 'Run voice tests!' }),
    'drive-1|codex|/repo/box|run voice tests',
  );
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

  // THE FIX: the utterance being spoken at the instant of the barge-in must be in the
  // compare set. A fragment of the IN-FLIGHT sentence (what echoes back into the hot mic)
  // is then recognized as echo — before this it was absent, so the echo read as real user
  // speech and the answer stopped mid-sentence.
  const inflight = 'so the June invoice for Spectrum covers the first three hundred and thirty three bills';
  assert.equal(selfEchoMatch('the June invoice for Spectrum covers the first', [inflight]).isEcho, true);
}

{
  // Barge-in resolution policy (twin of public/voice.js): empty + self-echo → resume the
  // cut-off answer; genuine user words → honor the interruption.
  const spoken = ['so the June invoice for Spectrum covers the first three hundred and thirty three bills'];
  assert.deepEqual(shouldResumeAfterBargeIn('', spoken), { resume: true, reason: 'empty' });
  assert.deepEqual(shouldResumeAfterBargeIn('   ', spoken), { resume: true, reason: 'empty' });
  assert.equal(shouldResumeAfterBargeIn('the June invoice for Spectrum covers the first', spoken).resume, true);
  assert.equal(shouldResumeAfterBargeIn('the June invoice for Spectrum covers the first', spoken).reason, 'self_echo');
  // A real question the assistant did NOT say → honor the barge-in (do not resume).
  assert.deepEqual(shouldResumeAfterBargeIn('wait what about the Carisk clearinghouse', spoken), { resume: false, reason: 'real_words' });
  // A short real command is never mistaken for echo (min-token gate) → honored.
  assert.equal(shouldResumeAfterBargeIn('stop', spoken).resume, false);
  // No prior assistant speech → any words are real.
  assert.equal(shouldResumeAfterBargeIn('the June invoice for Spectrum', []).resume, false);
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

// ---- secret redaction (INC-1134) --------------------------------------------
{
  // Each distinctively-prefixed credential is scrubbed and counted.
  const cases = [
    ['sk-ant-api03-abcDEF0123456789ghijKLMNOP', 'anthropic-key'],
    ['sk-proj-abcDEF0123456789ghijKLMNOPqrst', 'openai-key'],
    ['ghp_ABCDEFabcdef0123456789ABCDEFabcdef01', 'github-token'],
    ['github_pat_11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwX', 'github-pat'],
    ['xoxb-1234567890-abcdefABCDEF', 'slack-token'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['AIza' + 'a1b2c3d4e5f6g7h8i9j0klmnopqrstuvwxy', 'google-api-key'], // AIza + exactly 35
    ['sk_live_abcdef0123456789ABCDEF', 'stripe-key'],
  ];
  for (const [secret, kind] of cases) {
    const r = redactSecrets(`here is the key ${secret} ok`);
    assert.equal(r.redactions, 1, `expected one redaction for ${kind}`);
    assert.ok(!r.text.includes(secret), `${kind} not scrubbed: ${r.text}`);
    assert.match(r.text, new RegExp(`\\[redacted:${kind}\\]`));
  }
}
{
  // PEM private-key block (multiline) redacted whole; Bearer keeps the scheme.
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\nDEFghi456\n-----END RSA PRIVATE KEY-----';
  const rk = redactSecrets(`before\n${pem}\nafter`);
  assert.equal(rk.redactions, 1);
  assert.ok(!rk.text.includes('MIIEabc123'));
  assert.match(rk.text, /before[\s\S]*\[redacted:private-key\][\s\S]*after/);

  const rb = redactSecrets('Authorization: Bearer abcDEF0123456789ghij');
  assert.equal(rb.redactions, 1);
  assert.match(rb.text, /Bearer \[redacted:bearer\]/);

  // DB URL keeps host/user, drops just the password.
  const ru = redactSecrets('DATABASE_URL=postgres://appuser:s3cr3tP4ssw0rd@db.internal:5432/mindbill');
  assert.ok(!ru.text.includes('s3cr3tP4ssw0rd'));
  assert.match(ru.text, /postgres:\/\/appuser:\[redacted:password\]@db\.internal/);

  // Labeled secret with a long value is scrubbed; the label stays for context.
  const rl = redactSecrets('api_key = a1b2c3d4e5f6g7h8');
  assert.equal(rl.redactions, 1);
  assert.match(rl.text, /api_key = \[redacted:secret\]/);
}
{
  // Ordinary prose is never mangled, and redaction is idempotent.
  const prose = 'The password policy is fine and the token was rotated yesterday. Total: 42 bills.';
  const r1 = redactSecrets(prose);
  assert.equal(r1.redactions, 0);
  assert.equal(r1.text, prose);
  // Empty/nullish input is safe.
  assert.deepEqual(redactSecrets(''), { text: '', redactions: 0 });
  assert.deepEqual(redactSecrets(null), { text: '', redactions: 0 });
  // Running it twice changes nothing (markers contain no secret shapes).
  const once = redactSecrets('key: ghp_ABCDEFabcdef0123456789ABCDEFabcdef01').text;
  assert.equal(redactSecrets(once).redactions, 0);
}

// ---- transcript turn extraction (INC-1134) ----------------------------------
{
  // Claude JSONL → ordered user+assistant text turns; tool-only + meta lines dropped.
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'rank the top prospects' }, timestamp: 't1' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Here are the top three.' }] }, timestamp: 't2' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'noise' }] } }), // tool-only → skip
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-message>meta</command-message>' } }), // meta → skip
    'not json', // junk → skip
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Second reply.' }] }, timestamp: 't3' }),
  ].join('\n');
  const turns = claudeTurnsFromJsonl(jsonl);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'assistant']);
  assert.equal(turns[0].text, 'rank the top prospects');
  assert.equal(turns[1].text, 'Here are the top three.'); // thinking block excluded
  assert.equal(turns[0].ts, 't1');
  // Empty / non-string input is safe.
  assert.deepEqual(claudeTurnsFromJsonl(''), []);
  assert.deepEqual(claudeTurnsFromJsonl(null), []);
}
{
  // Codex sidecar messages (content string, parts array, plain text) → turns.
  const msgs = [
    { role: 'user', content: 'find billers on daisyBill', ts: 1 },
    { role: 'assistant', parts: [{ t: 'text', text: 'Found 12 candidates.' }], ts: 2 },
    { role: 'tool', content: 'ignored' },
    { role: 'assistant', text: 'Ranked them by size.', ts: 3 },
  ];
  const turns = codexTurnsFromMessages(msgs);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].text, 'find billers on daisyBill');
  assert.equal(turns[1].text, 'Found 12 candidates.');
  assert.equal(turns[2].text, 'Ranked them by size.');
  assert.deepEqual(codexTurnsFromMessages(null), []);
}

// ---- buildTranscriptView (INC-1134) -----------------------------------------
{
  const turns = [
    { role: 'user', text: 'first ask', ts: 1 },
    { role: 'assistant', text: 'first answer', ts: 2 },
    { role: 'user', text: 'second ask with a token ghp_ABCDEFabcdef0123456789ABCDEFabcdef01', ts: 3 },
    { role: 'assistant', text: 'second answer', ts: 4 },
  ];
  // prompts mode: user turns only, redacted, in order.
  const p = buildTranscriptView(turns, { include: 'prompts' });
  assert.equal(p.mode, 'prompts');
  assert.equal(p.prompt_count, 2);
  assert.equal(p.total_prompts, 2);
  assert.equal(p.turn_count, 4);
  assert.equal(p.prompts[0].text, 'first ask');
  assert.ok(!p.prompts[1].text.includes('ghp_'));
  assert.equal(p.redactions, 1);

  // prompts mode honours limit + truncated flag.
  const many = Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: `ask ${i}` }));
  const lim = buildTranscriptView(many, { include: 'prompts', limit: 3 });
  assert.equal(lim.prompt_count, 3);
  assert.equal(lim.total_prompts, 10);
  assert.equal(lim.truncated, true);
  assert.equal(lim.prompts[2].text, 'ask 9'); // keeps the most recent

  // full mode: paginated role-labelled transcript, secrets scrubbed, all turns counted.
  const f = buildTranscriptView(turns, { include: 'full', pageSize: 200 });
  assert.equal(f.mode, 'full');
  assert.equal(f.turn_count, 4);
  assert.equal(f.redactions, 1);
  assert.ok(f.total_pages >= 1);
  assert.equal(f.page, 1);
  // Reassemble every page and confirm both roles + no leaked secret.
  let joined = '';
  for (let i = 1; i <= f.total_pages; i++) joined += (joined ? '\n' : '') + buildTranscriptView(turns, { include: 'full', page: i, pageSize: 200 }).text;
  assert.match(joined, /user: first ask/);
  assert.match(joined, /assistant: second answer/);
  assert.ok(!joined.includes('ghp_'));

  // redact:false leaves text intact (for callers that scrub elsewhere).
  assert.equal(buildTranscriptView(turns, { include: 'prompts', redact: false }).redactions, 0);
  // Empty input is safe.
  const empty = buildTranscriptView([], { include: 'full' });
  assert.equal(empty.turn_count, 0);
  assert.equal(empty.total_pages, 1);
}

console.log('voice-assistant helpers ok');
