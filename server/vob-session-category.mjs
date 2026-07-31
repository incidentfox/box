const VOB_PRODUCTION_DIR_RE = /(?:^|\/)\.factory\/rise4-vob\/production\/(?:operators|remediation)(?:\/|$)/i;
const VOB_TITLE_RE = /^VOB\s+(?:operator|remediation)\b/i;

export function isVobCallSession(session = {}) {
  const category = String(session.category || session.sessionCategory || '').trim().toLowerCase();
  if (category === 'vob' || category === 'vob-call' || category === 'vob_calls') return true;
  if (VOB_PRODUCTION_DIR_RE.test(String(session.cwd || ''))) return true;
  return VOB_TITLE_RE.test(String(session.title || ''));
}
