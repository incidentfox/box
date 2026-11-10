// Pure helpers for the Voice-screen tools added in "voice: more tools" — brain_save,
// gmail_search / gmail_read, calendar_add, needs_jimmy_resolve. Kept free of I/O so they
// can be unit-tested (server/voice-extra-tools.test.mjs); the handlers that shell out live
// in voice-assistant.mjs.

// ---- brain_save ------------------------------------------------------------------

// The company brain is shared with the whole agent fleet and pushed to GitHub, so a fact
// spoken by voice must never carry PHI, credentials, or Jimmy's personal immigration /
// legal / medical material (those stay out of company systems entirely).
const PHI_PATTERNS = [
  [/\b\d{3}-\d{2}-\d{4}\b/, 'looks like a Social Security number'],
  [/\b(dob|d\.o\.b\.|date of birth|birth ?date|born on)\b/i, 'mentions a date of birth'],
  [/\b(mrn|medical record (number|#|no\.?))\b/i, 'mentions a medical record number'],
  [/\b(ssn|social security)\b/i, 'mentions a Social Security number'],
  [/\b(?:[Pp]atient|[Aa]pplicant|[Cc]laimant|[Ii]njured [Ww]orker)(?:'s)?\s+(?:name\s*(?:is|:)?\s*)?(?:mr\.?\s+|ms\.?\s+|mrs\.?\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+/, 'names a patient or claimant'],
  [/\b(diagnos(is|ed)|icd-?10)\b[^.]{0,60}\b(patient|applicant|claimant)\b|\b(patient|applicant|claimant)\b[^.]{0,60}\bdiagnos(is|ed)\b/i, 'ties a diagnosis to a patient'],
];
const PERSONAL_PATTERNS = [
  [/\b(h-?1b|h1-b|o-?1a?|rfe|uscis|green card|i-140|i-485|i-129|i-797|ead card|visa (status|petition|interview|stamp|transfer|application)|my visa|immigration|asylum|naturali[sz]ation)\b/i, 'immigration or visa material'],
  [/\b(my|jimmy'?s) (therapist|therapy|psychiatrist|diagnosis|medication|prescription|doctor|health|medical)\b/i, 'personal medical material'],
  [/\b(divorce|custody|my (lawyer|attorney|lawsuit)|jimmy'?s (lawyer|attorney|lawsuit)|personal (legal|lawsuit))\b/i, 'personal legal material'],
];

// → { ok: true } or { ok: false, reason } — `redact` is redactSecrets (injected to avoid a cycle).
export function screenBrainFact(text, { redact } = {}) {
  const t = String(text || '').trim();
  if (t.length < 8) return { ok: false, reason: 'the fact is too short to be worth saving' };
  if (t.length > 4000) return { ok: false, reason: 'that is too long for one fact — summarize it to a few sentences' };
  if (typeof redact === 'function') {
    const r = redact(t);
    if (r && r.redactions) return { ok: false, reason: 'it contains what looks like a credential or secret' };
  }
  for (const [re, why] of PERSONAL_PATTERNS) if (re.test(t)) return { ok: false, reason: `it looks like ${why}, which never goes into company systems` };
  for (const [re, why] of PHI_PATTERNS) if (re.test(t)) return { ok: false, reason: `it ${why} — patient-identifying info (PHI) never goes into the brain` };
  return { ok: true };
}

export const BRAIN_ENTITY_TYPES = ['person', 'company', 'deal', 'project', 'general'];

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60);
}

// One brain-queue entry, in the same shape session-distill.mjs writes. The brain-sync loop
// (~/bin/brain-sync-loop.sh) drains ~/.factory/brain-queue/*.md single-threaded into
// learnings/agent-session-log.md, commits, and pushes — so voice never touches the git repo.
export function brainQueueEntry({ fact, entity = '', entityType = '', now = new Date() } = {}) {
  const type = BRAIN_ENTITY_TYPES.includes(entityType) ? entityType : (entity ? 'general' : 'general');
  const ent = String(entity || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const tag = ent ? (type !== 'general' ? `${type}:${slugify(ent)}` : slugify(ent)) : 'general';
  const body = String(fact || '').replace(/\s*\n+\s*/g, ' ').trim();
  return `## ${now.toISOString()} — ${tag}\nSaved by voice (Box Voice screen, brain_save)${ent ? ` — about ${ent}` : ''}.\n- ${body}\n`;
}

// ---- Gmail -----------------------------------------------------------------------

export function normalizeGoogleAccount(a, dflt = 'work') {
  const s = String(a || '').toLowerCase().trim();
  if (['me', 'personal', 'icewing', 'gmail', 'icewing1996'].includes(s)) return 'me';
  if (['work', 'incidentfox', 'jimmy', 'jimmy@incidentfox.ai'].includes(s)) return 'work';
  if (s === 'both' || s === 'all') return 'both';
  return dflt;
}

// `google <acct> gmail list` prints: id \t date \t from \t subject
export function parseGmailList(out, max = 10) {
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 4 || !/^[0-9a-f]{8,}$/i.test(parts[0].trim())) continue;
    rows.push({ id: parts[0].trim(), date: parts[1].trim(), from: parts[2].trim(), subject: parts.slice(3).join(' ').trim() });
    if (rows.length >= max) break;
  }
  return rows;
}

// Gmail From headers → a speakable sender ("FedEx" from `FedEx <fedex@message.fedex.com>`).
export function senderName(from) {
  const s = String(from || '').trim();
  const m = s.match(/^"?([^"<]+?)"?\s*<([^>]+)>/);
  if (m && m[1].trim()) return { name: m[1].trim(), email: m[2].trim() };
  const e = s.replace(/[<>]/g, '');
  return { name: e, email: e };
}

// ---- Calendar (Pacific time) -----------------------------------------------------

const PT = 'America/Los_Angeles';

function ptOffsetMinutes(date) {
  const v = new Intl.DateTimeFormat('en-US', { timeZone: PT, timeZoneName: 'shortOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName').value; // "GMT-8" / "GMT-7"
  const m = v.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

// "2026-11-12T15:00" (Pacific wall time) → "2026-11-12T15:00:00-08:00". A value that
// already carries Z or an offset is respected as given. Returns '' when unparseable.
export function pacificIso(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? '' : s;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return '';
  const [, y, mo, d, h, mi, se = '0'] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  let off = ptOffsetMinutes(new Date(wall));
  const off2 = ptOffsetMinutes(new Date(wall - off * 60000));
  if (off2 !== off) off = off2;
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}-${mo}-${d}T${pad(+h)}:${mi}:${pad(+se)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// Spoken read-back: "Thursday, November 12, 3:00 PM to 3:30 PM Pacific".
export function describePacificRange(startIso, endIso) {
  const s = new Date(startIso), e = new Date(endIso);
  const day = s.toLocaleString('en-US', { timeZone: PT, weekday: 'long', month: 'long', day: 'numeric' });
  const t = (d) => d.toLocaleString('en-US', { timeZone: PT, hour: 'numeric', minute: '2-digit' });
  const sameDay = day === e.toLocaleString('en-US', { timeZone: PT, weekday: 'long', month: 'long', day: 'numeric' });
  return sameDay ? `${day}, ${t(s)} to ${t(e)} Pacific` : `${day}, ${t(s)} to ${e.toLocaleString('en-US', { timeZone: PT, weekday: 'long', month: 'long', day: 'numeric' })}, ${t(e)} Pacific`;
}

// Resolve start/end/duration into concrete offset ISO strings, or { error }.
export function resolveEventTimes({ start, end, duration_minutes } = {}) {
  const s = pacificIso(start);
  if (!s) return { error: 'start must be a date and time like 2026-11-12T15:00 (Pacific)' };
  let e = end ? pacificIso(end) : '';
  if (end && !e) return { error: 'end must be a date and time like 2026-11-12T15:30 (Pacific)' };
  if (!e) {
    const mins = Math.max(5, Math.min(24 * 60, Number(duration_minutes) || 30));
    e = pacificIso(new Date(new Date(s).getTime() + mins * 60000).toLocaleString('sv-SE', { timeZone: PT }).replace(' ', 'T').slice(0, 16));
  }
  if (new Date(e).getTime() <= new Date(s).getTime()) return { error: 'the end time must be after the start time' };
  return { start: s, end: e };
}

// ---- needs-Jimmy -----------------------------------------------------------------

// "INC 950", "inc-950", "950" → "INC-950"; '' when there's no number.
export function needsJimmyId(raw) {
  const m = String(raw || '').match(/(\d{1,6})/);
  return m ? `INC-${Number(m[1])}` : '';
}
