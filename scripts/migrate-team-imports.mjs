#!/usr/bin/env node
// Import the explicitly requested historical chats into the canonical team workspace.
// This intentionally copies only regular, non-secret files explicitly referenced by a
// transcript; it never snapshots an arbitrary host checkout into team space.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { defaultWorkspaceRoot, releaseSession, setShared } from '../server/team.mjs';

const HOME = homedir();
const STATE = join(HOME, '.cc-mobile');
const CODEX = join(STATE, 'codex-sessions.json');
const MESSAGES = join(STATE, 'codex-messages');
const DEST_ROOT = join(defaultWorkspaceRoot(), 'imports');
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

const IMPORTS = [
  { sourceId: '019fb92e-ede4-75a3-a006-c85842b5e7b3', id: 'team-import-calldoc', folder: 'calldoc', title: 'CallDoc' },
  { sourceId: '019f7409-e58f-76f1-a5b7-826076cd4e03', id: 'team-import-call-pharmacy', folder: 'call-pharmacy', title: 'Call pharmacy' },
];
const ROSE_LEGACY_SESSION = '62682a85-589d-40e5-b5b9-d26cbcfedd90';
const HOST_ROOT = resolve(HOME);

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}
function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function inside(path, root) {
  const r = relative(root, path);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !r.includes(`..${sep}`));
}
function safeArtifact(source) {
  let real;
  try {
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    real = realpathSync(source);
  } catch { return null; }
  if (!inside(real, HOST_ROOT)) return null;
  const parts = relative(HOST_ROOT, real).split(sep);
  if (parts.some((p) => p === '.git' || p === 'node_modules' || p === '.ssh' || p === '.codex' || p === '.claude' || p === '.config' || p === '.cc-mobile')) return null;
  const name = basename(real).toLowerCase();
  if (name === '.env' || name.startsWith('.env.') || /secret|credential|token|private.?key/.test(name)) return null;
  return real;
}
function transcriptPaths(messages) {
  const found = new Set();
  const scan = (value) => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\/home\/factory\/(?:development|\.factory)\/[A-Za-z0-9_./@+=,:-]+/g)) found.add(m[0]);
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === 'object') Object.values(value).forEach(scan);
  };
  scan(messages);
  return [...found];
}

const state = loadJson(CODEX, { sessions: {} });
state.sessions ||= {};
let copiedFiles = 0;
let copiedBytes = 0;
const imported = [];

for (const item of IMPORTS) {
  const source = state.sessions[item.sourceId];
  if (!source) throw new Error(`Expected source chat is missing: ${item.sourceId}`);
  const destination = join(DEST_ROOT, item.folder);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const sourceMessages = loadJson(join(MESSAGES, `${item.sourceId}.json`), []);
  const messages = Array.isArray(sourceMessages) ? sourceMessages : [];
  const artifacts = [];
  for (const raw of transcriptPaths(messages)) {
    const file = safeArtifact(raw);
    if (!file || copiedBytes + lstatSync(file).size > MAX_TOTAL_BYTES) continue;
    const target = join(destination, 'artifacts', relative(HOST_ROOT, file));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (!existsSync(target)) {
      copyFileSync(file, target);
      copiedFiles += 1;
      copiedBytes += lstatSync(file).size;
    }
    artifacts.push(relative(destination, target));
  }
  atomicJson(join(destination, 'import.json'), {
    importedAt: new Date().toISOString(), sourceSessionId: item.sourceId, sourceTitle: source.title || item.title,
    copiedArtifacts: artifacts,
  });
  // Imported history is view-only provenance. A future message starts a new Codex
  // conversation inside the sandbox; it must never resume the original host process.
  const { sessionId: _oldSessionId, ...sourceMeta } = source;
  state.sessions[item.id] = {
    ...sourceMeta,
    id: item.id,
    // Keep the durable record unambiguously in the hardened execution class,
    // even if the shared-session index is ever repaired or rebuilt.
    teamSandbox: true,
    title: `Imported — ${source.title || item.title}`,
    cwd: destination,
    importedFrom: item.sourceId,
    importedAt: Date.now(),
  };
  atomicJson(join(MESSAGES, `${item.id}.json`), messages);
  if (!setShared(item.id, true, 'owner', destination)) throw new Error(`Could not share import ${item.id}`);
  imported.push(item.id);
}
atomicJson(CODEX, state);

// Rose remains an active member, but her pre-sandbox guest session is no longer an
// accessible Team record. Her next chat starts in the isolated shared workspace.
const releasedLegacySession = releaseSession(ROSE_LEGACY_SESSION);
process.stdout.write(`${JSON.stringify({ imported, copiedFiles, copiedBytes, releasedLegacySession })}\n`);
