import assert from 'node:assert/strict';
import { claudeModelContextWindow, DEFAULT_CLAUDE_MODEL, normalizeClaudeModel } from './claude-model.mjs';

assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-opus-5[1m]');
assert.equal(normalizeClaudeModel(), DEFAULT_CLAUDE_MODEL);
assert.equal(normalizeClaudeModel('claude-opus-5'), DEFAULT_CLAUDE_MODEL);
assert.equal(normalizeClaudeModel('claude-opus-5[1m]'), DEFAULT_CLAUDE_MODEL);
assert.equal(normalizeClaudeModel('sonnet'), 'sonnet');

assert.equal(claudeModelContextWindow(), 1000000);
assert.equal(claudeModelContextWindow('claude-opus-5[1m]'), 1000000);
assert.equal(claudeModelContextWindow('claude-opus-5'), 200000);
assert.equal(claudeModelContextWindow('opus'), 200000);
assert.equal(claudeModelContextWindow('sonnet'), 200000);

console.log('claude model ok');
