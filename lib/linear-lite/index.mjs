// linear-lite — a local, account-free clone of the slice of Linear's GraphQL API that the
// Box app (and the optional harness) actually use. Backed by one SQLite file; speaks enough
// of Linear's schema that the EXISTING query strings in server/index.mjs + needs-me.mjs run
// against it unchanged. When a friend later supplies a real Linear API key, ./import.mjs
// replays the local issues into their workspace.
//
//   const lite = createLinearLite({ dbPath: '~/.cc-mobile/linear-lite.db', teamKey: 'TASK' });
//   await lite.gql('{ issues(first:5){ nodes{ identifier title } } }');   // -> { issues: { nodes: [...] } }
//
// Design note: every query/mutation root returns a FULLY-hydrated plain object, so we lean on
// graphql-js's default field resolver for projection (aliases, nested selections) — no per-
// type resolver map to keep in sync with Linear's field names.
import { graphql, buildSchema } from 'graphql';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';

const SDL = `
scalar DateTime

enum PaginationOrderBy { createdAt updatedAt }

type PageInfo { hasNextPage: Boolean!, endCursor: String, hasPreviousPage: Boolean!, startCursor: String }
type User { id: ID!, name: String, displayName: String }
type WorkflowState { id: ID!, name: String!, type: String!, position: Float!, color: String }
type WorkflowStateConnection { nodes: [WorkflowState!]! }
type IssueLabel { id: ID!, name: String!, color: String }
type IssueLabelConnection { nodes: [IssueLabel!]! }
type Comment { id: ID!, body: String!, createdAt: DateTime!, user: User, issue: Issue }
type CommentConnection { nodes: [Comment!]! }
type Attachment { id: ID!, url: String!, title: String }
type AttachmentConnection { nodes: [Attachment!]! }

type Team {
  id: ID!, key: String!, name: String!
  states: WorkflowStateConnection!
  labels: IssueLabelConnection!
}
type TeamConnection { nodes: [Team!]! }

type Issue {
  id: ID!, number: Float!, identifier: String!, title: String!, description: String
  priority: Int, sortOrder: Float, url: String, createdAt: DateTime!, updatedAt: DateTime!
  state: WorkflowState, assignee: User, team: Team
  labels: IssueLabelConnection!, comments: CommentConnection!, attachments: AttachmentConnection!
}
type IssueConnection { nodes: [Issue!]!, pageInfo: PageInfo! }

input IDComparator { eq: ID, in: [ID!], nin: [ID!], null: Boolean }
input StringComparator { eq: String, in: [String!], nin: [String!], contains: String, containsIgnoreCase: String }
input NumberComparator { eq: Float, in: [Float!], nin: [Float!], lt: Float, lte: Float, gt: Float, gte: Float }
input TeamFilter { id: IDComparator, key: StringComparator }
input WorkflowStateFilter { id: IDComparator, name: StringComparator, type: StringComparator }
input IssueLabelFilter { id: IDComparator, name: StringComparator }

input IssueFilter {
  id: IDComparator
  number: NumberComparator
  title: StringComparator
  team: TeamFilter
  state: WorkflowStateFilter
  labels: IssueLabelFilter
  and: [IssueFilter!]
  or: [IssueFilter!]
}
input CommentFilter { issue: IssueFilter }

input IssueCreateInput {
  teamId: String!, title: String!, description: String, stateId: String
  labelIds: [String!], priority: Int, sortOrder: Float, assigneeId: String
}
input IssueUpdateInput {
  title: String, description: String, stateId: String, labelIds: [String!]
  addedLabelIds: [String!], removedLabelIds: [String!], priority: Int, sortOrder: Float, assigneeId: String
}
input CommentCreateInput { issueId: String!, body: String! }
input IssueLabelCreateInput { teamId: String!, name: String!, color: String }

type IssuePayload { success: Boolean!, issue: Issue }
type CommentPayload { success: Boolean!, comment: Comment }
type IssueLabelPayload { success: Boolean!, issueLabel: IssueLabel }

type Query {
  issues(first: Int, after: String, orderBy: PaginationOrderBy, filter: IssueFilter): IssueConnection!
  issue(id: String!): Issue
  team(id: String!): Team
  teams(filter: TeamFilter): TeamConnection!
  comments(first: Int, after: String, orderBy: PaginationOrderBy, filter: CommentFilter): CommentConnection!
  issueLabels(first: Int, filter: IssueLabelFilter): IssueLabelConnection!
}
type Mutation {
  issueCreate(input: IssueCreateInput!): IssuePayload!
  issueUpdate(id: String!, input: IssueUpdateInput!): IssuePayload!
  commentCreate(input: CommentCreateInput!): CommentPayload!
  issueLabelCreate(input: IssueLabelCreateInput!): IssueLabelPayload!
}
`;

const schema = buildSchema(SDL);

// ---- filter evaluation (Linear comparators -> JS predicates) -----------------
function cmpOk(cmp, value) {
  if (cmp == null) return true;
  if (cmp.eq != null && String(value) !== String(cmp.eq)) return false;
  if (Array.isArray(cmp.in) && !cmp.in.map(String).includes(String(value))) return false;
  if (Array.isArray(cmp.nin) && cmp.nin.map(String).includes(String(value))) return false;
  if (cmp.contains != null && !String(value).includes(cmp.contains)) return false;
  if (cmp.containsIgnoreCase != null && !String(value).toLowerCase().includes(String(cmp.containsIgnoreCase).toLowerCase())) return false;
  if (cmp.lt != null && !(Number(value) < cmp.lt)) return false;
  if (cmp.lte != null && !(Number(value) <= cmp.lte)) return false;
  if (cmp.gt != null && !(Number(value) > cmp.gt)) return false;
  if (cmp.gte != null && !(Number(value) >= cmp.gte)) return false;
  return true;
}
function issueMatches(it, f) {
  if (!f) return true;
  if (Array.isArray(f.and) && !f.and.every((x) => issueMatches(it, x))) return false;
  if (Array.isArray(f.or) && f.or.length && !f.or.some((x) => issueMatches(it, x))) return false;
  if (f.id && !cmpOk(f.id, it.id)) return false;
  if (f.number && !cmpOk(f.number, it.number)) return false;
  if (f.title && !cmpOk(f.title, it.title)) return false;
  if (f.team) {
    if (f.team.id && !cmpOk(f.team.id, it.team && it.team.id)) return false;
    if (f.team.key && !cmpOk(f.team.key, it.team && it.team.key)) return false;
  }
  if (f.state) {
    const s = it.state || {};
    if (f.state.id && !cmpOk(f.state.id, s.id)) return false;
    if (f.state.type && !cmpOk(f.state.type, s.type)) return false;
    if (f.state.name && !cmpOk(f.state.name, s.name)) return false;
  }
  if (f.labels) {
    const ok = (it.labels.nodes || []).some((l) =>
      (!f.labels.id || cmpOk(f.labels.id, l.id)) && (!f.labels.name || cmpOk(f.labels.name, l.name)));
    if (!ok) return false;
  }
  return true;
}

const encCursor = (n) => Buffer.from(`o:${n}`).toString('base64');
const decCursor = (c) => { try { return Number(Buffer.from(c, 'base64').toString('utf8').replace(/^o:/, '')) || 0; } catch { return 0; } };
// If the filter scopes to a single team, hand SQLite the team id so we don't load the world.
function scopedTeamId(store, filter) {
  const t = filter && filter.team;
  if (!t) return null;
  if (t.id && t.id.eq) return t.id.eq;
  if (t.key && t.key.eq) { const team = store.getTeamByKey(t.key.eq); return team ? team.id : '__none__'; }
  return null;
}

export function createLinearLite({ dbPath, teamKey = 'TASK', teamName = 'Tasks', needsLabel = 'needs-me', urlForIssue } = {}) {
  const store = new Store({ dbPath, teamKey, teamName, needsLabel });
  const team = store.team;
  const urlFor = typeof urlForIssue === 'function' ? urlForIssue : () => '';
  const now = () => new Date().toISOString();

  const root = {
    // ---- queries ----
    issues({ first, after, orderBy, filter }) {
      const teamId = scopedTeamId(store, filter);
      const items = store.listIssues(teamId === '__none__' ? null : teamId)
        .map((r) => store.hydrateIssue(r))
        .filter((it) => (teamId === '__none__' ? false : issueMatches(it, filter)));
      const key = orderBy === 'createdAt' ? 'createdAt' : 'updatedAt';
      items.sort((a, b) => Date.parse(b[key]) - Date.parse(a[key])); // most-recent first
      const start = after ? decCursor(after) : 0;
      const lim = first == null ? 50 : first;
      const slice = items.slice(start, start + lim);
      return {
        nodes: slice,
        pageInfo: {
          hasNextPage: start + lim < items.length, endCursor: encCursor(start + slice.length),
          hasPreviousPage: start > 0, startCursor: encCursor(start),
        },
      };
    },
    issue({ id }) {
      const byId = store.getIssueById(id);
      if (byId) return store.hydrateIssue(byId);
      // also accept an INC-style identifier
      const m = String(id || '').match(/^([A-Za-z]+)-(\d+)$/);
      if (m) { const t = store.getTeamByKey(m[1].toUpperCase()); if (t) { const r = store.getIssueByNumber(t.id, Number(m[2])); if (r) return store.hydrateIssue(r); } }
      return null;
    },
    team({ id }) { const t = store.resolveTeam(id); return t ? store.hydrateTeam(t) : null; },
    teams({ filter } = {}) {
      let teams = store.listTeams();
      if (filter && filter.key) teams = teams.filter((t) => cmpOk(filter.key, t.key));
      if (filter && filter.id) teams = teams.filter((t) => cmpOk(filter.id, t.id));
      return { nodes: teams.map((t) => store.hydrateTeam(t)) };
    },
    comments({ first, filter }) {
      let all = [];
      for (const it of store.listIssues(scopedTeamId(store, filter && filter.issue))) {
        const hy = store.hydrateIssue(it);
        if (filter && filter.issue && !issueMatches(hy, filter.issue)) continue;
        for (const c of hy.comments.nodes) all.push({ ...c, issue: hy });
      }
      all.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      return { nodes: first == null ? all : all.slice(0, first) };
    },
    issueLabels({ filter }) {
      const teamId = filter && filter.team ? scopedTeamId(store, { team: filter.team }) : team.id;
      let labels = store.listLabels(teamId === '__none__' || !teamId ? team.id : teamId).map((l) => store.hydrateLabel(l));
      if (filter && filter.name) labels = labels.filter((l) => cmpOk(filter.name, l.name));
      if (filter && filter.id) labels = labels.filter((l) => cmpOk(filter.id, l.id));
      return { nodes: labels };
    },

    // ---- mutations ----
    issueCreate({ input }) {
      const t = store.resolveTeam(input.teamId);
      if (!t) throw new Error(`team not found: ${input.teamId}`);
      const number = store.nextNumber(t.id);
      const identifier = `${t.key}-${number}`;
      const id = randomUUID();
      const at = now();
      const stateId = input.stateId || (store.defaultState(t.id) || {}).id || null;
      store.insertIssue({
        id, teamId: t.id, number, identifier, title: input.title, description: input.description || '',
        priority: input.priority || 0, sortOrder: input.sortOrder != null ? input.sortOrder : 0,
        stateId, assigneeId: input.assigneeId || null, url: urlFor(identifier), createdAt: at, updatedAt: at,
      });
      if (Array.isArray(input.labelIds)) store.setIssueLabels(id, input.labelIds);
      return { success: true, issue: store.hydrateIssue(store.getIssueById(id)) };
    },
    issueUpdate({ id, input }) {
      const row = store.getIssueById(id) || (() => { const r = root.issue({ id }); return r ? store.getIssueById(r.id) : null; })();
      if (!row) throw new Error(`issue not found: ${id}`);
      const fields = {};
      if (input.title != null) fields.title = input.title;
      if (input.description != null) fields.description = input.description;
      if (input.stateId != null) fields.state_id = input.stateId;
      if (input.priority != null) fields.priority = input.priority;
      if (input.sortOrder != null) fields.sort_order = input.sortOrder;
      if (input.assigneeId !== undefined) fields.assignee_id = input.assigneeId;
      fields.updated_at = now();
      store.updateIssue(row.id, fields);
      if (Array.isArray(input.labelIds)) store.setIssueLabels(row.id, input.labelIds);
      if (Array.isArray(input.addedLabelIds)) store.addIssueLabels(row.id, input.addedLabelIds);
      if (Array.isArray(input.removedLabelIds)) store.removeIssueLabels(row.id, input.removedLabelIds);
      return { success: true, issue: store.hydrateIssue(store.getIssueById(row.id)) };
    },
    commentCreate({ input }) {
      const row = store.getIssueById(input.issueId);
      if (!row) throw new Error(`issue not found: ${input.issueId}`);
      const id = randomUUID();
      const at = now();
      store.insertComment({ id, issueId: input.issueId, body: input.body, userId: null, createdAt: at });
      store.touchIssue(input.issueId, at);
      return { success: true, comment: { id, body: input.body, createdAt: at, user: null, issue: null } };
    },
    issueLabelCreate({ input }) {
      const t = store.resolveTeam(input.teamId);
      if (!t) throw new Error(`team not found: ${input.teamId}`);
      const lbl = store.getLabelByName(t.id, input.name) || store.insertLabel({ teamId: t.id, name: input.name, color: input.color });
      return { success: true, issueLabel: { id: lbl.id, name: lbl.name, color: lbl.color } };
    },
  };

  async function gql(query, variables) {
    const res = await graphql({ schema, source: query, rootValue: root, variableValues: variables || {} });
    if (res.errors && res.errors.length) throw new Error(res.errors.map((e) => e.message).join('; '));
    return res.data;
  }

  return { teamId: team.id, teamKey: team.key, teamName: team.name, gql, store, schema, root, close: () => store.close() };
}
