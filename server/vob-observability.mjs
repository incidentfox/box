import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

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

function candidateRoots(root) {
  const configured = resolve(root);
  const roots = [configured];
  // A few older operator runs wrote their private artifacts under the sibling
  // production/remediation tree.  Keep the fixture/test root isolated, while
  // making the deployed resolver cover both production artifact locations.
  if (configured === resolve(DEFAULT_VOB_ROOT)) roots.push(join(dirname(configured), 'remediation'));
  return [...new Set(roots)];
}

function hasOperatorArtifacts(candidate) {
  return ['operator-context.private.json', 'operator-launch.private.json', 'operator-owner.private.json',
    'operator-ledger.private.json', 'operator-result.private.json'].some((name) => existsSync(join(candidate, name)));
}

function findCaseFromCwd(cwd, root) {
  const realRoot = safeReal(root);
  const realCwd = safeReal(cwd);
  if (!realRoot || !realCwd || !inside(realCwd, realRoot)) return null;
  const rel = relative(realRoot, realCwd).split('/');
  if (!rel[0] || rel[0].includes('..')) return null;
  const candidate = join(realRoot, rel[0]);
  return hasOperatorArtifacts(candidate) ? candidate : null;
}

function sessionIdInArtifact(value, sessionId) {
  const target = String(sessionId || '');
  if (!target || !value || typeof value !== 'object') return false;
  const keys = new Set(['sessionId', 'resumedOperatorSessionId', 'boxSessionId']);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(visit);
    return Object.entries(node).some(([key, child]) => {
      if (keys.has(key) && typeof child === 'string' && child === target) return true;
      return child && typeof child === 'object' ? visit(child) : false;
    });
  };
  return visit(value);
}

function requestIdsInArtifact(value) {
  const ids = [];
  const keys = new Set(['requestId', 'rootRequestId']);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    for (const [key, child] of Object.entries(node)) {
      if (keys.has(key) && typeof child === 'string' && /^rise4_[A-Za-z0-9._-]+$/.test(child)) ids.push(child);
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(value);
  return [...new Set(ids)];
}

function requestIdMatches(candidate, requestIds) {
  const wanted = new Set((requestIds || []).map((id) => String(id || '')).filter(Boolean));
  if (!wanted.size) return false;
  const base = basename(candidate).replace(/_test_\d+$/, '');
  if (wanted.has(basename(candidate)) || wanted.has(base)) return true;
  return ['operator-owner.private.json', 'operator-launch.private.json', 'operator-context.private.json',
    'operator-ledger.private.json', 'operator-result.private.json']
    .some((filename) => requestIdsInArtifact(jsonFile(join(candidate, filename))).some((id) => wanted.has(id)));
}

function caseScore(candidate, sessionId, requestIds) {
  const sessionMatch = ['operator-owner.private.json', 'operator-launch.private.json', 'operator-context.private.json']
    .some((filename) => sessionIdInArtifact(jsonFile(join(candidate, filename)), sessionId));
  const requestMatch = requestIdMatches(candidate, requestIds);
  const context = jsonFile(join(candidate, 'operator-context.private.json')) || {};
  const ledger = jsonFile(join(candidate, 'operator-ledger.private.json')) || {};
  const result = jsonFile(join(candidate, 'operator-result.private.json')) || {};
  const calls = Array.isArray(ledger.calls) ? ledger.calls.length : 0;
  const resultCalls = Array.isArray(result.callIds) ? result.callIds.length : 0;
  const facts = Array.isArray(result.aggregateEvidence?.facts) ? result.aggregateEvidence.facts.length : 0;
  return (requestMatch ? 100000 : 0) + (sessionMatch ? 10000 : 0)
    + (context.requestId ? 500 : 0) + (calls ? 300 : 0) + (resultCalls ? 250 : 0)
    + (facts ? 150 : 0) + (existsSync(join(candidate, 'runtime')) ? 50 : 0)
    + (hasOperatorArtifacts(candidate) ? 10 : 0);
}

function findCaseFromArtifacts(sessionId, root, requestIds = []) {
  return caseDirectories(root)
    .filter((candidate) => {
      const sessionMatch = ['operator-owner.private.json', 'operator-launch.private.json', 'operator-context.private.json']
        .some((filename) => sessionIdInArtifact(jsonFile(join(candidate, filename)), sessionId));
      return sessionMatch || requestIdMatches(candidate, requestIds);
    })
    .map((caseDir) => ({ caseDir, score: caseScore(caseDir, sessionId, requestIds) }))
    .sort((a, b) => b.score - a.score || a.caseDir.localeCompare(b.caseDir));
}

export function findVobCase({ sessionId, session = null, root = DEFAULT_VOB_ROOT, requestIds = [] } = {}) {
  const configuredRoot = resolve(root);
  const roots = candidateRoots(configuredRoot);
  const cwdMatches = roots.map((candidateRoot) => findCaseFromCwd(session && session.cwd, candidateRoot))
    .filter(Boolean)
    .map((caseDir) => ({ caseDir, score: caseScore(caseDir, sessionId, requestIds), cwd: true }));
  const artifactMatches = roots.flatMap((candidateRoot) => findCaseFromArtifacts(sessionId, candidateRoot, requestIds));
  const candidates = [...cwdMatches, ...artifactMatches];
  if (candidates.length) {
    const bestByDir = new Map();
    for (const candidate of candidates) {
      const previous = bestByDir.get(candidate.caseDir);
      if (!previous || candidate.score > previous.score) bestByDir.set(candidate.caseDir, candidate);
    }
    const best = [...bestByDir.values()].sort((a, b) => b.score - a.score || a.caseDir.localeCompare(b.caseDir))[0];
    return {
      caseDir: best.caseDir,
      link: requestIdMatches(best.caseDir, requestIds) ? 'request-id' : best.cwd ? 'cwd' : 'artifact',
    };
  }
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

// The event stream is authoritative when it has an explicit controller phase,
// but speech often arrives a beat after the controller event.  Treat the
// unmistakable queue/IVR phrases as a local correction for that short window.
// This prevents a generated "Please hold" prompt from inheriting a preceding
// `live_agent_activated` label while the caller is still in hold music.
function transcriptPhaseLabel(text) {
  const normalized = String(text || '').toLowerCase();
  if (/\b(?:please|kindly)\s+(?:hold|wait)|\bremain on the line\b|\bcall is important\b|\ball representatives? are (?:currently )?assisting\b|\bhold music\b|\bqueue\b/.test(normalized)) return 'hold';
  if (/\b(?:press|dial|enter|select)\s+(?:\d|the|an? )|\bautomated (?:system|menu)\b|\bmenu option\b|\bextension\b/.test(normalized)) return 'ivr';
  return null;
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

export function classifyEvents(events, baseAt) {
  let current = 'unknown';
  const transcript = [];
  const labeled = [];
  for (const event of events) {
    const at = eventTime(event);
    if (at == null) continue;
    const explicit = eventExplicitLabel(event);
    let label = explicit;
    let nextCurrent = explicit || current;
    if (event.type === 'conversation_item_added') {
      const text = textOf(event.text);
      const speechLabel = transcriptPhaseLabel(text);
      label = speechLabel || (current === 'human' ? 'human' : current === 'ivr' ? 'ivr' : 'unknown');
      // A rep can say "Please hold" after answering.  Label that utterance as
      // hold, but keep the controller in human so the next rep utterance does
      // not inherit hold forever.
      if (speechLabel !== 'hold' || current !== 'human') nextCurrent = label;
      if (text) transcript.push({
        at: event.at,
        startSec: Math.max(0, (at - baseAt) / 1000),
        role: String(event.role || 'unknown'),
        text,
        phase: label,
        interrupted: !!event.interrupted,
      });
    }
    if (!label) label = current;
    current = nextCurrent;
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

function recordingPriority(path) {
  const name = basename(path).toLowerCase();
  if (name.endsWith('.mixed.private.ogg')) return 0;
  if (name.endsWith('.payer.private.wav')) return 1;
  return 2;
}

function selectRecording(paths) {
  return paths.map((path) => {
    try { return { path, size: statSync(path).size }; } catch { return null; }
  }).filter((item) => item && item.size > 0)
    .sort((a, b) => recordingPriority(a.path) - recordingPriority(b.path) || b.size - a.size)[0]?.path || null;
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
  const recording = selectRecording(files.recordings);
  let recordedAt = null;
  try { recordedAt = recording ? statSync(recording).mtime.toISOString() : null; } catch {}
  return {
    callId,
    sequence: call.sequence || null,
    kind: call.kind || null,
    focusFields: fieldKeys(call),
    status: active ? 'live' : recording ? 'recorded' : terminal ? 'ended' : events.length ? 'observed' : 'pending',
    live: active,
    audio: !!recording,
    recordedAt,
    transcript: transcriptData.transcript.slice(-MAX_TRANSCRIPT_ROWS),
    segments: transcriptData.segments,
    eventCount: events.length,
  };
}

function fieldKeys(call) {
  if (!call || typeof call !== 'object') return [];
  const values = [call.focusFields, call.fields, call.requestedFields, call.askFields, call.fieldKeys];
  const fields = values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.keys(value);
    return [];
  });
  return [...new Set(fields.map((field) => String(field || '').trim()).filter(Boolean))].slice(0, 80).map((field) => field.slice(0, 160));
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

function answerFacts(result, ledger = {}) {
  const aggregate = result && result.aggregateEvidence && typeof result.aggregateEvidence === 'object' ? result.aggregateEvidence : {};
  const candidates = [
    ...(Array.isArray(aggregate.facts) ? aggregate.facts : []),
    ...(Array.isArray(result?.facts) ? result.facts : []),
    ...(Array.isArray(ledger?.facts) ? ledger.facts : []),
  ];
  const fieldValues = aggregate.fieldValues && typeof aggregate.fieldValues === 'object' && !Array.isArray(aggregate.fieldValues)
    ? Object.entries(aggregate.fieldValues).map(([key, value]) => ({ key, value, status: 'confirmed' })) : [];
  const seen = new Set();
  return [...candidates, ...fieldValues].filter((fact) => {
    const key = String(fact?.key || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 300).map((fact) => ({
    key: String(fact.key || '').trim().slice(0, 200),
    status: String(fact.status || 'unknown').slice(0, 80),
    value: typeof fact.value === 'string' ? fact.value.slice(0, MAX_TEXT_LENGTH) : fact.value == null ? null : String(fact.value).slice(0, MAX_TEXT_LENGTH),
    sourceCallIds: [...new Set([
      ...(Array.isArray(fact.sourceCallIds) ? fact.sourceCallIds : []),
      fact.sourceCallId,
      fact.callId,
    ].filter(Boolean).map((id) => String(id).slice(0, 180)))].slice(0, 20),
    evidenceCount: Array.isArray(fact.evidence) ? fact.evidence.length : 0,
  }));
}

function ledgerFieldRows(call, factsByKey, factRows = [], allCalls = []) {
  let fields = fieldKeys(call);
  const callId = String(call.callId || call.id || '');
  const tiedFacts = factRows.filter((fact) => fact.sourceCallIds.includes(callId));
  if (!fields.length && tiedFacts.length) fields = tiedFacts.map((fact) => fact.key);
  if (!fields.length && allCalls.length === 1) fields = factRows.map((fact) => fact.key);
  return fields.map((key) => {
    const fact = factsByKey.get(key);
    return {
      key,
      status: fact?.status || 'pending',
      value: fact?.value ?? null,
      sourceCallIds: fact?.sourceCallIds || [],
      evidenceCount: fact?.evidenceCount || 0,
    };
  });
}

export function buildVobSnapshot({ sessionId, session = null, root = DEFAULT_VOB_ROOT, requestIds = [] } = {}) {
  const match = findVobCase({ sessionId, session, root, requestIds });
  if (!match || match.ambiguous) return { linked: false, ambiguous: !!match?.ambiguous };
  const caseDir = match.caseDir;
  const context = jsonFile(join(caseDir, 'operator-context.private.json')) || {};
  const launch = jsonFile(join(caseDir, 'operator-launch.private.json')) || {};
  const owner = jsonFile(join(caseDir, 'operator-owner.private.json')) || {};
  const ledger = jsonFile(join(caseDir, 'operator-ledger.private.json')) || {};
  const result = jsonFile(join(caseDir, 'operator-result.private.json')) || {};
  const calls = normalizedLedgerCalls(ledger, result);
  const attempts = calls.map((call) => buildAttempt(caseDir, call)).filter(Boolean);
  const factRows = answerFacts(result, ledger);
  const factsByKey = new Map(factRows.map((fact) => [fact.key, fact]));
  const attemptsById = new Map(attempts.map((attempt) => [attempt.callId, attempt]));
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
      focusFields: fieldKeys(call),
      fields: ledgerFieldRows(call, factsByKey, factRows, calls),
      attemptStatus: attemptsById.get(String(call.callId || call.id || ''))?.status || 'pending',
    })),
    facts: factRows,
    attempts,
    dataQuality: {
      ledgerCalls: calls.length,
      factCount: factRows.length,
      attemptsWithEvidence: attempts.filter((attempt) => attempt.eventCount > 0 || attempt.audio).length,
      fieldsWithValues: calls.reduce((count, call) => count + ledgerFieldRows(call, factsByKey, factRows, calls).filter((field) => field.value != null).length, 0),
      backfilled: !Array.isArray(ledger.calls) || !ledger.calls.length || calls.some((call) => !Array.isArray(call.focusFields) && fieldKeys(call).length),
    },
    refreshedAt: new Date().toISOString(),
  };
}

function normalizedLedgerCalls(ledger, result) {
  const calls = Array.isArray(ledger?.calls) ? ledger.calls.filter((call) => call && typeof call === 'object') : [];
  if (calls.length) return calls;
  const ids = Array.isArray(result?.callIds) ? result.callIds : [];
  return ids.map((value, index) => {
    const callId = typeof value === 'string' ? value : value?.callId || value?.id;
    return callId ? { callId: String(callId), sequence: index + 1, kind: 'recovered' } : null;
  }).filter(Boolean);
}

export function resolveVobAudio({ sessionId, session = null, callId, root = DEFAULT_VOB_ROOT, requestIds = [] } = {}) {
  const match = findVobCase({ sessionId, session, root, requestIds });
  if (!match || match.ambiguous || !/^[A-Za-z0-9._-]+$/.test(String(callId || ''))) return null;
  const files = attemptFiles(match.caseDir, callId);
  const path = selectRecording(files.recordings);
  if (!path || !inside(path, match.caseDir)) return null;
  const contentType = path.endsWith('.wav') ? 'audio/wav' : path.endsWith('.ogg') ? 'audio/ogg' : 'application/octet-stream';
  return { path, contentType };
}
