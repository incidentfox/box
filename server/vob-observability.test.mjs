import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildVobSnapshot, classifyEvents, findVobCase, resolveVobAudio } from './vob-observability.mjs';
import { VOB_PRODUCTION_PROMPT_SOURCE, VOB_PRODUCTION_PROMPT_VERSION } from './vob-production-prompt.mjs';
import { VOB_PIPELINE_VERSION } from './vob-pipeline.mjs';

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
        liveKitRoot: 'runtime/attempt-1/livekit', roomPrefix: 'fixture-room-', packetPath: 'calls/call-1/packet.private.json',
      }],
    }));
    mkdirSync(join(caseDir, 'calls', 'call-1'), { recursive: true });
    writeFileSync(join(caseDir, 'calls', 'call-1', 'packet.private.json'), JSON.stringify({
      patient: { name: 'Jordan Cissell', memberId: 'G4P591M89472', dob: '1990-12-10', groupNumber: 'GRP-42' },
      service: { requestedCodes: ['90834'] },
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
    assert.equal(snapshot.packetFacts, undefined);
    const testSnapshot = buildVobSnapshot({ sessionId: session.id, session, root, includePacketFacts: true });
    assert.equal(testSnapshot.packetFacts.find((fact) => fact.key === 'patient.memberId').value, 'G4P591M89472');
    assert.equal(testSnapshot.packetFacts.find((fact) => fact.key === 'patient.name').value, 'Jordan Cissell');
    assert.equal(testSnapshot.prompt.source, VOB_PRODUCTION_PROMPT_SOURCE);
    assert.equal(testSnapshot.prompt.version, VOB_PRODUCTION_PROMPT_VERSION);
    assert.match(testSnapshot.prompt.baseText, /OUTPUT CONTRACT/);
    assert.match(testSnapshot.prompt.compiledText, /CALL DATA/);
    assert.equal(testSnapshot.pipeline.version, VOB_PIPELINE_VERSION);
    assert.equal(testSnapshot.pipeline.ledger.prompt, null);
    assert.match(testSnapshot.pipeline.extractor.promptTemplate, /payer-side turns/);
    assert.equal(snapshot.pipeline, undefined);
    assert.deepEqual(snapshot.attempts[0].segments.map((segment) => segment.label), ['unknown', 'ivr', 'hold', 'unknown', 'human']);
    assert.equal(snapshot.attempts[0].segments[1].startSec, 2);
    assert.equal(snapshot.attempts[0].segments[2].endSec, 12);
    assert.equal(resolveVobAudio({ sessionId: session.id, session, callId, root }).path, join(recordingsDir, `${artifactId}.mixed.private.ogg`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shows one cumulative ledger from validated evidence across call attempts', () => {
  const root = mkdtempSync(join(tmpdir(), 'box-vob-cumulative-'));
  const caseDir = join(root, 'case-fixture');
  const calls = [
    { callId: 'livekit_call-one', sequence: 1, kind: 'initial', focusFields: ['plan.status', 'benefit.copay'], liveKitRoot: 'runtime/attempt-1/livekit' },
    { callId: 'livekit_call-two', sequence: 2, kind: 'followup', focusFields: ['benefit.copay', 'provider.network'], liveKitRoot: 'runtime/attempt-2/livekit' },
  ];
  try {
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, 'operator-context.private.json'), JSON.stringify({ sessionId: 'cumulative-session' }));
    writeFileSync(join(caseDir, 'operator-owner.private.json'), JSON.stringify({ sessionId: 'cumulative-session' }));
    writeFileSync(join(caseDir, 'operator-ledger.private.json'), JSON.stringify({ calls }));
    for (const [index, token] of ['call-one', 'call-two'].entries()) {
      const evidenceDir = join(caseDir, 'runtime', `attempt-${index + 1}`, 'livekit', 'evidence');
      mkdirSync(evidenceDir, { recursive: true });
      const facts = index === 0
        ? [
          { key: 'plan.status', status: 'confirmed', value: 'Active', evidence: [{ quote: 'active' }] },
          { key: 'benefit.copay', status: 'confirmed', value: '$40', evidence: [{ quote: 'forty dollars' }] },
        ]
        : [
          { key: 'plan.status', status: 'missing', value: '', evidence: [] },
          { key: 'benefit.copay', status: 'confirmed', value: '$25', evidence: [{ quote: 'twenty-five dollars' }] },
          { key: 'provider.network', status: 'missing', value: '', evidence: [] },
        ];
      writeFileSync(join(evidenceDir, `${token}.private.json`), JSON.stringify({ evidence: { facts } }));
    }

    const snapshot = buildVobSnapshot({ sessionId: 'cumulative-session', session: { cwd: caseDir }, root });
    assert.equal(snapshot.ledger.length, 1);
    assert.equal(snapshot.ledger[0].kind, 'cumulative');
    assert.equal(snapshot.ledger[0].attemptCount, 2);
    assert.equal(snapshot.ledger[0].callId, 'livekit_call-two');
    assert.deepEqual(snapshot.ledger[0].fields.map((field) => [field.key, field.status, field.value]), [
      ['plan.status', 'confirmed', 'Active'],
      ['benefit.copay', 'confirmed', '$25'],
      ['provider.network', 'pending', null],
    ]);
    assert.equal(snapshot.facts.find((fact) => fact.key === 'benefit.copay').sourceCallIds[0], 'livekit_call-two');
    assert.equal(snapshot.dataQuality.ledgerCalls, 2);
    assert.equal(snapshot.dataQuality.fieldsWithValues, 2);
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

test('hydrates packets from the production sibling packets root without allowing arbitrary paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'box-vob-packet-root-'));
  const caseDir = join(root, 'case-fixture');
  const packetDir = join(root, 'packets', 'call-1');
  try {
    mkdirSync(caseDir, { recursive: true });
    mkdirSync(packetDir, { recursive: true });
    writeFileSync(join(caseDir, 'operator-context.private.json'), JSON.stringify({ sessionId: 'packet-session' }));
    writeFileSync(join(caseDir, 'operator-owner.private.json'), JSON.stringify({ sessionId: 'packet-session' }));
    writeFileSync(join(caseDir, 'operator-ledger.private.json'), JSON.stringify({
      calls: [{ callId: 'livekit_packet-call', packetPath: '../packets/call-1/packet.private.json' }],
    }));
    writeFileSync(join(caseDir, 'operator-result.private.json'), JSON.stringify({}));
    writeFileSync(join(packetDir, 'packet.private.json'), JSON.stringify({ patient: { memberId: 'SIBLING-42' } }));

    const snapshot = buildVobSnapshot({ sessionId: 'packet-session', session: { cwd: caseDir }, root, includePacketFacts: true });
    assert.equal(snapshot.packetFacts.find((fact) => fact.key === 'patient.memberId').value, 'SIBLING-42');

    writeFileSync(join(caseDir, 'operator-ledger.private.json'), JSON.stringify({
      calls: [{ callId: 'livekit_packet-call', packetPath: '/tmp/packet-outside-case.json' }],
    }));
    assert.deepEqual(buildVobSnapshot({ sessionId: 'packet-session', session: { cwd: caseDir }, root, includePacketFacts: true }).packetFacts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
