// Smoke test for linear-lite: replays the EXACT GraphQL query/mutation strings that
// server/index.mjs and harness/needs-me.mjs send to Linear, against a throwaway SQLite DB,
// and asserts the shapes come back right. Run: `node lib/linear-lite/test.mjs`.
// This is the contract: if a box endpoint's query changes, mirror it here.
import { createLinearLite } from './index.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const dbPath = join(tmpdir(), `linear-lite-test-${randomUUID()}.db`);
const lite = createLinearLite({ dbPath, teamKey: 'INC', teamName: 'IncidentFox', needsLabel: 'needs-me' });
const TEAM = lite.teamId;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

try {
  // 1) linear-meta / board: team(id) with states + labels (exact server string)
  const meta = await lite.gql(`{ team(id:"${TEAM}"){ states{ nodes{ id name type position } } labels{ nodes{ id name color } } } }`);
  ok(meta.team.states.nodes.length === 6, 'team has 6 seeded states');
  ok(meta.team.states.nodes.some((s) => s.type === 'completed'), 'has a completed state');
  ok(meta.team.labels.nodes.some((l) => l.name === 'needs-me'), 'needs-me label seeded');
  const backlog = meta.team.states.nodes.find((s) => s.type === 'backlog');
  const done = meta.team.states.nodes.find((s) => s.type === 'completed');

  // 2) needs-me --add: issueCreate via IssueCreateInput variable
  const needsLabelId = meta.team.labels.nodes.find((l) => l.name === 'needs-me').id;
  const created = await lite.gql(
    `mutation($i:IssueCreateInput!){issueCreate(input:$i){success issue{identifier url}}}`,
    { i: { teamId: TEAM, labelIds: [needsLabelId], priority: 1, title: 'Decide on pricing', description: 'Need a call on the $/bill rate', stateId: backlog.id } });
  ok(created.issueCreate.success === true, 'issueCreate success');
  ok(created.issueCreate.issue.identifier === 'INC-1', `first issue is INC-1 (got ${created.issueCreate.issue.identifier})`);

  // board-style create (inline-ish via $input) + a plain backlog ticket
  const created2 = await lite.gql(`mutation Create($input: IssueCreateInput!){ issueCreate(input:$input){ success issue{ identifier url } } }`,
    { input: { teamId: TEAM, title: 'Ship the importer', stateId: backlog.id } });
  ok(created2.issueCreate.issue.identifier === 'INC-2', 'second issue is INC-2');

  // 3) needs-attention query (exact server string, inline filter)
  const na = await lite.gql(`{ issues(first: 50, orderBy: updatedAt, filter: {
      team: { id: { eq: "${TEAM}" } },
      labels: { name: { eq: "needs-me" } },
      state: { type: { in: ["triage","backlog","unstarted","started"] } }
    }) { nodes { identifier title url priority description createdAt state { name } } } }`);
  ok(na.issues.nodes.length === 1, `needs-attention finds the 1 labeled issue (got ${na.issues.nodes.length})`);
  ok(na.issues.nodes[0].identifier === 'INC-1', 'needs-attention returns INC-1');

  // 4) fetchLinearIssue / detail: number.eq + team.key.eq, full projection
  const det = await lite.gql(`{ issues(filter:{ number:{ eq:1 }, team:{ key:{ eq:"INC" } } }){ nodes {
      id identifier title description priority url createdAt updatedAt
      state { id name type color } assignee { displayName }
      labels { nodes { id name color } }
      comments { nodes { id body createdAt user { displayName } } }
      attachments { nodes { url title } }
    } } }`);
  const issue1 = det.issues.nodes[0];
  ok(issue1 && issue1.identifier === 'INC-1', 'detail resolves INC-1 by number+key');
  ok(Array.isArray(issue1.labels.nodes) && issue1.labels.nodes[0].name === 'needs-me', 'detail shows the label');
  const gid1 = issue1.id;

  // 5) board: one multi-root aliased query (team states + active + recentDone)
  const FIELDS = 'identifier title url priority sortOrder updatedAt state { id name type position } labels { nodes { name } } assignee { displayName }';
  const board = await lite.gql(`{
    team(id:"${TEAM}"){ states{ nodes{ id name type position } } }
    active: issues(first: 250, orderBy: updatedAt, filter: {
      team: { id: { eq: "${TEAM}" } }, state: { type: { in: ["triage","backlog","unstarted","started"] } }
    }) { nodes { ${FIELDS} } }
    recentDone: issues(first: 30, orderBy: updatedAt, filter: {
      team: { id: { eq: "${TEAM}" } }, state: { type: { eq: "completed" } }
    }) { nodes { ${FIELDS} } }
  }`);
  ok(board.active.nodes.length === 2, `board active = 2 (got ${board.active.nodes.length})`);
  ok(board.recentDone.nodes.length === 0, 'board recentDone = 0');

  // 6) move: issueUpdate sortOrder + stateId (drag to In Progress)
  const started = meta.team.states.nodes.find((s) => s.type === 'started');
  const moved = await lite.gql(`mutation Move($id: String!, $input: IssueUpdateInput!){ issueUpdate(id:$id, input:$input){ success issue{ state{ name } sortOrder } } }`,
    { id: gid1, input: { stateId: started.id, sortOrder: 12.5 } });
  ok(moved.issueUpdate.success && moved.issueUpdate.issue.sortOrder === 12.5, 'move sets sortOrder');
  ok(moved.issueUpdate.issue.state.name === started.name, 'move sets state');

  // 7) commentCreate
  const cmt = await lite.gql(`mutation Comment($id: String!, $body: String!){ commentCreate(input:{ issueId:$id, body:$body }){ success } }`,
    { id: gid1, body: 'Working on it' });
  ok(cmt.commentCreate.success, 'commentCreate success');

  // 8) ensureLabelId: read team labels, then issueLabelCreate a new one
  const before = await lite.gql(`{ team(id:"${TEAM}"){ labels{ nodes{ id name } } } }`);
  ok(!before.team.labels.nodes.some((l) => l.name === 'agent:delegated'), 'agent:delegated not present yet');
  const lc = await lite.gql(`mutation L($input: IssueLabelCreateInput!){ issueLabelCreate(input:$input){ success issueLabel{ id } } }`,
    { input: { name: 'agent:delegated', teamId: TEAM, color: '#8b5cf6' } });
  ok(lc.issueLabelCreate.success && lc.issueLabelCreate.issueLabel.id, 'issueLabelCreate returns id');
  // idempotent get-or-create: creating the same label again returns the same id
  const lc2 = await lite.gql(`mutation L($input: IssueLabelCreateInput!){ issueLabelCreate(input:$input){ success issueLabel{ id } } }`,
    { input: { name: 'agent:delegated', teamId: TEAM, color: '#8b5cf6' } });
  ok(lc2.issueLabelCreate.issueLabel.id === lc.issueLabelCreate.issueLabel.id, 'label create is get-or-create');

  // 9) search: or-filter [title.containsIgnoreCase, number.eq]
  const search = await lite.gql(`{ issues(first: 25, orderBy: updatedAt, filter: {
      team: { id: { eq: "${TEAM}" } }, or: [ { title: { containsIgnoreCase: "importer" } }, { number: { eq: 99 } } ]
    }) { nodes { identifier title } } }`);
  ok(search.issues.nodes.length === 1 && search.issues.nodes[0].identifier === 'INC-2', 'search matches by title substring');

  // 10) needs-me team-by-key + resolve flow (issues number.eq, issueUpdate -> completed)
  const teamByKey = await lite.gql(`query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id key states{nodes{id name type}} labels{nodes{id name}}}}}`, { k: 'INC' });
  ok(teamByKey.teams.nodes[0].id === TEAM, 'teams(filter key) resolves the team');
  const lookup = await lite.gql(`query($t:ID!,$n:Float!){issues(filter:{team:{id:{eq:$t}},number:{eq:$n}}){nodes{id identifier}}}`, { t: TEAM, n: 1 });
  ok(lookup.issues.nodes[0].identifier === 'INC-1', 'resolve lookup by number var');
  await lite.gql(`mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}`, { id: gid1, s: done.id });
  const afterDone = await lite.gql(`{ issues(filter:{ team:{id:{eq:"${TEAM}"}}, state:{ type:{ in:["triage","backlog","unstarted","started"] } } }){ nodes{ identifier } } }`);
  ok(!afterDone.issues.nodes.some((n) => n.identifier === 'INC-1'), 'INC-1 leaves the open set once Done');

  // 11) pagination: first + after cursor
  const page1 = await lite.gql(`{ issues(first: 1, orderBy: createdAt, filter:{ team:{id:{eq:"${TEAM}"}} }){ nodes{ identifier } pageInfo{ hasNextPage endCursor } } }`);
  ok(page1.issues.nodes.length === 1 && page1.issues.pageInfo.hasNextPage, 'page 1 has next');
  const page2 = await lite.gql(`{ issues(first: 1, after: "${page1.issues.pageInfo.endCursor}", orderBy: createdAt, filter:{ team:{id:{eq:"${TEAM}"}} }){ nodes{ identifier } } }`);
  ok(page2.issues.nodes.length === 1 && page2.issues.nodes[0].identifier !== page1.issues.nodes[0].identifier, 'page 2 is a different issue');
} catch (e) {
  fail++; console.error('  ✗ threw:', e && e.stack || e);
} finally {
  lite.close();
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbPath + ext); } catch {} }
}

console.log(`linear-lite test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
