// store.mjs — SQLite persistence for linear-lite (the local, account-free Linear clone).
//
// Pure data-access layer: opens/creates the DB, seeds a default team + workflow states +
// the "needs you" label on first run, and exposes row-level CRUD plus a `hydrateIssue`
// helper that materializes an issue into the exact nested shape Linear's GraphQL returns
// (so the GraphQL layer can lean on graphql-js's default field resolvers).
//
// One SQLite file (WAL mode) is shared by the box server AND the harness CLIs (needs-me.mjs,
// bin/linear-lite.mjs); WAL + a busy_timeout make those concurrent readers/writers safe.
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, key TEXT UNIQUE, name TEXT
);
CREATE TABLE IF NOT EXISTS workflow_states (
  id TEXT PRIMARY KEY, team_id TEXT, name TEXT, type TEXT, position REAL, color TEXT
);
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY, team_id TEXT, name TEXT, color TEXT, UNIQUE(team_id, name)
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY, team_id TEXT, number INTEGER, identifier TEXT,
  title TEXT, description TEXT, priority INTEGER DEFAULT 0, sort_order REAL DEFAULT 0,
  state_id TEXT, assignee_id TEXT, url TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id TEXT, label_id TEXT, UNIQUE(issue_id, label_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, issue_id TEXT, body TEXT, user_id TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT, display_name TEXT
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, issue_id TEXT, url TEXT, title TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  team_id TEXT PRIMARY KEY, next_number INTEGER
);
-- Maps a local issue to the issue it became in a real Linear workspace, so re-running
-- the importer is idempotent (we never double-file the same ticket).
CREATE TABLE IF NOT EXISTS linear_sync (
  local_id TEXT PRIMARY KEY, remote_id TEXT, remote_identifier TEXT, synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_team ON issues(team_id);
CREATE INDEX IF NOT EXISTS idx_issue_labels_issue ON issue_labels(issue_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
`;

// The default workflow — one row per Linear state "type". Names are friendly; `type` is what
// every query/filter keys on (triage/backlog/unstarted/started/completed/canceled).
const DEFAULT_STATES = [
  { name: 'Backlog', type: 'backlog', position: 0, color: '#bec2c8' },
  { name: 'Todo', type: 'unstarted', position: 1, color: '#e2e2e2' },
  { name: 'In Progress', type: 'started', position: 2, color: '#f2c94c' },
  { name: 'In Review', type: 'started', position: 3, color: '#5e6ad2' },
  { name: 'Done', type: 'completed', position: 4, color: '#5e9e6e' },
  { name: 'Canceled', type: 'canceled', position: 5, color: '#95a2b3' },
];

export class Store {
  constructor({ dbPath, teamKey = 'TASK', teamName = 'Tasks', needsLabel = 'needs-me' }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.team = this.#seed({ teamKey, teamName, needsLabel });
  }

  // Idempotent first-run seed. UNIQUE(teams.key) means a concurrent racer's INSERT no-ops
  // and we read the winner back — so the box server and a CLI can both open a fresh DB.
  #seed({ teamKey, teamName, needsLabel }) {
    const ensureNeedsLabel = (team) => {
      if (needsLabel && !this.getLabelByName(team.id, needsLabel)) {
        this.insertLabel({ teamId: team.id, name: needsLabel, color: '#f2994a' });
      }
      return team;
    };
    const existing = this.getTeamByKey(teamKey);
    if (existing) return ensureNeedsLabel(existing);
    // A box is single-team. If this DB already has a team (e.g. seeded by the box server with
    // a different configured key than a CLI happens to see), ADOPT it rather than creating a
    // parallel empty team — that prevents orphan teams from a transient env difference. The
    // configured teamKey only takes effect on a brand-new DB.
    const all = this.listTeams();
    if (all.length) return ensureNeedsLabel(all[0]);
    const teamId = randomUUID();
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO teams (id, key, name) VALUES (?,?,?)').run(teamId, teamKey, teamName);
      const team = this.getTeamByKey(teamKey); // the winner (us, or a racer)
      if (team.id !== teamId) return team;      // someone else seeded first
      this.db.prepare('INSERT OR IGNORE INTO counters (team_id, next_number) VALUES (?, 1)').run(team.id);
      const ins = this.db.prepare('INSERT INTO workflow_states (id, team_id, name, type, position, color) VALUES (?,?,?,?,?,?)');
      for (const s of DEFAULT_STATES) ins.run(randomUUID(), team.id, s.name, s.type, s.position, s.color);
      if (needsLabel) this.db.prepare('INSERT OR IGNORE INTO labels (id, team_id, name, color) VALUES (?,?,?,?)').run(randomUUID(), team.id, needsLabel, '#f2994a');
      return team;
    });
    return tx() || this.getTeamByKey(teamKey);
  }

  // ---- teams / states / labels ----------------------------------------------
  getTeamById(id) { return this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id); }
  getTeamByKey(key) { return this.db.prepare('SELECT * FROM teams WHERE key = ?').get(key); }
  listTeams() { return this.db.prepare('SELECT * FROM teams').all(); }
  resolveTeam(idOrKey) { return this.getTeamById(idOrKey) || this.getTeamByKey(idOrKey); }

  listStates(teamId) { return this.db.prepare('SELECT * FROM workflow_states WHERE team_id = ? ORDER BY position').all(teamId); }
  getState(id) { return this.db.prepare('SELECT * FROM workflow_states WHERE id = ?').get(id); }
  defaultState(teamId) {
    const states = this.listStates(teamId);
    for (const type of ['backlog', 'unstarted', 'triage']) {
      const s = states.find((x) => x.type === type); if (s) return s;
    }
    return states[0] || null;
  }
  stateOfType(teamId, types) { return this.listStates(teamId).find((s) => types.includes(s.type)) || null; }

  listLabels(teamId) { return this.db.prepare('SELECT * FROM labels WHERE team_id = ? ORDER BY name').all(teamId); }
  getLabelById(id) { return this.db.prepare('SELECT * FROM labels WHERE id = ?').get(id); }
  getLabelByName(teamId, name) { return this.db.prepare('SELECT * FROM labels WHERE team_id = ? AND lower(name) = lower(?)').get(teamId, name); }
  insertLabel({ teamId, name, color = '#8b5cf6' }) {
    const id = randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO labels (id, team_id, name, color) VALUES (?,?,?,?)').run(id, teamId, name, color);
    return this.getLabelByName(teamId, name);
  }

  // ---- users ----------------------------------------------------------------
  getUser(id) { return id ? this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null; }

  // ---- issues ---------------------------------------------------------------
  nextNumber(teamId) {
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO counters (team_id, next_number) VALUES (?, 1)').run(teamId);
      const row = this.db.prepare('SELECT next_number FROM counters WHERE team_id = ?').get(teamId);
      const n = row.next_number;
      this.db.prepare('UPDATE counters SET next_number = ? WHERE team_id = ?').run(n + 1, teamId);
      return n;
    });
    return tx();
  }
  insertIssue(row) {
    this.db.prepare(`INSERT INTO issues
      (id, team_id, number, identifier, title, description, priority, sort_order, state_id, assignee_id, url, created_at, updated_at)
      VALUES (@id, @teamId, @number, @identifier, @title, @description, @priority, @sortOrder, @stateId, @assigneeId, @url, @createdAt, @updatedAt)`)
      .run({ assigneeId: null, description: '', priority: 0, sortOrder: 0, ...row });
    return row.id;
  }
  getIssueById(id) { return this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id); }
  getIssueByNumber(teamId, number) { return this.db.prepare('SELECT * FROM issues WHERE team_id = ? AND number = ?').get(teamId, number); }
  listIssues(teamId) {
    return teamId
      ? this.db.prepare('SELECT * FROM issues WHERE team_id = ?').all(teamId)
      : this.db.prepare('SELECT * FROM issues').all();
  }
  updateIssue(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    const set = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(`UPDATE issues SET ${set} WHERE id = @id`).run({ ...fields, id });
  }
  touchIssue(id, when) { this.db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(when, id); }

  // ---- labels on issues -----------------------------------------------------
  issueLabelRows(issueId) {
    return this.db.prepare(`SELECT l.* FROM labels l JOIN issue_labels il ON il.label_id = l.id
      WHERE il.issue_id = ? ORDER BY l.name`).all(issueId);
  }
  setIssueLabels(issueId, labelIds) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(issueId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?,?)');
      for (const lid of labelIds || []) ins.run(issueId, lid);
    });
    tx();
  }
  addIssueLabels(issueId, labelIds) {
    const ins = this.db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?,?)');
    for (const lid of labelIds || []) ins.run(issueId, lid);
  }
  removeIssueLabels(issueId, labelIds) {
    const del = this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?');
    for (const lid of labelIds || []) del.run(issueId, lid);
  }

  // ---- comments / attachments ----------------------------------------------
  insertComment({ id, issueId, body, userId = null, createdAt }) {
    this.db.prepare('INSERT INTO comments (id, issue_id, body, user_id, created_at) VALUES (?,?,?,?,?)')
      .run(id, issueId, body, userId, createdAt);
  }
  listComments(issueId) { return this.db.prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at').all(issueId); }
  listAttachments(issueId) { return this.db.prepare('SELECT * FROM attachments WHERE issue_id = ? ORDER BY created_at').all(issueId); }

  // ---- import bookkeeping ---------------------------------------------------
  getSync(localId) { return this.db.prepare('SELECT * FROM linear_sync WHERE local_id = ?').get(localId); }
  putSync({ localId, remoteId, remoteIdentifier, syncedAt }) {
    this.db.prepare('INSERT OR REPLACE INTO linear_sync (local_id, remote_id, remote_identifier, synced_at) VALUES (?,?,?,?)')
      .run(localId, remoteId, remoteIdentifier, syncedAt);
  }

  // ---- hydration: row -> Linear-GraphQL-shaped object -----------------------
  // Returns a fully-materialized plain object so graphql-js's default field resolver can
  // project any subset the caller asked for (incl. aliases + nested connections).
  hydrateState(s) { return s ? { id: s.id, name: s.name, type: s.type, position: s.position, color: s.color } : null; }
  hydrateLabel(l) { return { id: l.id, name: l.name, color: l.color }; }
  hydrateUser(u) { return u ? { id: u.id, name: u.name, displayName: u.display_name || u.name } : null; }
  hydrateTeam(t) {
    return {
      id: t.id, key: t.key, name: t.name,
      states: { nodes: this.listStates(t.id).map((s) => this.hydrateState(s)) },
      labels: { nodes: this.listLabels(t.id).map((l) => this.hydrateLabel(l)) },
    };
  }
  hydrateComment(c) {
    return { id: c.id, body: c.body, createdAt: c.created_at, user: this.hydrateUser(this.getUser(c.user_id)), issue: null };
  }
  hydrateIssue(row) {
    if (!row) return null;
    const team = this.getTeamById(row.team_id);
    return {
      id: row.id, number: row.number, identifier: row.identifier, title: row.title,
      description: row.description || '', priority: row.priority || 0,
      sortOrder: row.sort_order == null ? 0 : row.sort_order, url: row.url || '',
      createdAt: row.created_at, updatedAt: row.updated_at,
      state: this.hydrateState(this.getState(row.state_id)),
      assignee: this.hydrateUser(this.getUser(row.assignee_id)),
      team: team ? { id: team.id, key: team.key, name: team.name } : null,
      labels: { nodes: this.issueLabelRows(row.id).map((l) => this.hydrateLabel(l)) },
      comments: { nodes: this.listComments(row.id).map((c) => this.hydrateComment(c)) },
      attachments: { nodes: this.listAttachments(row.id).map((a) => ({ id: a.id, url: a.url, title: a.title })) },
    };
  }

  close() { try { this.db.close(); } catch {} }
}
