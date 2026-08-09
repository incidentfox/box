export function normalizeSessionWorkspace(value) {
  return value === 'team' || value === 'personal' ? value : '';
}

export function sessionWorkspace(record, { isShared = () => false } = {}) {
  const explicit = normalizeSessionWorkspace(record && record.workspace);
  if (explicit) return explicit;
  const id = record && (record.sessionId || record.id || record.key);
  return (record && record.teamSandbox) || (id && isShared(id)) ? 'team' : 'personal';
}

export function sessionUsesTeamSandbox(record) {
  return !!(record && record.teamSandbox);
}

// Runtime objects can outlive the metadata format that created them. Pre-workspace
// Team shares rewrote an owner Codex runtime to a sandbox path even though its durable
// rollout and registry still belonged to the owner's project. Durable provider metadata
// is authoritative when re-sharing; runtime state is only a fallback for a new chat.
export function ownerShareCwd({ runtime, codexRecord, teamClaudeRecord, persistedCwd, defaultCwd }) {
  return (codexRecord && codexRecord.cwd)
    || (teamClaudeRecord && teamClaudeRecord.cwd)
    || persistedCwd
    || (runtime && runtime.cwd)
    || defaultCwd;
}

export function sessionInTeamWorkspace(record, options) {
  return sessionWorkspace(record, options) === 'team';
}
