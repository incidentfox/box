const TOKEN_KEYS = [
  'SLACK_USER_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_TOKEN',
  'INCIDENTFOX_SLACK_BOT_TOKEN',
  'INCIDENTIO_SLACK_BOT_TOKEN',
  'PAGERDUTY_SLACK_BOT_TOKEN',
  'SLACK_TOKEN_MINDPRACTICE',
  'SLACK_TOKEN_EBH',
];
const COOKIE_KEYS = [
  'SLACK_COOKIE',
  'SLACK_COOKIE_D',
  'SLACK_D_COOKIE',
  'SLACK_XOXC_COOKIE',
  'SLACK_XOXD_COOKIE',
];

const DEFAULT_TYPES = 'public_channel,private_channel,im,mpim';
const short = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '...' : s;
};

export function slackToken(cfg = (k) => process.env[k]) {
  return slackTokenCandidates(cfg)[0] || { token: '', key: '' };
}

export function slackTokenCandidates(cfg = (k) => process.env[k]) {
  const out = [];
  const cookie = slackCookie(cfg);
  for (const key of TOKEN_KEYS) {
    const token = String(cfg(key) || '').trim();
    if (!token || /^xapp-/i.test(token)) continue;
    if (!out.some((x) => x.token === token)) out.push({ token, key, cookie: /^xoxc-/i.test(token) ? cookie : '' });
  }
  return out;
}

function slackCookie(cfg = (k) => process.env[k]) {
  for (const key of COOKIE_KEYS) {
    const raw = String(cfg(key) || '').trim();
    if (!raw) continue;
    if (/^d=/i.test(raw) || /;\s*d=/i.test(raw)) return raw;
    return `d=${raw}`;
  }
  return '';
}

export function slackConfigured(cfg) {
  return slackTokenCandidates(cfg).length > 0;
}

function slackOptions(opts = {}) {
  const cfg = opts.cfg || ((k, d = '') => process.env[k] || d);
  const candidates = slackTokenCandidates(cfg);
  const picked = candidates[0] || { token: '', key: '' };
  const channels = String(cfg('SLACK_CHANNELS') || cfg('SLACK_CONTEXT_CHANNELS') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    cfg,
    token: opts.token || picked.token,
    tokenKey: picked.key,
    cookie: opts.cookie || picked.cookie || slackCookie(cfg),
    tokenCandidates: opts.token ? [{ token: opts.token, key: 'explicit', cookie: opts.cookie || slackCookie(cfg) }] : candidates,
    channels,
    types: cfg('SLACK_CONVERSATION_TYPES', DEFAULT_TYPES),
    lookbackHours: Number(cfg('SLACK_RECENT_LOOKBACK_HOURS', 24)) || 24,
    maxChannels: Number(cfg('SLACK_AUTO_CHANNEL_LIMIT', 10)) || 10,
    maxMessages: Number(cfg('SLACK_CONTEXT_MAX_MESSAGES', 12)) || 12,
    timeoutMs: Number(cfg('SLACK_TIMEOUT_MS', 12000)) || 12000,
    fetchImpl: opts.fetchImpl || fetch,
  };
}

async function slackApi(method, params = {}, opts = {}) {
  const token = opts.token;
  if (!token) throw new Error('Slack token not configured');
  const fetchImpl = opts.fetchImpl || fetch;
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs || 12000) : null;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    if (opts.cookie) headers.Cookie = opts.cookie;
    const r = await fetchImpl(url, {
      headers,
      signal: ctl ? ctl.signal : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      const reason = j.error || `HTTP ${r.status}`;
      const scope = j.needed ? `; needed scope: ${j.needed}` : '';
      throw new Error(`${method}: ${reason}${scope}`);
    }
    return j;
  } finally {
    if (t) clearTimeout(t);
  }
}

function authFailure(e) {
  return /account_inactive|invalid_auth|token_revoked|not_authed|missing_scope/i.test(String(e && e.message || e || ''));
}

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function cleanSlackText(text) {
  return unescapeHtml(text)
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, '#$2')
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function tsMs(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

function channelLabel(c = {}) {
  if (c.is_im) return c.user ? `DM ${c.user}` : `DM ${c.id || ''}`;
  if (c.name || c.name_normalized) return `#${c.name || c.name_normalized}`;
  return c.id || 'Slack';
}

function messageItem(msg, channel = {}) {
  const user = msg.user || msg.username || msg.bot_id || msg.app_id || 'unknown';
  return {
    ts: msg.ts || '',
    time: tsMs(msg.ts) ? new Date(tsMs(msg.ts)).toISOString() : '',
    channel_id: channel.id || msg.channel || '',
    channel: channelLabel(channel),
    user,
    text: short(cleanSlackText(msg.text || ''), 1200),
    permalink: msg.permalink || '',
  };
}

async function listConversations(opts) {
  const out = [];
  let cursor = '';
  do {
    const j = await slackApi('conversations.list', {
      types: opts.types,
      limit: 200,
      exclude_archived: true,
      cursor,
    }, opts);
    out.push(...(j.channels || []));
    cursor = j.response_metadata && j.response_metadata.next_cursor || '';
  } while (cursor && out.length < 800);
  return out;
}

async function conversationInfo(id, opts) {
  try {
    const j = await slackApi('conversations.info', { channel: id }, opts);
    return j.channel || { id };
  } catch (e) {
    if (authFailure(e)) throw e;
    return { id };
  }
}

async function resolveChannels(opts) {
  const refs = opts.channels || [];
  if (!refs.length) {
    const all = await listConversations(opts);
    return all
      .sort((a, b) => Number(b.updated || b.created || 0) - Number(a.updated || a.created || 0))
      .slice(0, opts.maxChannels);
  }

  const direct = [];
  const names = [];
  for (const ref of refs) {
    if (/^[CDG][A-Z0-9]+$/i.test(ref)) direct.push(ref.toUpperCase());
    else names.push(ref.replace(/^#/, '').toLowerCase());
  }
  const out = [];
  for (const id of direct) out.push(await conversationInfo(id, opts));
  if (names.length) {
    const all = await listConversations(opts);
    for (const name of names) {
      const hit = all.find((c) => String(c.name || c.name_normalized || '').toLowerCase() === name);
      if (hit) out.push(hit);
    }
  }
  return out;
}

export async function slackRecent(opts = {}) {
  const base = slackOptions(opts);
  if (!base.tokenCandidates.length) return { configured: false, error: 'Set SLACK_USER_TOKEN, SLACK_BOT_TOKEN, or SLACK_TOKEN.' };
  const failures = [];
  for (const candidate of base.tokenCandidates) {
    const o = { ...base, token: candidate.token, tokenKey: candidate.key, cookie: candidate.cookie || '' };
    let channels = [];
    try { channels = await resolveChannels(o); }
    catch (e) {
      failures.push(`${candidate.key}: ${String(e.message || e)}`);
      if (authFailure(e)) continue;
      return { configured: true, error: String(e.message || e) };
    }
    const oldest = Math.floor((Date.now() - o.lookbackHours * 3600 * 1000) / 1000);
    const errors = [];
    const messages = [];
    await Promise.all(channels.map(async (channel) => {
      try {
        const j = await slackApi('conversations.history', {
          channel: channel.id,
          limit: Math.max(1, Math.min(20, Number(o.cfg('SLACK_RECENT_PER_CHANNEL', 5)) || 5)),
          oldest,
        }, o);
        for (const msg of j.messages || []) {
          if (!msg || !msg.ts || msg.subtype === 'message_deleted') continue;
          const item = messageItem(msg, channel);
          if (item.text) messages.push(item);
        }
      } catch (e) {
        errors.push(`${channelLabel(channel)}: ${String(e.message || e)}`);
      }
    }));
    messages.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
    return {
      configured: true,
      token_key: candidate.key,
      channels: channels.map((c) => ({ id: c.id, name: channelLabel(c) })),
      messages: messages.slice(0, o.maxMessages),
      errors: errors.slice(0, 6),
    };
  }
  return { configured: true, error: failures.join('; ') || 'no usable Slack token' };
}

export async function slackSearch({ query, count = 8, ...opts } = {}) {
  const base = slackOptions(opts);
  if (!base.tokenCandidates.length) return { configured: false, error: 'Set SLACK_USER_TOKEN, SLACK_BOT_TOKEN, or SLACK_TOKEN.' };
  if (!String(query || '').trim()) return { configured: true, error: 'query required' };
  const failures = [];
  for (const candidate of base.tokenCandidates) {
    const o = { ...base, token: candidate.token, tokenKey: candidate.key, cookie: candidate.cookie || '' };
    try {
      const j = await slackApi('search.messages', {
        query,
        count: Math.max(1, Math.min(20, Number(count) || 8)),
        sort: 'timestamp',
        sort_dir: 'desc',
      }, o);
      const matches = (((j.messages || {}).matches) || []).map((m) => messageItem({
        ts: m.ts,
        user: m.user,
        username: m.username,
        text: m.text,
        permalink: m.permalink,
        channel: m.channel && m.channel.id,
      }, {
        id: m.channel && m.channel.id,
        name: m.channel && (m.channel.name || m.channel.name_normalized),
      }));
      return { configured: true, token_key: candidate.key, matches };
    } catch (e) {
      failures.push(`${candidate.key}: ${String(e.message || e)}`);
      if (authFailure(e)) continue;
      return { configured: true, error: String(e.message || e) };
    }
  }
  return { configured: true, error: failures.join('; ') || 'no usable Slack token' };
}

export async function renderSlackContext(opts = {}) {
  const r = await slackRecent(opts);
  if (!r.configured) return '';
  const includeErrors = opts.includeErrors !== false;
  const includeEmpty = opts.includeEmpty !== false;
  if (r.error && !(r.messages || []).length) return includeErrors ? `Slack context unavailable: ${r.error}` : '';
  const lines = (r.messages || []).map((m) => `- ${m.time || m.ts} ${m.channel} ${m.user}: ${m.text}`);
  if (!lines.length) return includeEmpty ? 'Slack context: no recent messages found in the configured scope.' : '';
  const errs = (r.errors || []).length ? `\n\nPartial Slack read errors: ${r.errors.join('; ')}` : '';
  return `Recent Slack messages:\n${lines.join('\n')}${errs}`;
}

export function slackEventForMessage(msg) {
  const title = `${msg.channel || 'Slack'} ${msg.user || ''}`.trim();
  return {
    type: 'slack',
    ts: msg.time || (tsMs(msg.ts) ? new Date(tsMs(msg.ts)).toISOString() : new Date().toISOString()),
    title,
    summary: msg.text,
    url: msg.permalink || '',
  };
}
