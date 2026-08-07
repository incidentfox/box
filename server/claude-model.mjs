export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5[1m]';

export function normalizeClaudeModel(model) {
  const value = String(model || '').trim();
  return !value || value === 'opus' || value === 'claude-opus-5' ? DEFAULT_CLAUDE_MODEL : value;
}

export function claudeModelContextWindow(model) {
  const value = String(model || '').trim() || DEFAULT_CLAUDE_MODEL;
  return /\[1m\]$/i.test(value) ? 1000000 : 200000;
}
