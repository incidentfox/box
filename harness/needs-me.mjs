#!/usr/bin/env node
/**
 * needs-me.mjs — a Linear-backed "needs YOU" inbox for things only you (the human) can
 * decide. Items live as Linear issues on your team, labelled NEEDS_LABEL (default
 * "needs-me", priority Urgent=🔴 / High=🟡), so they survive compaction + new sessions
 * and render in the Box app's "needs you" tab.
 *
 *   node needs-me.mjs --list [--json]                       # open items (used by the hook)
 *   node needs-me.mjs --add "title" [--context "..."] [--urgent] [--source "..."]
 *   node needs-me.mjs --resolve ENG-123 [--note "..."]      # close (Done) + comment
 *
 * Config (env or .env-style EXTRA_ENV_FILE):
 *   LINEAR_API_KEY   (required)   your Linear personal API key
 *   LINEAR_TEAM_KEY  (required)   short team key, e.g. "ENG"  (or set LINEAR_TEAM_ID)
 *   NEEDS_LABEL      (optional)   label name, default "needs-me"  (auto-created if missing)
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

function loadEnvFile(p) {
  const out = {};
  try { for (const l of readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
  return out;
}
const fileEnv = process.env.EXTRA_ENV_FILE ? loadEnvFile(process.env.EXTRA_ENV_FILE) : {};
const env = (k, d = '') => process.env[k] || fileEnv[k] || d;

const LK = env('LINEAR_API_KEY');
const TEAM_KEY = env('LINEAR_TEAM_KEY');
const TEAM_ID_CFG = env('LINEAR_TEAM_ID');
const LABEL_NAME = env('NEEDS_LABEL', 'needs-me');

// No real key? Fall back to the box's local Linear clone (the same SQLite DB the box server
// seeds), so the "needs you" inbox works with no Linear account. LINEAR_LOCAL=off disables it.
const STATE_DB = join(homedir(), '.cc-mobile', 'linear-lite.db');
const LINEAR_LOCAL = !LK && env('LINEAR_LOCAL') !== 'off' && existsSync(STATE_DB);
let _lite = null;
if (LINEAR_LOCAL) {
  const { createLinearLite } = await import('../lib/linear-lite/index.mjs');
  _lite = createLinearLite({ dbPath: STATE_DB, teamKey: TEAM_KEY || 'TASK', needsLabel: LABEL_NAME });
}
if (!LK && !_lite) { /* no key and no local DB → silent no-op so the SessionStart hook stays quiet */ process.exit(0); }

async function gql(q, v) {
  if (_lite) return _lite.gql(q, v); // local SQLite-backed clone
  const r = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: LK },
    body: JSON.stringify({ query: q, variables: v }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

// Resolve the team's GraphQL id + states + the needs label id (cached per process).
let _team = null;
async function team() {
  if (_team) return _team;
  let node;
  if (TEAM_ID_CFG) {
    const d = await gql(`query($id:String!){team(id:$id){id key states{nodes{id name type}} labels{nodes{id name}}}}`, { id: TEAM_ID_CFG });
    node = d.team;
  } else {
    const key = TEAM_KEY || (_lite ? _lite.teamKey : '');
    if (!key) throw new Error('set LINEAR_TEAM_KEY or LINEAR_TEAM_ID');
    const d = await gql(`query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id key states{nodes{id name type}} labels{nodes{id name}}}}}`, { k: key });
    node = d.teams.nodes[0];
  }
  if (!node) throw new Error('team not found — check LINEAR_TEAM_KEY / LINEAR_TEAM_ID');
  _team = node;
  return node;
}
async function labelId(t) {
  const found = (t.labels?.nodes || []).find((l) => l.name.toLowerCase() === LABEL_NAME.toLowerCase());
  if (found) return found.id;
  const d = await gql(`mutation($i:IssueLabelCreateInput!){issueLabelCreate(input:$i){issueLabel{id}}}`, { i: { name: LABEL_NAME, teamId: t.id } });
  return d.issueLabelCreate.issueLabel.id;
}
const stateOfType = (t, types) => (t.states?.nodes || []).find((s) => types.includes(s.type));

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: {
  list: { type: 'boolean' }, json: { type: 'boolean' }, add: { type: 'boolean' }, resolve: { type: 'string' },
  context: { type: 'string' }, urgent: { type: 'boolean' }, source: { type: 'string' }, note: { type: 'string' },
} });

async function list() {
  const t = await team();
  const lid = await labelId(t);
  const d = await gql(`query($t:ID!,$l:ID!){issues(first:50,filter:{team:{id:{eq:$t}},labels:{id:{eq:$l}},state:{type:{in:["triage","backlog","unstarted","started"]}}},orderBy:updatedAt){nodes{identifier title url priority}}}`, { t: t.id, l: lid });
  const items = d.issues.nodes;
  if (a.json) { console.log(JSON.stringify(items)); return; }
  if (!items.length) return;                       // nothing open → print nothing
  const rank = (p) => (p === 1 ? 0 : p === 2 ? 1 : 2);
  items.sort((x, y) => rank(x.priority) - rank(y.priority));
  const CAP = Number(process.env.NEEDS_ME_CAP) || 6;
  const urgent = items.filter((i) => i.priority === 1).length;
  console.log(`🔔 Needs you — ${items.length} open (${urgent} 🔴), label ${LABEL_NAME}:`);
  for (const i of items.slice(0, CAP)) {
    const dot = i.priority === 1 ? '🔴' : i.priority === 2 ? '🟡' : '⚪';
    console.log(`• ${dot} ${i.identifier} ${i.title}`);
  }
  if (items.length > CAP) console.log(`  …+${items.length - CAP} more — open the Box app's "needs you" tab`);
  console.log(`Resolve: needs-me.mjs --resolve <ID> --note "<decision>"`);
}

async function add(title) {
  if (!title) { console.error('needs-me --add "title" [--context "..."] [--urgent]'); process.exit(1); }
  const t = await team();
  const lid = await labelId(t);
  const start = stateOfType(t, ['backlog', 'unstarted', 'triage']);
  const desc = `${a.context || ''}${a.source ? `\n\n_Raised by: ${a.source}_` : ''}`.trim();
  const input = { teamId: t.id, labelIds: [lid], priority: a.urgent ? 1 : 2, title: String(title).slice(0, 250), description: desc };
  if (start) input.stateId = start.id;
  const d = await gql(`mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{identifier url}}}`, { i: input });
  const iss = d.issueCreate.issue;
  console.log(`needs-me created ${iss.identifier} (${a.urgent ? '🔴 urgent' : '🟡'}): ${iss.url}`);
}

async function resolve(id) {
  const t = await team();
  const num = Number(String(id).replace(/^\D+/, ''));
  const d = await gql(`query($t:ID!,$n:Float!){issues(filter:{team:{id:{eq:$t}},number:{eq:$n}}){nodes{id identifier}}}`, { t: t.id, n: num });
  const iss = d.issues.nodes[0];
  if (!iss) { console.error(`not found: ${id}`); process.exit(1); }
  const done = stateOfType(t, ['completed']);
  if (a.note) await gql(`mutation($i:CommentCreateInput!){commentCreate(input:$i){success}}`, { i: { issueId: iss.id, body: `Resolved: ${a.note}` } });
  if (done) await gql(`mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}`, { id: iss.id, s: done.id });
  console.log(`needs-me resolved ${iss.identifier}`);
}

try {
  if (a.resolve) await resolve(a.resolve);
  else if (a.add) await add(positionals[0]);
  else await list();
} catch (e) {
  if (a.list || (!a.add && !a.resolve)) process.exit(0); // never let the hook error out
  console.error(String((e && e.message) || e)); process.exit(1);
}
