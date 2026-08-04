const VOB_PRODUCTION_DIR_RE = /(?:^|\/)\.factory\/rise4-vob\/production\/(?:operators|remediation)(?:\/|$)/i;
const VOB_TITLE_RE = /^VOB\s+(?:operator|remediation)\b/i;

export function normalizeSessionCategory(value) {
  const category = String(value || '').trim().toLowerCase();
  return category === 'vob' || category === 'vob-call' || category === 'vob_calls' ? 'vob' : '';
}

export function isVobCallSession(session = {}) {
  if (normalizeSessionCategory(session.category || session.sessionCategory)) return true;
  if (VOB_PRODUCTION_DIR_RE.test(String(session.cwd || ''))) return true;
  return VOB_TITLE_RE.test(String(session.title || ''));
}

// Main-page groups are rendered in this order: Favorites, VOB calls, Live, recent.
// A favorited VOB session stays in the VOB group so the section remains complete.
export function mainPageSessionRank(session = {}) {
  if (session.favorite && session.category !== 'vob') return 0;
  if (session.category === 'vob') return 1;
  if (session.pinned) return 2;
  return 3;
}

export function sessionAllowsAutoContinue(session = {}) {
  return !isVobCallSession(session);
}
