#!/usr/bin/env node
// linear-lite — CLI for the box's local, account-free Linear clone.
//
//   node bin/linear-lite.mjs status                         # what's in the local DB
//   node bin/linear-lite.mjs import --key lin_api_… --team-key INC [--team-id <uuid>]
//
// `import` pushes every local issue (with its labels, comments, and workflow state) into a
// REAL Linear workspace and is idempotent — re-running only sends issues not yet imported.
// The key/team can also come from .env / EXTRA_ENV_FILE (LINEAR_API_KEY, LINEAR_TEAM_KEY,
// LINEAR_TEAM_ID) so you can just `node bin/linear-lite.mjs import` after editing .env.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createLinearLite } from '../lib/linear-lite/index.mjs';
import { importToLinear } from '../lib/linear-lite/import.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(p) {
  const out = {};
  try { for (const l of readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
  return out;
}
const dotenv = loadEnvFile(join(__dirname, '..', '.env'));
const extra = process.env.EXTRA_ENV_FILE || dotenv.EXTRA_ENV_FILE ? loadEnvFile(process.env.EXTRA_ENV_FILE || dotenv.EXTRA_ENV_FILE) : {};
const env = (k, d = '') => process.env[k] || dotenv[k] || extra[k] || d;

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  db: { type: 'string' }, key: { type: 'string' }, 'team-key': { type: 'string' },
  'team-id': { type: 'string' }, help: { type: 'boolean' },
} });
const cmd = positionals[0] || 'status';
const DB = values.db || env('LINEAR_LITE_DB') || join(homedir(), '.cc-mobile', 'linear-lite.db');

function usage() {
  console.log(`linear-lite — local Linear clone CLI

  node bin/linear-lite.mjs status
  node bin/linear-lite.mjs import --key <lin_api_…> --team-key <KEY> [--team-id <uuid>]

Options:
  --db <path>        SQLite file (default ~/.cc-mobile/linear-lite.db)
  --key <key>        real Linear API key (or set LINEAR_API_KEY)
  --team-key <KEY>   destination team key, e.g. INC (or LINEAR_TEAM_KEY)
  --team-id <uuid>   destination team id (or LINEAR_TEAM_KEY/-ID in .env)
`);
}

if (values.help || cmd === 'help') { usage(); process.exit(0); }

const lite = createLinearLite({ dbPath: DB, teamKey: env('LINEAR_TEAM_KEY') || 'TASK', needsLabel: env('NEEDS_LABEL', 'needs-me') });

async function status() {
  const t = lite.store.team;
  const issues = lite.store.listIssues(t.id);
  const open = issues.filter((i) => { const s = lite.store.getState(i.state_id); return s && !['completed', 'canceled'].includes(s.type); }).length;
  const synced = issues.filter((i) => lite.store.getSync(i.id)).length;
  console.log(`linear-lite @ ${DB}`);
  console.log(`  team:     ${t.key} — ${t.name} (${t.id})`);
  console.log(`  issues:   ${issues.length} total, ${open} open, ${issues.length - open} closed`);
  console.log(`  labels:   ${lite.store.listLabels(t.id).length}`);
  console.log(`  imported: ${synced}/${issues.length} already pushed to a real Linear`);
  if (issues.length && synced < issues.length) console.log(`\n  → import the rest: node bin/linear-lite.mjs import --key <lin_api_…> --team-key <KEY>`);
}

async function runImport() {
  const apiKey = values.key || env('LINEAR_API_KEY');
  const teamKey = values['team-key'] || env('LINEAR_TEAM_KEY');
  const teamId = values['team-id'] || env('LINEAR_TEAM_ID');
  if (!apiKey) { console.error('error: need a real Linear API key (--key or LINEAR_API_KEY)'); process.exit(1); }
  if (!teamKey && !teamId) { console.error('error: need a destination team (--team-key or --team-id)'); process.exit(1); }
  console.log(`Importing local issues → Linear team ${teamId || teamKey} …`);
  const r = await importToLinear({ store: lite.store, apiKey, teamKey, teamId, log: (m) => console.log(m) });
  console.log(`\nDone: ${r.created} created, ${r.skipped} already imported (of ${r.total}) → ${r.remoteTeam.key} (${r.remoteTeam.name}).`);
  if (r.created) console.log('Re-running is safe — already-imported issues are skipped.');
}

try {
  if (cmd === 'status') await status();
  else if (cmd === 'import') await runImport();
  else { console.error(`unknown command: ${cmd}\n`); usage(); process.exit(1); }
} catch (e) {
  console.error('linear-lite:', (e && e.message) || e);
  process.exit(1);
} finally {
  lite.close();
}
