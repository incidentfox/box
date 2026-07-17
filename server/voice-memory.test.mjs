import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoiceMemory } from './voice-memory.mjs';

const root = mkdtempSync(join(tmpdir(), 'box-voice-memory-'));
const DAY = 24 * 60 * 60 * 1000;

// Controllable clock so retention/aging is deterministic. Anchor it to real wall time so
// the module's logical cutoff stays consistent with the real filesystem mtimes of audio
// clips and transcript files (which the purge ages by mtime, as it does in production).
let clock = Date.now();
const now = () => clock;

// A fake transcriber for the re-transcription path.
let transcribeCalls = 0;
const transcribe = async (buf) => { transcribeCalls++; return { text: `recovered ${buf.length}b`, model: 'fake:test' }; };

const turns = (n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  text: i % 2 ? 'Understood, I will look into daisyBill pricing.' : `We should decide on the Spectrum invoice rounding issue ${i}`,
  ts: clock + i * 1000,
}));

try {
  const dir = join(root, 'memory');
  const transcriptsDir = join(root, 'transcripts');
  mkdirSync(transcriptsDir, { recursive: true });
  const mem = createVoiceMemory({ dir, transcriptsDir, now, transcribe });

  // ---- 1. privacy-safe defaults + consent gating --------------------------
  {
    const c = mem.getConfig();
    assert.equal(c.consent, 'unset', 'default consent is unset');
    assert.equal(c.storeAudio, false, 'audio off by default');
    assert.equal(mem.memoryOn(), false, 'memory off until consent');
    assert.equal(mem.retrievalOn(), false, 'retrieval off until consent');

    const r = mem.indexSession('vs-blocked', turns(6));
    assert.equal(r.skipped, 'consent', 'indexing is a no-op without consent');
    assert.equal(mem.allRecords().length, 0, 'nothing stored without consent');
    assert.deepEqual(mem.retrieve({ query: 'Spectrum' }), [], 'retrieval empty without consent');
  }

  // ---- 2. consent → indexing + retrieval ----------------------------------
  {
    mem.setConsent('granted', 'test');
    assert.equal(mem.memoryOn(), true);
    assert.equal(mem.retrievalOn(), true);

    const r = mem.indexSession('vs-spectrum', turns(8), { source: 'transcript' });
    assert.equal(r.indexed, true);
    assert.equal(mem.allRecords().length, 1);
    const rec = mem.readRecord('vs-spectrum');
    assert.ok(rec.summary.length > 0, 'record has a summary');
    assert.ok(rec.keywords.includes('spectrum') || rec.keywords.includes('daisybill'), 'keywords extracted from content');
    assert.ok(rec.decisions.length > 0, 'decision lines captured ("we should decide…")');
    // no verbatim full transcript stored — just a bounded summary
    assert.ok(rec.summary.length <= 701, 'summary is bounded');
  }

  // ---- 3. too-short sessions are skipped -----------------------------------
  {
    const r = mem.indexSession('vs-tiny', turns(1));
    assert.ok(r.skipped, 'a 1-turn session is not worth remembering');
    assert.equal(mem.readRecord('vs-tiny'), null);
  }

  // ---- 4. retrieval: relevance, scoping, cap -------------------------------
  {
    // add a second, unrelated session
    mem.indexSession('vs-psych', [
      { role: 'user', text: 'Remember to follow up on the Rise4 psychiatry VOB automation demo', ts: clock },
      { role: 'assistant', text: 'Noted, Rise4 voice VOB for psychiatry.', ts: clock + 1 },
      { role: 'user', text: 'And the Bay Area Psychiatric Spravato monitoring form', ts: clock + 2 },
    ]);

    const hits = mem.retrieve({ query: 'Spectrum invoice rounding' });
    assert.ok(hits.length >= 1, 'query returns matches');
    assert.equal(hits[0].vsid, 'vs-spectrum', 'most relevant session ranks first');

    const excl = mem.retrieve({ query: 'Spectrum', excludeVsid: 'vs-spectrum' });
    assert.ok(!excl.some((r) => r.vsid === 'vs-spectrum'), 'excludeVsid removes the current session');

    // cap: create many sessions, ensure retrieve honours maxRetrievalSessions
    mem.updateConfig({ maxRetrievalSessions: 2 }, 'test');
    for (let i = 0; i < 6; i++) mem.indexSession('vs-bulk-' + i, turns(4));
    const capped = mem.retrieve({ query: 'Spectrum invoice' });
    assert.ok(capped.length <= 2, 'retrieval is capped at maxRetrievalSessions');
  }

  // ---- 5. renderPreload is bounded + text-only -----------------------------
  {
    const block = mem.renderPreload(mem.retrieve({ query: 'Spectrum' }), 1800);
    assert.match(block, /MEMORY FROM PRIOR VOICE SESSIONS/);
    assert.ok(block.length <= 1800, 'preload block is length-bounded');
  }

  // ---- 6. audio gating + store + re-transcribe -----------------------------
  {
    const denied = mem.storeAudioClip('vs-spectrum', Buffer.from('fake-audio'), 'audio/webm');
    assert.equal(denied.skipped, 'audio_consent', 'audio blocked until the separate opt-in');

    mem.updateConfig({ storeAudio: true }, 'test');
    assert.equal(mem.audioOn(), true);
    const stored = mem.storeAudioClip('vs-spectrum', Buffer.from('fake-audio-bytes'), 'audio/webm', {
      seq: 0, role: 'caller', startedAt: clock - 1000, capturedAt: clock,
    });
    assert.equal(stored.stored, true);
    assert.equal(mem.listAudioClips('vs-spectrum').length, 1);
    const storedAudit = mem.readAudit(1)[0];
    assert.equal(storedAudit.role, 'caller', 'capture side is retained for call reconstruction');
    assert.equal(storedAudit.capturedAt, clock, 'capture timestamp is retained for latency analysis');

    const clip = mem.listAudioClips('vs-spectrum')[0].clip;
    const rt = await mem.retranscribeClip('vs-spectrum', clip);
    assert.equal(transcribeCalls, 1, 'transcriber invoked');
    assert.match(rt.text, /recovered/, 'returns recovered transcript from audio');

    // per-session clip cap prunes oldest
    mem.updateConfig({ maxAudioClipsPerSession: 3 }, 'test');
    for (let i = 0; i < 5; i++) mem.storeAudioClip('vs-spectrum', Buffer.from('c' + i), 'audio/webm');
    assert.ok(mem.listAudioClips('vs-spectrum').length <= 3, 'clip count capped per session');
  }

  // ---- 7. retention purge (aged data) --------------------------------------
  {
    mem.updateConfig({ retentionDays: 30 }, 'test');
    const before = mem.stats();
    assert.ok(before.sessions > 0 && before.audioClips > 0);

    // jump 40 days forward: everything so far is now older than the 30-day window
    clock += 40 * DAY;
    // a fresh session lands AFTER the jump, so it must survive the purge
    mem.indexSession('vs-fresh', turns(6));
    // a raw transcript file older than the window should also be swept
    writeFileSync(join(transcriptsDir, 'old-session.jsonl'), '{"kind":"meta"}\n');

    const purged = mem.purgeExpired();
    assert.ok(purged.sessions >= before.sessions, 'aged session records purged');
    assert.ok(purged.audioDirs >= 1, 'aged audio dirs purged');
    assert.equal(mem.readRecord('vs-spectrum'), null, 'the aged session is gone');
    assert.ok(mem.readRecord('vs-fresh'), 'the fresh session survives retention');
  }

  // ---- 8. purge-all (forget everything) ------------------------------------
  {
    mem.indexSession('vs-keepme', turns(6));
    writeFileSync(join(transcriptsDir, 'vs-keepme.jsonl'), '{"kind":"user","text":"hi"}\n');
    const res = mem.purgeAll('test');
    assert.ok(res.sessions >= 1);
    assert.equal(mem.allRecords().length, 0, 'all session records wiped');
    assert.equal(mem.stats().audioClips, 0, 'all audio wiped');
    assert.equal(readdirSync(transcriptsDir).length, 0, 'raw transcripts wiped too');
    // consent choice is preserved through a purge (data gone, setting kept)
    assert.equal(mem.getConfig().consent, 'granted');
  }

  // ---- 9. config clamping --------------------------------------------------
  {
    mem.updateConfig({ retentionDays: 9999 }, 'test');
    assert.equal(mem.getConfig().retentionDays, 365, 'retentionDays clamped to 365');
    mem.updateConfig({ retentionDays: 0 }, 'test');
    assert.equal(mem.getConfig().retentionDays, 1, 'retentionDays clamped to >= 1');
    mem.updateConfig({ maxRetrievalSessions: 999 }, 'test');
    assert.equal(mem.getConfig().maxRetrievalSessions, 10, 'maxRetrievalSessions clamped');
  }

  // ---- 10. audit log: events recorded, NO verbatim transcript text ---------
  {
    const events = mem.readAudit(500);
    const kinds = new Set(events.map((e) => e.event));
    for (const need of ['consent', 'index', 'retrieve', 'audio_store', 'retranscribe', 'purge_expired', 'purge_all', 'config']) {
      assert.ok(kinds.has(need), `audit records "${need}" events`);
    }
    // privacy: the audit trail must not leak the actual conversation text
    const blob = JSON.stringify(events);
    assert.ok(!/Spectrum invoice rounding issue/.test(blob), 'audit log contains no verbatim transcript text');
    assert.ok(!/recovered \d+b/.test(blob), 'audit log contains no re-transcribed text');
  }

  console.log('voice-memory.test.mjs passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
