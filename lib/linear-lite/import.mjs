// import.mjs — push everything from the local linear-lite clone INTO a real Linear workspace.
// Idempotent: each local issue records the real issue it became (linear_sync table), so a
// re-run skips already-imported issues. Labels are matched/created by name; workflow states
// are mapped by Linear "type" (backlog/started/completed/…) so a Done local issue lands Done.
//
// Used by `node bin/linear-lite.mjs import --key <lin_api_…> --team-key <KEY>`.

const ENDPOINT = 'https://api.linear.app/graphql';

// Hidden marker we drop in each imported issue's description — a second dedupe net in case the
// local sync table is ever lost (you could grep Linear for it before a re-import).
const refMarker = (identifier) => `\n\n<!-- imported-from-linear-lite:${identifier} -->`;

export async function importToLinear({ store, apiKey, teamKey, teamId, log = () => {} }) {
  if (!apiKey) throw new Error('a real Linear API key is required (--key or LINEAR_API_KEY)');
  async function rgql(query, variables) {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
    return j.data;
  }

  // 1) resolve the destination team (by id, else by key)
  let remoteTeam;
  if (teamId) {
    remoteTeam = (await rgql(`query($id:String!){team(id:$id){id key name states{nodes{id name type position}} labels{nodes{id name}}}}`, { id: teamId })).team;
  } else if (teamKey) {
    remoteTeam = (await rgql(`query($k:String!){teams(filter:{key:{eq:$k}}){nodes{id key name states{nodes{id name type position}} labels{nodes{id name}}}}}`, { k: teamKey })).teams.nodes[0];
  } else {
    throw new Error('specify --team-key or --team-id for the destination Linear team');
  }
  if (!remoteTeam) throw new Error(`destination team not found (${teamId || teamKey}) in the target workspace`);

  // map state TYPE -> remote state id (first by position), and labels by lowercased name
  const stateByType = {};
  for (const s of [...remoteTeam.states.nodes].sort((a, b) => a.position - b.position)) {
    if (!(s.type in stateByType)) stateByType[s.type] = s.id;
  }
  const labelId = new Map(remoteTeam.labels.nodes.map((l) => [l.name.toLowerCase(), l.id]));
  async function ensureLabel(name, color) {
    const k = name.toLowerCase();
    if (labelId.has(k)) return labelId.get(k);
    try {
      const c = await rgql(`mutation($i:IssueLabelCreateInput!){issueLabelCreate(input:$i){success issueLabel{id}}}`, { i: { teamId: remoteTeam.id, name, color: color || '#8b5cf6' } });
      const id = c.issueLabelCreate && c.issueLabelCreate.issueLabel && c.issueLabelCreate.issueLabel.id;
      if (id) labelId.set(k, id);
      return id;
    } catch { return null; }
  }

  // 2) replay each local issue (oldest first so numbering reads naturally)
  const localTeam = store.team;
  const rows = store.listIssues(localTeam.id).sort((a, b) => a.number - b.number);
  let created = 0, skipped = 0;
  const mapping = [];
  for (const row of rows) {
    if (store.getSync(row.id)) { skipped++; continue; } // already imported
    const it = store.hydrateIssue(row);
    const labelIds = [];
    for (const l of it.labels.nodes) { const id = await ensureLabel(l.name, l.color); if (id) labelIds.push(id); }
    const input = {
      teamId: remoteTeam.id,
      title: it.title,
      description: (it.description || '') + refMarker(it.identifier),
      priority: it.priority || 0,
    };
    if (labelIds.length) input.labelIds = labelIds;
    const res = await rgql(`mutation($i:IssueCreateInput!){issueCreate(input:$i){success issue{id identifier url}}}`, { i: input });
    const remote = res.issueCreate && res.issueCreate.issue;
    if (!remote) { log(`  ✗ failed to create remote issue for ${it.identifier}`); continue; }
    // replay comments in order
    for (const c of it.comments.nodes) {
      try { await rgql(`mutation($i:CommentCreateInput!){commentCreate(input:$i){success}}`, { i: { issueId: remote.id, body: c.body } }); } catch {}
    }
    // move to the matching workflow state (so Done/Canceled/In-Progress land correctly)
    const sid = stateByType[it.state && it.state.type];
    if (sid) { try { await rgql(`mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}`, { id: remote.id, s: sid }); } catch {} }
    store.putSync({ localId: row.id, remoteId: remote.id, remoteIdentifier: remote.identifier, syncedAt: new Date().toISOString() });
    created++;
    mapping.push({ from: it.identifier, to: remote.identifier, url: remote.url });
    log(`  ↳ ${it.identifier} → ${remote.identifier}`);
  }
  return { created, skipped, total: rows.length, remoteTeam: { id: remoteTeam.id, key: remoteTeam.key, name: remoteTeam.name }, mapping };
}
