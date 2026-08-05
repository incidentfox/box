import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildVobSnapshot, resolveVobAudio } from './vob-observability.mjs';

const event = (at, type, extra = {}) => JSON.stringify({ at, type, ...extra });

test('builds a linked VOB snapshot with timestamped transcript and call phases', () => {
  const root = mkdtempSync(join(tmpdir(), 'box-vob-'));
  const caseDir = join(root, 'case-fixture');
  const runtime = join(caseDir, 'runtime', 'attempt-1', 'livekit');
  const eventsDir = join(runtime, 'events');
  const recordingsDir = join(runtime, 'recordings');
  const callId = 'call-abc';
  try {
    mkdirSync(eventsDir, { recursive: true });
    mkdirSync(recordingsDir, { recursive: true });
    writeFileSync(join(caseDir, 'operator-context.private.json'), JSON.stringify({
      schemaVersion: 1, sessionId: 'box-session-1', requestId: 'request-1', payerName: 'Fixture Payer',
    }));
    writeFileSync(join(caseDir, 'operator-owner.private.json'), JSON.stringify({ sessionId: 'box-session-1' }));
    writeFileSync(join(caseDir, 'operator-launch.private.json'), JSON.stringify({ sessionId: 'box-session-1' }));
    writeFileSync(join(caseDir, 'operator-ledger.private.json'), JSON.stringify({
      requestId: 'request-1', calls: [{ callId, sequence: 1, kind: 'benefits', focusFields: ['deductible'], runtime: 'runtime/attempt-1' }],
    }));
    writeFileSync(join(caseDir, 'operator-result.private.json'), JSON.stringify({
      status: 'in_progress', aggregateEvidence: { facts: [{ key: 'deductible', status: 'confirmed', value: '$500', sourceCallId: callId }] },
    }));
    writeFileSync(join(join(eventsDir, `${callId}.private.jsonl`)), [
      event('2026-08-05T10:00:00.000Z', 'mixed_recording_configured'),
      event('2026-08-05T10:00:02.000Z', 'controller_phase', { phase: 'ivr' }),
      event('2026-08-05T10:00:04.000Z', 'dtmf_sent', { digit: '1' }),
      event('2026-08-05T10:00:07.000Z', 'hold_audio_detected'),
      event('2026-08-05T10:00:12.000Z', 'hold_audio_ended'),
      event('2026-08-05T10:00:14.000Z', 'live_agent_activated'),
      event('2026-08-05T10:00:15.000Z', 'conversation_item_added', { role: 'assistant', text: 'Rep said hello' }),
      event('2026-08-05T10:00:20.000Z', 'sip_end_action_terminated'),
    ].join('\n') + '\n');
    writeFileSync(join(recordingsDir, `${callId}.mixed.private.ogg`), 'fixture');

    const session = { id: 'box-session-1', cwd: caseDir };
    const snapshot = buildVobSnapshot({ sessionId: session.id, session, root });
    assert.equal(snapshot.linked, true);
    assert.equal(snapshot.payerName, 'Fixture Payer');
    assert.equal(snapshot.ledger[0].attemptStatus, 'recorded');
    assert.equal(snapshot.facts[0].value, '$500');
    assert.equal(snapshot.attempts[0].transcript[0].text, 'Rep said hello');
    assert.equal(snapshot.attempts[0].transcript[0].startSec, 15);
    assert.deepEqual(snapshot.attempts[0].segments.map((segment) => segment.label), ['unknown', 'ivr', 'hold', 'unknown', 'human']);
    assert.equal(snapshot.attempts[0].segments[1].startSec, 2);
    assert.equal(snapshot.attempts[0].segments[2].endSec, 12);
    assert.equal(resolveVobAudio({ sessionId: session.id, session, callId, root }).path, join(recordingsDir, `${callId}.mixed.private.ogg`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
