import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildVobSnapshot, classifyEvents, findVobCase, resolveVobAudio } from './vob-observability.mjs';

const event = (at, type, extra = {}) => JSON.stringify({ at, type, ...extra });

test('builds a linked VOB snapshot with timestamped transcript and call phases', () => {
  const root = mkdtempSync(join(tmpdir(), 'box-vob-'));
  const caseDir = join(root, 'case-fixture');
  const runtime = join(caseDir, 'runtime', 'attempt-1', 'livekit');
  const eventsDir = join(runtime, 'events');
  const launchesDir = join(runtime, 'launches');
  const recordingsDir = join(runtime, 'recordings');
  const callId = 'livekit_call-abc';
  const artifactId = 'call-abc';
  try {
    mkdirSync(eventsDir, { recursive: true });
    mkdirSync(launchesDir, { recursive: true });
    mkdirSync(recordingsDir, { recursive: true });
    writeFileSync(join(caseDir, 'operator-context.private.json'), JSON.stringify({
      schemaVersion: 1, sessionId: 'box-session-1', requestId: 'request-1', payerName: 'Fixture Payer',
    }));
    writeFileSync(join(caseDir, 'operator-owner.private.json'), JSON.stringify({ sessionId: 'box-session-1' }));
    writeFileSync(join(caseDir, 'operator-launch.private.json'), JSON.stringify({ sessionId: 'box-session-1' }));
    writeFileSync(join(caseDir, 'operator-ledger.private.json'), JSON.stringify({
      requestId: 'request-1', calls: [{
        callId, sequence: 1, kind: 'benefits', focusFields: ['deductible'], runtime: 'runtime/attempt-1',
        liveKitRoot: 'runtime/attempt-1/livekit', roomPrefix: 'fixture-room-',
      }],
    }));
    writeFileSync(join(caseDir, 'operator-result.private.json'), JSON.stringify({
      status: 'in_progress', aggregateEvidence: { facts: [{ key: 'deductible', status: 'confirmed', value: '$500', sourceCallId: callId }] },
    }));
    writeFileSync(join(join(eventsDir, `${artifactId}.private.jsonl`)), [
      event('2026-08-05T10:00:00.000Z', 'mixed_recording_configured'),
      event('2026-08-05T10:00:02.000Z', 'controller_phase', { phase: 'ivr' }),
      event('2026-08-05T10:00:04.000Z', 'dtmf_sent', { digit: '1' }),
      event('2026-08-05T10:00:07.000Z', 'hold_audio_detected'),
      event('2026-08-05T10:00:12.000Z', 'hold_audio_ended'),
      event('2026-08-05T10:00:14.000Z', 'live_agent_activated'),
      event('2026-08-05T10:00:15.000Z', 'conversation_item_added', { role: 'assistant', text: 'Rep said hello' }),
      event('2026-08-05T10:00:20.000Z', 'sip_end_action_terminated'),
    ].join('\n') + '\n');
    writeFileSync(join(launchesDir, `${artifactId}.private.json`), JSON.stringify({
      roomName: 'fixture-livekit-room', token: artifactId,
    }));
    writeFileSync(join(recordingsDir, `${artifactId}.mixed.private.ogg`), 'fixture');

    const session = { id: 'box-session-1', cwd: caseDir };
    const snapshot = buildVobSnapshot({ sessionId: session.id, session, root });
    assert.equal(snapshot.linked, true);
    assert.equal(snapshot.payerName, 'Fixture Payer');
    assert.equal(snapshot.ledger[0].attemptStatus, 'recorded');
    assert.equal(snapshot.ledger[0].fields[0].key, 'deductible');
    assert.equal(snapshot.ledger[0].fields[0].status, 'confirmed');
    assert.equal(snapshot.ledger[0].fields[0].value, '$500');
    assert.equal(snapshot.facts[0].value, '$500');
    assert.equal(snapshot.attempts[0].transcript[0].text, 'Rep said hello');
    assert.equal(snapshot.attempts[0].transcript[0].startSec, 15);
    assert.equal(snapshot.attempts[0].roomName, 'fixture-livekit-room');
    assert.deepEqual(snapshot.attempts[0].segments.map((segment) => segment.label), ['unknown', 'ivr', 'hold', 'unknown', 'human']);
    assert.equal(snapshot.attempts[0].segments[1].startSec, 2);
    assert.equal(snapshot.attempts[0].segments[2].endSec, 12);
    assert.equal(resolveVobAudio({ sessionId: session.id, session, callId, root }).path, join(recordingsDir, `${artifactId}.mixed.private.ogg`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('speech cues correct a stale human phase for hold prompts', () => {
  const baseAt = Date.parse('2026-08-05T10:00:00.000Z');
  const data = classifyEvents([
    { at: '2026-08-05T10:00:01.000Z', type: 'live_agent_activated' },
    { at: '2026-08-05T10:00:02.000Z', type: 'conversation_item_added', role: 'assistant', text: 'Please hold while I pull that up.' },
    { at: '2026-08-05T10:00:08.000Z', type: 'conversation_item_added', role: 'assistant', text: 'I can help with that.' },
  ], baseAt);
  assert.deepEqual(data.transcript.map((row) => row.phase), ['hold', 'human']);
  assert.deepEqual(data.segments.map((segment) => segment.label), ['human', 'hold', 'human']);
});

test('resolves nested and legacy session artifacts and backfills result-only ledger rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'box-vob-legacy-'));
  const legacyRoot = mkdtempSync(join(tmpdir(), 'box-vob-result-only-'));
  const requestId = 'rise4_0123456789abcdef0123456789abcdef';
  const ownerOnly = join(root, requestId);
  const complete = join(root, `${requestId}_test_3`);
  const legacy = join(legacyRoot, 'legacy-case');
  try {
    mkdirSync(ownerOnly, { recursive: true });
    mkdirSync(complete, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(ownerOnly, 'workspace', 'work', 'automation'), { recursive: true });
    writeFileSync(join(ownerOnly, 'operator-owner.private.json'), JSON.stringify({
      requestId: `${requestId}_test_3`, rootRequestId: requestId, metadata: { sessionId: 'nested-session' },
    }));
    writeFileSync(join(complete, 'operator-context.private.json'), JSON.stringify({
      requestId: `${requestId}_test_3`, rootRequestId: requestId, metadata: { resumedOperatorSessionId: 'nested-session' }, payerName: 'Legacy Fixture',
    }));
    writeFileSync(join(complete, 'operator-launch.private.json'), JSON.stringify({ requestId: `${requestId}_test_3`, session: { boxSessionId: 'nested-session' } }));
    writeFileSync(join(complete, 'operator-ledger.private.json'), JSON.stringify({ requestId: `${requestId}_test_3`, calls: [] }));
    writeFileSync(join(complete, 'operator-result.private.json'), JSON.stringify({
      callIds: ['livekit_legacy-call'], aggregateEvidence: { facts: [{ key: 'plan.status', status: 'confirmed', value: 'active', sourceCallId: 'livekit_legacy-call' }] },
    }));

    const match = findVobCase({ sessionId: 'nested-session', session: { cwd: join(ownerOnly, 'workspace', 'work', 'automation') }, root, requestIds: [requestId] });
    assert.equal(match.caseDir, complete);
    assert.equal(match.link, 'request-id');
    const snapshot = buildVobSnapshot({ sessionId: 'nested-session', root, requestIds: [requestId] });
    assert.equal(snapshot.linked, true);
    assert.equal(snapshot.payerName, 'Legacy Fixture');
    assert.equal(snapshot.ledger.length, 1);
    assert.equal(snapshot.ledger[0].callId, 'livekit_legacy-call');
    assert.equal(snapshot.ledger[0].fields[0].value, 'active');
    assert.equal(snapshot.dataQuality.backfilled, true);

    writeFileSync(join(legacy, 'operator-context.private.json'), JSON.stringify({ requestId, payerName: 'Result Only' }));
    writeFileSync(join(legacy, 'operator-result.private.json'), JSON.stringify({ callIds: ['call-result-only'], aggregateEvidence: { facts: [] } }));
    const legacySnapshot = buildVobSnapshot({ sessionId: 'unrelated-session', root: legacyRoot, requestIds: [requestId] });
    assert.equal(legacySnapshot.payerName, 'Result Only');
    assert.equal(legacySnapshot.ledger[0].callId, 'call-result-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});
