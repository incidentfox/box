// tui-prompt.mjs — reconstruct the claude TUI screen from raw PTY bytes and parse a
// PENDING interactive prompt (AskUserQuestion / ExitPlanMode / permission) out of it.
//
// Why this exists: when a `claude --remote-control` session is parked on one of those
// prompts, the tool_use is NOT written to the session JSONL until it's answered (verified:
// 0 pending AskUserQuestion entries across all JSONLs ever). The box renders from JSONL, so
// it can't see a pending prompt at all — the user is stuck. The only local source of the
// prompt content is the live TUI, so we scrape it: apply the ANSI to a screen grid, then
// pattern-match the option list. Detection of WHETHER a session is waiting comes separately
// from ~/.claude/sessions/<pid>.json (status==='waiting'); this module supplies the CONTENT.

const ROWS = 50, COLS = 100;

// Minimal VT100 screen model: enough of the cursor/erase subset that claude's TUI uses to
// rebuild the final visible screen. Ignores colors/styles (SGR). Returns trimmed text lines.
export function screenFromBuffer(buf) {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(' '));
  let r = 0, c = 0;
  const clampR = () => { if (r < 0) r = 0; if (r >= ROWS) r = ROWS - 1; };
  const clampC = () => { if (c < 0) c = 0; if (c >= COLS) c = COLS - 1; };
  const i0 = Math.max(0, s.length - 400000); // only the tail can matter
  for (let i = i0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\x1b') {
      const n = s[i + 1];
      if (n === '[') {
        // CSI: ESC [ params... final
        let j = i + 2, params = '';
        while (j < s.length && /[0-9;?]/.test(s[j])) { params += s[j]; j++; }
        const fin = s[j];
        const nums = params.replace(/[?]/g, '').split(';').map((x) => parseInt(x, 10));
        const p0 = isNaN(nums[0]) ? null : nums[0];
        const p1 = isNaN(nums[1]) ? null : nums[1];
        switch (fin) {
          case 'H': case 'f': r = (p0 || 1) - 1; c = (p1 || 1) - 1; clampR(); clampC(); break;
          case 'A': r -= (p0 || 1); clampR(); break;
          case 'B': r += (p0 || 1); clampR(); break;
          case 'C': c += (p0 || 1); clampC(); break;
          case 'D': c -= (p0 || 1); clampC(); break;
          case 'G': c = (p0 || 1) - 1; clampC(); break;
          case 'd': r = (p0 || 1) - 1; clampR(); break;
          case 'E': r += (p0 || 1); c = 0; clampR(); break;
          case 'F': r -= (p0 || 1); c = 0; clampR(); break;
          case 'J': { // erase display: 0=cursor→end, 1=start→cursor, 2/3=all
            const m = p0 || 0;
            if (m === 2 || m === 3) { for (let y = 0; y < ROWS; y++) grid[y].fill(' '); }
            else if (m === 0) { for (let x = c; x < COLS; x++) grid[r][x] = ' '; for (let y = r + 1; y < ROWS; y++) grid[y].fill(' '); }
            else if (m === 1) { for (let y = 0; y < r; y++) grid[y].fill(' '); for (let x = 0; x <= c; x++) grid[r][x] = ' '; }
            break;
          }
          case 'K': { // erase line: 0=cursor→eol, 1=bol→cursor, 2=whole
            const m = p0 || 0;
            if (m === 0) { for (let x = c; x < COLS; x++) grid[r][x] = ' '; }
            else if (m === 1) { for (let x = 0; x <= c; x++) grid[r][x] = ' '; }
            else { grid[r].fill(' '); }
            break;
          }
          default: break; // m (SGR), etc — ignore
        }
        i = j; // consume through the final byte
        continue;
      } else if (n === ']') {
        // OSC: skip to BEL or ST (ESC \)
        let j = i + 2;
        while (j < s.length && s[j] !== '\x07' && !(s[j] === '\x1b' && s[j + 1] === '\\')) j++;
        i = (s[j] === '\x1b') ? j + 1 : j;
        continue;
      } else { i++; continue; } // ESC + one byte (charset selects etc.)
    }
    if (ch === '\r') { c = 0; continue; }
    if (ch === '\n') { r++; c = 0; clampR(); continue; }
    if (ch === '\b') { c = Math.max(0, c - 1); continue; }
    if (ch === '\t') { c = Math.min(COLS - 1, (Math.floor(c / 8) + 1) * 8); continue; }
    if (ch < ' ') continue; // other control chars
    if (c < COLS) { grid[r][c] = ch; c++; }
  }
  return grid.map((row) => row.join('').replace(/\s+$/, ''));
}

const OPT_RE = /^\s*[❯>›▶]?\s*(\d+)\.\s+(.*\S)\s*$/;
const ASK_FOOTER = /Enter to select|↑\/↓ to navigate|to navigate/i;
const PLAN_RE = /Would you like to proceed\?|Ready to code\?|Here is Claude'?s plan/i;
const FREETEXT_RE = /^(type something|tell claude what to change|other|none of (the|these)|let me type|write my own)/i;

const RULE_RE = /^[\s─╌╭╮╰╯│┃▔▁━]+$/;
const isContinuation = (l) => l && !OPT_RE.test(l) && !RULE_RE.test(l) && !ASK_FOOTER.test(l) &&
  !/^\s*(shift\+tab|ctrl\+|esc to|press )/i.test(l);

// Parse the visible screen lines for a pending selection prompt. Returns null if none found.
export function parsePrompt(lines) {
  // Collect numbered options (a run near the bottom of the screen), with their line index so we
  // can attach descriptions that the TUI renders on the following indented line(s).
  let raw = [];
  let firstOptLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPT_RE);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (num === 1 && raw.length) { raw = []; firstOptLine = -1; } // fresh menu redrawn lower
    if (firstOptLine < 0) firstOptLine = i;
    const rest = m[2];
    const sp = rest.search(/\s{2,}/); // same-line "label   description" (rare)
    const label = (sp >= 0 ? rest.slice(0, sp) : rest).trim();
    const sameLineDesc = sp >= 0 ? rest.slice(sp).trim() : '';
    raw.push({ n: num, label, line: i, sameLineDesc });
  }
  if (raw.length < 1 || raw[0].n !== 1) return null;

  const opts = raw.map((o, k) => {
    let desc = o.sameLineDesc;
    if (!desc) {
      const end = k + 1 < raw.length ? raw[k + 1].line : Math.min(lines.length, o.line + 4);
      const cont = [];
      for (let j = o.line + 1; j < end; j++) { if (isContinuation(lines[j])) cont.push(lines[j].trim()); else break; }
      desc = cont.join(' ').trim();
    }
    return { n: o.n, label: o.label, desc, freeText: FREETEXT_RE.test(o.label) };
  });

  const all = lines.join('\n');
  const isPlan = PLAN_RE.test(all);
  const isAsk = ASK_FOOTER.test(all);
  if (!isPlan && !isAsk) {
    // permission / generic selection: only trust it if a cancel/select hint is present
    if (!/esc to (cancel|interrupt|reject)|to (confirm|select|reject|allow)/i.test(all)) return null;
  }

  // Title/question text: the non-empty lines just above the first option (skip rules/box chars).
  let title = '';
  for (let i = firstOptLine - 1; i >= 0 && i >= firstOptLine - 6; i--) {
    const t = lines[i].replace(/[─╌╭╮╰╯│┃▔▁]+/g, '').trim();
    if (t && !/^[•·*]/.test(t) && t.length > 3) { title = t; break; }
  }
  const kind = isPlan ? 'plan' : 'question';
  // header (AskUserQuestion shows "☐ <header>" above the question)
  let header = '';
  const hm = all.match(/[☐☑▢]\s*([^\n]{1,60})/);
  if (hm) header = hm[1].trim();

  return { kind, header, title, options: opts };
}

// Convenience: buffer → parsed prompt (or null).
export function promptFromBuffer(buf) {
  return parsePrompt(screenFromBuffer(buf));
}
