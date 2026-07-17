import { createHash } from 'node:crypto';

export const WATCH_TRIGGERS = ['finished', 'error', 'blocked', 'needs_input', 'pr_ready', 'pr_merged'];

const TERMINAL_STATUSES = new Set(['idle', 'done', 'completed', 'failed', 'cancelled', 'canceled']);
const ACTIVE_STATUSES = new Set(['working', 'running']);

export function normalizeWatchTriggers(raw) {
  const vals = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const out = vals.map((v) => String(v || '').trim().toLowerCase()).filter((v) => WATCH_TRIGGERS.includes(v));
  return out.length ? [...new Set(out)] : [...WATCH_TRIGGERS];
}

export function watchHash(value) {
  return createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

export function watchText(snapshot) {
  return String((snapshot && (snapshot.latestReply || snapshot.summary || snapshot.preview || snapshot.title)) || '');
}

export function detectPrSignals(text) {
  const body = String(text || '');
  const urls = [...body.matchAll(/https?:\/\/github\.com\/[^\s)]+\/[^\s)]+\/pull\/\d+/gi)].map((m) => m[0].replace(/[.,;]+$/, ''));
  const prRefs = [...body.matchAll(/\bPR\s*#?(\d+)\b/gi)].map((m) => `PR #${m[1]}`);
  const hasPr = urls.length > 0 || prRefs.length > 0;
  const merged = hasPr && /\b(merged|deployed|landed|released)\b/i.test(body);
  const ready = hasPr && !merged && /\b(PR ready|pull request|opened PR|created PR|ready for review|review)\b/i.test(body);
  return {
    hasPr,
    ready,
    merged,
    ref: urls[0] || prRefs[0] || '',
  };
}

export function classifyWatchSnapshot(snapshot) {
  const status = String((snapshot && snapshot.status) || '').toLowerCase();
  const text = watchText(snapshot);
  const pr = detectPrSignals(text);
  return {
    status,
    active: ACTIVE_STATUSES.has(status),
    terminal: TERMINAL_STATUSES.has(status),
    needsInput: status === 'needs_input',
    error: status === 'failed' || /\b(error|failed|crashed|exception|timed out|could not|can't|cannot)\b/i.test(text),
    blocked: status === 'blocked' || /\b(blocked|needs jimmy|need jimmy|waiting for jimmy|needs your input|need your input|can't continue|cannot continue)\b/i.test(text),
    pr,
    textHash: watchHash(text),
  };
}

export function classifyWatchTransition(previous, current, triggers = WATCH_TRIGGERS) {
  if (!current) return [];
  const trig = new Set(normalizeWatchTriggers(triggers));
  const prev = previous ? classifyWatchSnapshot(previous) : null;
  const cur = classifyWatchSnapshot(current);
  const events = [];
  const label = current.title || current.label || current.id || 'session';
  const text = watchText(current);
  const add = (type, summary, extra = {}) => {
    if (!trig.has(type)) return;
    const ref = extra.ref || '';
    const signature = ref || cur.textHash || cur.status;
    events.push({
      type,
      title: label,
      summary,
      key: `${type}:${signature}`,
      ...extra,
    });
  };

  if (previous) {
    if (cur.needsInput && (!prev.needsInput || prev.textHash !== cur.textHash)) {
      add('needs_input', `Needs input on "${label}": ${text || current.status}`);
    }
    if (cur.blocked && (!prev.blocked || prev.textHash !== cur.textHash)) {
      add('blocked', `Blocked on "${label}": ${text || current.status}`);
    }
    if (cur.error && (!prev.error || prev.textHash !== cur.textHash)) {
      add('error', `Error on "${label}": ${text || current.status}`);
    }
    if (cur.pr.ready && (!prev.pr.ready || prev.pr.ref !== cur.pr.ref || prev.textHash !== cur.textHash)) {
      add('pr_ready', `PR ready for "${label}"${cur.pr.ref ? `: ${cur.pr.ref}` : ''}.`, { ref: cur.pr.ref });
    }
    if (cur.pr.merged && (!prev.pr.merged || prev.pr.ref !== cur.pr.ref || prev.textHash !== cur.textHash)) {
      add('pr_merged', `PR merged/deployed for "${label}"${cur.pr.ref ? `: ${cur.pr.ref}` : ''}.`, { ref: cur.pr.ref });
    }
    if (!cur.error && !cur.needsInput && !cur.blocked && prev.active && cur.terminal) {
      add('finished', `Finished "${label}": ${text || current.status}`);
    }
  }

  return events;
}
