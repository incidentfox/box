export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
export const DEFAULT_CONTINUE_MESSAGE = 'Continue working toward the active goal. Reconcile the current evidence and session state first, then take the next safe in-scope action. Preserve all existing safeguards. If the goal is complete, paused, blocked, needs human input, or has no safe next action, say so explicitly and stop.';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; }
  catch { return false; }
}

export function normalizeAutoContinue(raw = {}) {
  const timeZone = validTimeZone(raw.timeZone) ? raw.timeZone : DEFAULT_TIME_ZONE;
  const time = (value, fallback) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? String(value) : fallback;
  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [1, 2, 3, 4, 5];
  return {
    enabled: !!raw.enabled,
    timeZone,
    start: time(raw.start, '05:00'),
    end: time(raw.end, '17:00'),
    days: days.length ? days : [1, 2, 3, 4, 5],
    delayMinutes: Math.max(1, Math.min(60, Number(raw.delayMinutes) || 3)),
    maxPerWindow: Math.max(1, Math.min(1000, Number(raw.maxPerWindow) || 240)),
    message: String(raw.message || DEFAULT_CONTINUE_MESSAGE).trim().slice(0, 4000) || DEFAULT_CONTINUE_MESSAGE,
    lastEnqueuedAt: Math.max(0, Number(raw.lastEnqueuedAt) || 0),
    windowDate: String(raw.windowDate || ''),
    windowCount: Math.max(0, Number(raw.windowCount) || 0),
  };
}

export function zonedClock(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) % 24;
  return {
    day: DAY_NAMES.indexOf(parts.weekday),
    minute: hour * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function clockMinute(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

export function insideAutoContinueWindow(policy, now = new Date()) {
  const normalized = normalizeAutoContinue(policy);
  const clock = zonedClock(now, normalized.timeZone);
  if (!normalized.days.includes(clock.day)) return { inside: false, clock };
  const start = clockMinute(normalized.start);
  const end = clockMinute(normalized.end);
  const inside = start < end
    ? clock.minute >= start && clock.minute < end
    : clock.minute >= start || clock.minute < end;
  return { inside, clock };
}

export function shouldAutoContinue({ policy, now = new Date(), busy = false, needsInput = false, goalStatus = null } = {}) {
  const normalized = normalizeAutoContinue(policy);
  const { inside, clock } = insideAutoContinueWindow(normalized, now);
  if (!normalized.enabled || !inside || busy || needsInput) return { due: false, policy: normalized, clock };
  if (goalStatus && goalStatus !== 'active') return { due: false, policy: normalized, clock };
  const windowCount = normalized.windowDate === clock.date ? normalized.windowCount : 0;
  if (windowCount >= normalized.maxPerWindow) return { due: false, policy: normalized, clock };
  if (normalized.lastEnqueuedAt && now.getTime() - normalized.lastEnqueuedAt < normalized.delayMinutes * 60_000) return { due: false, policy: normalized, clock };
  return { due: true, policy: { ...normalized, windowDate: clock.date, windowCount }, clock };
}

export function dueWakeups(wakeups = [], now = new Date()) {
  const nowMs = now.getTime();
  return wakeups.filter((wake) => !wake.firedAt && Number.isFinite(Date.parse(wake.at)) && Date.parse(wake.at) <= nowMs);
}

export function assistantStopsAutoContinue(text = '') {
  return /(?:^|\n)\s*(?:blocked\b|needs? (?:your|human|jimmy(?:'s)?) input\b|waiting for (?:your|human|jimmy)\b|(?:cannot|can't) continue without\b|i need you to\b|(?:goal|objective|work) (?:is )?(?:complete|completed)\b)/i.test(String(text));
}
