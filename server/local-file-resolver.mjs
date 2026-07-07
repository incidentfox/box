import { readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const LOCAL_PATH_ALLOWED_RE = /^(?:~|\/(?:tmp|home|opt|var|run|mnt|Volumes|Users))(?:\/|$)/;
export const FILE_SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo']);
export const FILE_SEARCH_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif|tiff?|pdf|csv|tsv|xlsx?|docx?|pptx?|txt|log|md|markdown|json|ya?ml|html?|xml|zip|tar|gz|tgz|mp4|mov|webm|m4v|mkv|mp3|wav|m4a|aac|ogg|flac)$/i;

export function cleanPathToken(raw) {
  let s = String(raw || '').trim().replace(/^['"`]+|['"`]+$/g, '');
  while (/[.,;:!?]$/.test(s)) s = s.slice(0, -1);
  return s;
}

export function createLocalFileResolver({
  HOME = homedir(),
  STATE_DIR = join(HOME, '.cc-mobile'),
  UPLOAD_DIR = join(STATE_DIR, 'uploads'),
  defaultCwd = HOME,
  searchRoots = [],
} = {}) {
  const DEFAULT_CWD = defaultCwd || HOME;

  function expandLocalPathToken(raw, cwd = DEFAULT_CWD) {
    const s = cleanPathToken(raw);
    if (!s) return '';
    if (s === '~') return HOME;
    if (s.startsWith('~/')) return resolve(join(HOME, s.slice(2)));
    if (s.startsWith('/') && LOCAL_PATH_ALLOWED_RE.test(s)) return resolve(s);
    if (/^\.\.?(?:\/|$)/.test(s) || s.includes('/') || FILE_SEARCH_EXT_RE.test(s)) return resolve(cwd || DEFAULT_CWD, s.replace(/^\.\//, ''));
    return '';
  }

  function localFileResult(path) {
    try {
      const st = statSync(path);
      return st.isFile() ? { found: true, path, size: st.size, mtime: st.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  function uniqueSearchRoots(cwd = DEFAULT_CWD, raw = '') {
    const roots = [UPLOAD_DIR, STATE_DIR, cwd, DEFAULT_CWD, ...searchRoots, join(HOME, 'development'), '/tmp'];
    const expanded = expandLocalPathToken(raw, cwd);
    if (expanded && expanded.startsWith('/')) roots.unshift(resolve(expanded, '..'));
    const out = [];
    for (const root of roots) {
      if (!root) continue;
      let real = '';
      try {
        const st = statSync(root);
        if (!st.isDirectory()) continue;
        real = resolve(root);
      } catch {
        continue;
      }
      if (!out.includes(real)) out.push(real);
    }
    return out;
  }

  function findFileByBasename(name, roots) {
    if (!name || name.length < 3 || !FILE_SEARCH_EXT_RE.test(name)) return null;
    const lower = name.toLowerCase();
    const deadline = Date.now() + 160;
    let seen = 0;
    for (const root of roots) {
      const stack = [root];
      while (stack.length && seen < 7000 && Date.now() < deadline) {
        const dir = stack.pop();
        let entries = [];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (++seen > 7000 || Date.now() >= deadline) break;
          const p = join(dir, e.name);
          if (e.isFile() && (e.name === name || e.name.toLowerCase() === lower)) {
            const hit = localFileResult(p);
            if (hit) return hit;
          } else if (e.isDirectory() && !FILE_SEARCH_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
            stack.push(p);
          }
        }
      }
    }
    return null;
  }

  function resolveLocalFileReference(raw, cwd = DEFAULT_CWD) {
    const token = cleanPathToken(raw);
    if (!token) return { found: false };
    const expanded = expandLocalPathToken(token, cwd);
    if (expanded) {
      const exact = localFileResult(expanded);
      if (exact) return exact;
    }
    const base = basename(expanded || token);
    const hit = findFileByBasename(base, uniqueSearchRoots(cwd, token));
    return hit || { found: false };
  }

  return {
    cleanPathToken,
    expandLocalPathToken,
    localFileResult,
    uniqueSearchRoots,
    findFileByBasename,
    resolveLocalFileReference,
  };
}
