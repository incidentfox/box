export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
export const DEFAULT_CONTINUE_MESSAGE = 'Continue. If done already, run /stop';
export const DEFAULT_FINISHER_DELAY_MINUTES = 3;
export const DEFAULT_MAX_CONTINUATIONS = 12;

const TERMINAL_STATES = new Set(['complete', 'blocked', 'needs_input', 'stopped', 'error', 'limit_reached']);

export function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; }
  catch { return false; }
}

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

export function normalizeAutoContinue(raw = {}) {
  const enabled = raw.enabled !== false;
  const armed = enabled && raw.armed === true;
  const requestedState = String(raw.state || '').trim();
  const state = armed
    ? (['watching', 'checking', 'continuing'].includes(requestedState) ? requestedState : 'watching')
    : (TERMINAL_STATES.has(requestedState) ? requestedState : 'ready');
  return {
    enabled,
    armed,
    state,
    reason: String(raw.reason || '').trim().slice(0, 300),
    timeZone: validTimeZone(raw.timeZone) ? raw.timeZone : DEFAULT_TIME_ZONE,
    delayMinutes: boundedInt(raw.delayMinutes, DEFAULT_FINISHER_DELAY_MINUTES, 1, 60),
    maxContinuations: boundedInt(raw.maxContinuations ?? raw.maxPerWindow, DEFAULT_MAX_CONTINUATIONS, 1, 50),
    continuationCount: boundedInt(raw.continuationCount, 0, 0, 50),
    message: String(raw.message || DEFAULT_CONTINUE_MESSAGE).trim().slice(0, 4000) || DEFAULT_CONTINUE_MESSAGE,
    taskStartedAt: Math.max(0, Number(raw.taskStartedAt) || 0),
    lastActivityAt: Math.max(0, Number(raw.lastActivityAt) || 0),
    lastCheckedAt: Math.max(0, Number(raw.lastCheckedAt) || 0),
    lastEnqueuedAt: Math.max(0, Number(raw.lastEnqueuedAt) || 0),
  };
}

export function armTaskFinisher(policy = {}, now = new Date()) {
  const normalized = normalizeAutoContinue(policy);
  if (!normalized.enabled) return normalized;
  const at = now.getTime();
  return {
    ...normalized,
    armed: true,
    state: 'watching',
    reason: 'Watching this task until it is finished',
    continuationCount: 0,
    taskStartedAt: at,
    lastActivityAt: at,
    lastCheckedAt: 0,
    lastEnqueuedAt: 0,
  };
}

export function noteTaskFinisherActivity(policy = {}, now = new Date()) {
  const normalized = normalizeAutoContinue(policy);
  if (!normalized.armed) return normalized;
  return {
    ...normalized,
    state: 'watching',
    reason: 'Waiting to verify the latest response',
    lastActivityAt: now.getTime(),
  };
}

export function stopTaskFinisher(policy = {}, state = 'stopped', reason = '', now = new Date()) {
  const normalized = normalizeAutoContinue(policy);
  const terminalState = TERMINAL_STATES.has(state) ? state : 'stopped';
  return {
    ...normalized,
    armed: false,
    state: terminalState,
    reason: String(reason || '').trim().slice(0, 300),
    lastCheckedAt: now.getTime(),
  };
}

export function taskFinisherStopRequested(text) {
  return String(text || '').split(/\r?\n/).some((line) => line.trim() === '/stop');
}

export function shouldRunTaskFinisher({ policy, now = new Date(), busy = false } = {}) {
  const normalized = normalizeAutoContinue(policy);
  if (!normalized.enabled || !normalized.armed || busy) return { due: false, policy: normalized };
  if (normalized.continuationCount >= normalized.maxContinuations) {
    return { due: false, terminal: 'limit_reached', policy: normalized };
  }
  const activityAt = Math.max(normalized.taskStartedAt, normalized.lastActivityAt, normalized.lastEnqueuedAt);
  if (!activityAt || now.getTime() - activityAt < normalized.delayMinutes * 60_000) return { due: false, policy: normalized };
  return { due: true, policy: normalized };
}

export function dueWakeups(wakeups = [], now = new Date()) {
  const nowMs = now.getTime();
  return wakeups.filter((wake) => !wake.firedAt && Number.isFinite(Date.parse(wake.at)) && Date.parse(wake.at) <= nowMs);
}
