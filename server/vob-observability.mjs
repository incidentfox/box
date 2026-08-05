import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

// VOB operator artifacts are deliberately kept outside the Box checkout.  This
// module is the narrow, read-only bridge between those artifacts and the owner-only
// observability surface.
export const DEFAULT_VOB_ROOT = '/home/factory/.factory/rise4-vob/production/operators';
const TERMINAL_EVENTS = new Set([
  'sip_end_action_terminated',
  'sip_end_action_termination_failed',
  'live_close_gate_terminated',
  'live_close_gate_termination_failed',
  'sip_participant_disconnected',
]);
const MAX_TRANSCRIPT_ROWS = 1200;
const MAX_TEXT_LENGTH = 2400;

function jsonFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function jsonlFile(path) {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function safeReal(path) {
  try { return realpathSync(path); } catch { return null; }
}

function inside(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.includes('\\'));
}

function caseDirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9._-]+$/.test(entry.name))
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

function findCaseFromCwd(cwd, root) {
  const realRoot = safeReal(root);
  const realCwd = safeReal(cwd);
  if (!realRoot || !realCwd || !inside(realCwd, realRoot)) return null;
  const rel = relative(realRoot, realCwd).split('/');
  if (!rel[0] || rel[0].includes('..')) return null;
  const candidate = join(realRoot, rel[0]);
  return existsSync(join(candidate, 'operator-context.private.json')) ? candidate : null;
}

function sessionIdInArtifact(value, sessionId) {
  if (!value || typeof value !== 'object') return false;
  return [value.sessionId, value.resumedOperatorSessionId, value.boxSessionId]
    .some((candidate) => candidate && String(candidate) === String(sessionId));
}

function findCaseFromArtifacts(sessionId, root) {
  const matches = [];
  for (const candidate of caseDirectories(root)) {
    for (const filename of ['operator-owner.private.json', 'operator-launch.private.json', 'operator-context.private.json']) {
      const value = jsonFile(join(candidate, filename));
      if (sessionIdInArtifact(value, sessionId)) { matches.push(candidate); break; }
    }
  }
  return [...new Set(matches)];
}

export function findVobCase({ sessionId, session = null, root = DEFAULT_VOB_ROOT } = {}) {
  const configuredRoot = resolve(root);
  const cwdMatch = findCaseFromCwd(session && session.cwd, configuredRoot);
  if (cwdMatch) return { caseDir: cwdMatch, link: 'cwd' };
  const artifactMatches = findCaseFromArtifacts(sessionId, configuredRoot);
  if (artifactMatches.length === 1) return { caseDir: artifactMatches[0], link: 'artifact' };
  if (artifactMatches.length > 1) return { ambiguous: true, matches: artifactMatches.length };
  return null;
}

function walkFiles(dir, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path, depth + 1));
    else files.push(path);
  }
  return files;
}

function attemptFiles(caseDir, callId, runtimeHint = '') {
  const runtimeRoot = join(caseDir, 'runtime');
  const files = walkFiles(runtimeRoot).filter((path) => inside(path, caseDir));
  const rawNeedle = String(callId || '');
  // LiveKit ledger IDs are prefixed (`livekit_<recording-hash>`), while the
  // private artifact filenames intentionally contain only the opaque hash.
  // Accept both forms without weakening the case-root boundary checks below.
  const needles = [...new Set([rawNeedle, rawNeedle.replace(/^livekit_/, '')].filter(Boolean))];
  const hinted = runtimeHint && inside(resolve(caseDir, runtimeHint), caseDir)
    ? walkFiles(resolve(caseDir, runtimeHint))
    : [];
  const all = [...new Set([...hinted, ...files])];
  const matching = all.filter((path) => needles.some((needle) => basename(path).startsWith(`${needle}.`) || basename(path).startsWith(`${needle}-`)));
  const events = matching.filter((path) => path.endsWith('.jsonl'));
  const recordings = matching.filter((path) => /recordings/.test(path) && /\.(wav|ogg|mp3|m4a)$/i.test(path));
  return { events, recordings };
}

function eventTime(event) {
  const value = Date.parse(event && event.at);
  return Number.isFinite(value) ? value : null;
}

function textOf(value) {
  return String(value || '').trim().slice(0, MAX_TEXT_LENGTH);
}

function eventExplicitLabel(event) {
  const type = String(event.type || '').toLowerCase();
  const phase = String(event.phase || '').toLowerCase();
  const action = String(event.action || '').toLowerCase();
  const all = `${type} ${phase} ${action}`;
  if (type === 'hold_audio_ended' || type === 'hold_queue_ended') return 'unknown';
  if (all.includes('hold') || all.includes('queue') || all.includes('music')) return 'hold';
  if (type === 'live_agent_activated' || type === 'live_agent_activation_scheduled' || all.includes('human') || all.includes('representative') || all.includes('live_conversation')) return 'human';
  if (all.includes('ivr') || type === 'dtmf_sent') return 'ivr';
  return null;
}

function classifyEvents(events, baseAt) {
  let current = 'unknown';
  const transcript = [];
  const labeled = [];
  for (const event of events) {
    const at = eventTime(event);
    if (at == null) continue;
    const explicit = eventExplicitLabel(event);
    let label = explicit;
    if (event.type === 'conversation_item_added') {
      label = current === 'human' ? 'human' : current === 'ivr' ? 'ivr' : 'unknown';
      const text = textOf(event.text);
      if (text) transcript.push({
        at: event.at,
        startSec: Math.max(0, (at - baseAt) / 1000),
        role: String(event.role || 'unknown'),
        text,
        interrupted: !!event.interrupted,
      });
    }
    if (!label) label = current;
    current = label;
    labeled.push({ at, label, type: String(event.type || '') });
  }

  const segments = [];
  for (let i = 0; i < labeled.length; i += 1) {
    const item = labeled[i];
    const nextAt = i + 1 < labeled.length ? labeled[i + 1].at : item.at + 1000;
    const prior = segments[segments.length - 1];
    if (prior && prior.label === item.label && Math.abs(prior.endMs - item.at) < 5) {
      prior.endMs = Math.max(prior.endMs, nextAt);
      continue;
    }
    segments.push({ label: item.label, startMs: item.at, endMs: Math.max(item.at, nextAt), source: item.type });
  }
  return {
    transcript,
    segments: segments.map((segment) => ({
      label: segment.label,
      startSec: Math.max(0, (segment.startMs - baseAt) / 1000),
      endSec: Math.max(0, (segment.endMs - baseAt) / 1000),
      source: segment.source,
    })).filter((segment) => segment.endSec >= segment.startSec),
  };
}

function eventSort(a, b) {
  return (eventTime(a) || 0) - (eventTime(b) || 0);
}

function buildAttempt(caseDir, call) {
  const callId = String(call.callId || call.id || '').trim();
  if (!callId) return null;
  const files = attemptFiles(caseDir, callId, call.runtime || call.liveKitRoot || '');
  const events = files.events.flatMap(jsonlFile).sort(eventSort);
  const times = events.map(eventTime).filter((value) => value != null);
  const baseAt = times.length ? Math.min(...times) : Date.now();
  const transcriptData = classifyEvents(events, baseAt);
  const terminal = events.some((event) => TERMINAL_EVENTS.has(String(event.type || '')));
  const latestAt = times.length ? Math.max(...times) : 0;
  const active = latestAt > 0 && !terminal && (Date.now() - latestAt < 30_000);
  const recording = files.recordings[0] || null;
  let recordedAt = null;
  try { recordedAt = recording ? statSync(recording).mtime.toISOString() : null; } catch {}
  return {
    callId,
    sequence: call.sequence || null,
    kind: call.kind || null,
    focusFields: Array.isArray(call.focusFields) ? call.focusFields.map((field) => String(field).slice(0, 160)).slice(0, 80) : [],
    status: active ? 'live' : recording ? 'recorded' : terminal ? 'ended' : events.length ? 'observed' : 'pending',
    live: active,
    audio: !!recording,
    recordedAt,
    transcript: transcriptData.transcript.slice(-MAX_TRANSCRIPT_ROWS),
    segments: transcriptData.segments,
    eventCount: events.length,
  };
}

function slackUrlFrom(...values) {
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    for (const key of ['slackUrl', 'slackThreadUrl', 'threadUrl', 'slackLink']) {
      const candidate = String(value[key] || '');
      if (/^https:\/\/[^\s]+$/i.test(candidate)) return candidate;
    }
  }
  return null;
}

function answerFacts(result) {
  const facts = result && result.aggregateEvidence && Array.isArray(result.aggregateEvidence.facts)
    ? result.aggregateEvidence.facts : [];
  return facts.slice(0, 300).map((fact) => ({
    key: String(fact.key || '').slice(0, 200),
    status: String(fact.status || 'unknown').slice(0, 80),
    value: typeof fact.value === 'string' ? fact.value.slice(0, MAX_TEXT_LENGTH) : fact.value == null ? null : String(fact.value).slice(0, MAX_TEXT_LENGTH),
    sourceCallIds: Array.isArray(fact.sourceCallIds) ? fact.sourceCallIds.map(String).slice(0, 20) : fact.sourceCallId ? [String(fact.sourceCallId)] : [],
    evidenceCount: Array.isArray(fact.evidence) ? fact.evidence.length : 0,
  }));
}

export function buildVobSnapshot({ sessionId, session = null, root = DEFAULT_VOB_ROOT } = {}) {
  const match = findVobCase({ sessionId, session, root });
  if (!match || match.ambiguous) return { linked: false, ambiguous: !!match?.ambiguous };
  const caseDir = match.caseDir;
  const context = jsonFile(join(caseDir, 'operator-context.private.json')) || {};
  const launch = jsonFile(join(caseDir, 'operator-launch.private.json')) || {};
  const owner = jsonFile(join(caseDir, 'operator-owner.private.json')) || {};
  const ledger = jsonFile(join(caseDir, 'operator-ledger.private.json')) || {};
  const result = jsonFile(join(caseDir, 'operator-result.private.json')) || {};
  const calls = Array.isArray(ledger.calls) ? ledger.calls : [];
  const attempts = calls.map((call) => buildAttempt(caseDir, call)).filter(Boolean);
  const factRows = answerFacts(result);
  const live = attempts.some((attempt) => attempt.live);
  return {
    linked: true,
    link: match.link,
    requestId: String(context.requestId || ledger.requestId || launch.requestId || '').slice(0, 180),
    payerName: String(context.payerName || '').slice(0, 240) || null,
    slackUrl: slackUrlFrom(context, launch, owner),
    slackRecorded: !!slackUrlFrom(context, launch, owner),
    live,
    status: result.status || (live ? 'in_progress' : attempts.length ? 'observed' : 'pending'),
    note: String(result.note || '').slice(0, 800) || null,
    ledger: calls.map((call, index) => ({
      callId: String(call.callId || '').slice(0, 180),
      sequence: call.sequence || index + 1,
      kind: String(call.kind || '').slice(0, 120),
      focusFields: Array.isArray(call.focusFields) ? call.focusFields.map((field) => String(field).slice(0, 160)).slice(0, 80) : [],
      attemptStatus: attempts[index]?.status || 'pending',
    })),
    facts: factRows,
    attempts,
    refreshedAt: new Date().toISOString(),
  };
}

export function resolveVobAudio({ sessionId, session = null, callId, root = DEFAULT_VOB_ROOT } = {}) {
  const match = findVobCase({ sessionId, session, root });
  if (!match || match.ambiguous || !/^[A-Za-z0-9._-]+$/.test(String(callId || ''))) return null;
  const files = attemptFiles(match.caseDir, callId);
  const path = files.recordings.find((candidate) => candidate.endsWith('.mixed.private.ogg'))
    || files.recordings.find((candidate) => candidate.endsWith('.payer.private.wav'))
    || files.recordings[0];
  if (!path || !inside(path, match.caseDir)) return null;
  const contentType = path.endsWith('.wav') ? 'audio/wav' : path.endsWith('.ogg') ? 'audio/ogg' : 'application/octet-stream';
  return { path, contentType };
}
