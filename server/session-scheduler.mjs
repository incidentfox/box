export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
export const DEFAULT_CONTINUE_MESSAGE = 'This is an automated message. Continue. If done already, run the command `bash ~/stop.sh` to stop future automated continuation reminders and prevent going in a loop.';

const TERMINAL_STATES = new Set(['complete', 'blocked', 'needs_input', 'stopped', 'error']);

export function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; }
  catch { return false; }
}

function nonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
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
    continuationCount: nonNegativeInt(raw.continuationCount),
    message: DEFAULT_CONTINUE_MESSAGE,
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
  return { due: true, policy: normalized };
}

export function dueWakeups(wakeups = [], now = new Date()) {
  const nowMs = now.getTime();
  return wakeups.filter((wake) => !wake.firedAt && Number.isFinite(Date.parse(wake.at)) && Date.parse(wake.at) <= nowMs);
}
