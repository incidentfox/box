import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectListItems,
  paginateText,
  sanitizeVoiceEvent,
  summarizeAgentOutput,
  voiceFileAccessPolicy,
  voiceBool,
  voiceResponseStyle,
  voiceTurnDetectionConfig,
} from './voice-assistant.mjs';

assert.equal(voiceBool(undefined, true), true);
assert.equal(voiceBool('1'), true);
assert.equal(voiceBool('yes'), true);
assert.equal(voiceBool('0'), false);
assert.equal(voiceBool('off'), false);

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

console.log('voice-assistant helpers ok');
