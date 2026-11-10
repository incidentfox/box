// "Who Jimmy is right now" — a distilled context block for the voice prompts.
//
// The voice models (GPT-Live thread/global voice and its Responses backend) otherwise know
// only a hard-coded persona, so they missed things every Claude session on the box knows
// (e.g. that Jimmy started at Hippocratic AI on 2026-10-19). This module distills the same
// sources a Claude session loads — the always-loaded CLAUDE.md files, Claude's auto-memory,
// and the company brain — plus open needs-Jimmy items, into a ~2–4K-token block.
//
// Safety: only distilled facts (selected sections, titles, descriptions), never raw dumps.
// Personal immigration/legal/medical details are dropped sentence-by-sentence
// (scrubPersonal), lines that look like credentials/config are dropped, and the caller
// passes the whole block through redactSecrets.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const JIMMY_CONTEXT_MAX_CHARS = 12000;   // ≈3.3K tokens at ~3.6 chars/token
export const JIMMY_CONTEXT_TTL_MS = 5 * 60 * 1000;

// Personal matters that must never reach the voice prompt (immigration/visa, personal
// legal, medical/therapy). Matched per sentence so one bad clause doesn't drop a paragraph.
const PERSONAL_RE = /\b(?:H-?1B|RFE|visas?|immigra\w*|green[- ]card|USCIS|O-1|EB-?[123]|petition|deport\w*|therap\w*|therapist|counsel(?:ing|or)|Yushan|psychotherap\w*|medication|my (?:doctor|diagnosis)|divorce|lawsuit|attorney|lawyer|personal legal)\b/i;
// Lines that are about credentials, config or secrets rather than facts about Jimmy.
const CREDENTIAL_RE = /\b(?:passwords?|passwd|secrets?(?:\.env| manager)?|api[_ -]?keys?|tokens?|credentials?|creds|refresh token|oauth|\.env\b|sops|client[_ ]secret|AWS_[A-Z_]+|ssh key)\b/i;

export function stripFrontmatter(md) {
  const s = String(md || '');
  if (!s.startsWith('---')) return s;
  const end = s.indexOf('\n---', 3);
  return end === -1 ? s : s.slice(end + 4).replace(/^\s*\n/, '');
}

export function frontmatterField(md, key) {
  const s = String(md || '');
  if (!s.startsWith('---')) return '';
  const end = s.indexOf('\n---', 3);
  const fm = end === -1 ? '' : s.slice(0, end);
  const m = fm.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
  return m ? m[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim() : '';
}

// Body of a "## Heading" section (up to the next heading of the same or higher level).
export function extractSection(md, heading) {
  const lines = String(md || '').split('\n');
  const want = String(heading).toLowerCase();
  let start = -1; let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    if (start === -1) {
      if (m[2].trim().toLowerCase().startsWith(want)) { start = i + 1; level = m[1].length; }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n').trim();
    }
  }
  return start === -1 ? '' : lines.slice(start).join('\n').trim();
}

// Drop personal-matter and credential/config sentences; tidy markdown for speech models
// (no bold markers, no code ticks). Hard-wrapped lines are first re-joined into their
// paragraph/bullet so a dropped sentence never leaves a dangling half-line behind.
export function unwrap(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const startsBlock = !line || /^(?:[-*•+]|\d+[.)]|#{1,6})\s/.test(line);
    if (!startsBlock && out.length && out[out.length - 1]) out[out.length - 1] += ' ' + line;
    else out.push(line);
  }
  return out.join('\n');
}

const SENSITIVE = (s) => PERSONAL_RE.test(s) || CREDENTIAL_RE.test(s);
export function scrubPersonal(text) {
  const out = [];
  for (const line of unwrap(text).split('\n')) {
    if (!SENSITIVE(line)) { out.push(line); continue; }
    const kept = line.split(/(?<=[.!?;])\s+/).filter((s) => !SENSITIVE(s)).join(' ').trim();
    if (kept && !/^[-*•+]?\s*$/.test(kept)) out.push(kept);
  }
  return out.join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n').trim();
}

const clipTo = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Pure assembly from already-read sources (unit-tested). Every field is optional.
export function buildJimmyContext({
  now = new Date(),
  userMemories = [],        // [{ name, description, body }] — Claude memories of type "user"
  directives = [],          // [string] — feedback-memory descriptions that are Jimmy's calls
  recentWork = [],          // [string] — titles of the most recently updated memory notes
  whoIs = '',               // "Who is Jimmy" section of the global CLAUDE.md
  companyPriority = '',     // "Company and priority" section of ~/development/CLAUDE.md
  boxPosture = '',          // first bullet of "Box posture" in ~/.claude/CLAUDE.md
  brainPerson = '',         // people/jimmy-wei.md body
  projects = [],            // [{ title, updated }] active brain projects
  meetings = [],            // [{ date, title }] newest first
  needs = [],               // [string] open needs-Jimmy titles
  maxChars = JIMMY_CONTEXT_MAX_CHARS,
} = {}) {
  const when = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const sec = [];
  const add = (title, body) => { body = scrubPersonal(body); if (body) sec.push(`## ${title}\n${body}`); };

  add('Latest about Jimmy (newest facts — these override anything older below)',
    userMemories.map((m) => `- ${oneLine(m.description || m.name)}${m.body ? `\n  ${clipTo(oneLine(m.body), 900)}` : ''}`).join('\n'));
  add('Who he is', clipTo(whoIs, 1800));
  add('The company and current priorities', clipTo(companyPriority, 2600));
  add('From the company brain (his person page)', clipTo(brainPerson, 800));
  add('Standing calls Jimmy has made (follow these)', directives.map((d) => `- ${clipTo(oneLine(d), 200)}`).join('\n'));
  add('What his agents worked on most recently (Claude memory notes, newest first)', recentWork.map((t) => `- ${oneLine(t)}`).join('\n'));
  add('Active projects (company brain)', projects.map((p) => `- ${oneLine(p.title)}${p.updated ? ` (updated ${p.updated})` : ''}`).join('\n'));
  add('Most recent meetings', meetings.map((m) => `- ${m.date} — ${oneLine(m.title)}`).join('\n'));
  add('Open needs-Jimmy decisions', needs.map((n) => `- ${clipTo(oneLine(n), 140)}`).join('\n'));
  if (boxPosture) add('Where you run', `${boxPosture} This box hosts his Claude Code and Codex agent fleet, the box app you are part of, his Linear board, and the company brain.`);

  if (!sec.length) return '';
  const head = `WHO JIMMY IS RIGHT NOW — distilled from his Claude Code setup (his CLAUDE.md files, Claude's memory about him, and the company brain), as of ${when}. Use it to answer naturally; never read it out wholesale.`;
  let text = `${head}\n\n${sec.join('\n\n')}`;
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    text = cut.slice(0, Math.max(cut.lastIndexOf('\n'), maxChars * 0.8)) + '\n…';
  }
  return text;
}

function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
function mtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

// The Claude memory dir for ~/development. The account broker scatters config dirs
// (~/.claude, ~/.claude-2nd, …), so pick the one whose MEMORY.md was touched last.
export function findMemoryDir(HOME, override = '') {
  if (override) return override;
  let best = ''; let bestM = 0;
  let dirs = [];
  try { dirs = readdirSync(HOME).filter((d) => /^\.claude(?:-[\w-]+)?$/.test(d)); } catch {}
  for (const d of dirs) {
    const dir = join(HOME, d, 'projects', '-home-factory-development', 'memory');
    const m = mtime(join(dir, 'MEMORY.md'));
    if (m > bestM) { bestM = m; best = dir; }
  }
  return best;
}

// Read every source from disk. Missing sources are simply skipped.
export function readJimmyContextSources({ HOME, brainDir = '', memoryDir = '', recentWorkLimit = 8, meetingLimit = 6, projectLimit = 6 } = {}) {
  const src = {};
  // Claude memory: user-type notes in full-ish, Jimmy's directives, recent-work titles.
  const mem = findMemoryDir(HOME, memoryDir);
  if (mem && existsSync(mem)) {
    const index = readText(join(mem, 'MEMORY.md'));
    const titles = new Map();
    for (const m of index.matchAll(/^- \[([^\]]+)\]\(([^)]+\.md)\)/gm)) titles.set(m[2], m[1]);
    let files = [];
    try { files = readdirSync(mem).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); } catch {}
    const notes = files.map((f) => {
      const raw = readText(join(mem, f));
      return {
        file: f, raw, mt: mtime(join(mem, f)),
        type: frontmatterField(raw, 'type'),
        name: titles.get(f) || (frontmatterField(raw, 'name') || f.replace(/\.md$/, '')).replace(/-/g, ' '),
        description: frontmatterField(raw, 'description'),
      };
    }).sort((a, b) => b.mt - a.mt);
    src.userMemories = notes.filter((n) => n.type === 'user').map((n) => ({
      name: n.name, description: n.description,
      // Body without the "Why/How to apply" agent-process boilerplate.
      body: stripFrontmatter(n.raw).split(/\n\*\*(?:How to apply|Why)/)[0],
    }));
    src.directives = notes.filter((n) => n.type === 'feedback' && /\bJimmy\b/.test(n.description)).map((n) => n.description);
    // Titles only for project/reference notes — their descriptions can carry bill/claim
    // detail, and a title is enough for "what's been going on".
    src.recentWork = notes.filter((n) => n.type === 'project' && !PERSONAL_RE.test(`${n.name} ${n.description}`))
      .slice(0, recentWorkLimit).map((n) => n.name);
  }
  // Always-loaded CLAUDE.md files.
  src.whoIs = extractSection(readText(join(HOME, '.claude-2nd', 'CLAUDE.md')), 'Who is Jimmy');
  src.companyPriority = extractSection(readText(join(HOME, 'development', 'CLAUDE.md')), 'Company and priority');
  // The box file's intro paragraph says what this machine is ("…always-on Linux factory box").
  const boxIntro = unwrap(stripFrontmatter(readText(join(HOME, '.claude', 'CLAUDE.md')))).split('\n')
    .find((l) => l && !/^#/.test(l)) || '';
  src.boxPosture = (boxIntro.match(/^.*?[.!?](?=\s|$)/) || [''])[0];
  // Company brain.
  if (brainDir && existsSync(brainDir)) {
    const person = stripFrontmatter(readText(join(brainDir, 'people', 'jimmy-wei.md')));
    src.brainPerson = person.replace(/^#+\s.*$/gm, '').trim();
    const pdir = join(brainDir, 'projects');
    let pf = [];
    try { pf = readdirSync(pdir).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch {}
    src.projects = pf.map((f) => {
      const raw = readText(join(pdir, f));
      return { title: frontmatterField(raw, 'title'), status: frontmatterField(raw, 'status'), updated: frontmatterField(raw, 'updated_at').slice(0, 10) };
    }).filter((p) => p.title && /^active/.test(p.status))
      .sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, projectLimit);
    const mdir = join(brainDir, 'meetings');
    let mf = [];
    try { mf = readdirSync(mdir).filter((f) => /^\d{4}-\d{2}-\d{2}--.+\.md$/.test(f)); } catch {}
    src.meetings = mf.sort().reverse().slice(0, meetingLimit).map((f) => {
      const title = frontmatterField(readText(join(mdir, f)), 'title')
        || f.split('--')[1].replace(/-/g, ' ');
      return { date: f.slice(0, 10), title };
    });
  }
  return src;
}

// Cached provider: rebuilt at most every ttlMs; concurrent callers share one build.
export function createJimmyContext({ HOME, brainDir = () => '', memoryDir = '', readNeeds = async () => [], redact = (s) => s, ttlMs = JIMMY_CONTEXT_TTL_MS, now = () => new Date() } = {}) {
  let cached = { at: 0, text: '' };
  let inflight = null;
  async function build() {
    const src = readJimmyContextSources({ HOME, brainDir: typeof brainDir === 'function' ? brainDir() : brainDir, memoryDir });
    let needs = [];
    try { needs = (await readNeeds()) || []; } catch {}
    const text = buildJimmyContext({ ...src, needs: needs.slice(0, 5), now: now() });
    return String(redact(text) || '');
  }
  return {
    async get() {
      if (cached.text && now().getTime() - cached.at < ttlMs) return cached.text;
      if (!inflight) {
        inflight = build().then((text) => { cached = { at: now().getTime(), text }; return text; })
          .catch(() => cached.text).finally(() => { inflight = null; });
      }
      return inflight;
    },
    invalidate() { cached = { at: 0, text: '' }; },
  };
}
