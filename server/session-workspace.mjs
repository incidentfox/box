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

export function sessionInTeamWorkspace(record, options) {
  return sessionWorkspace(record, options) === 'team';
}
