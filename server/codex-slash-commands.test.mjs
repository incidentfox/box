import assert from 'node:assert/strict';
import { CODEX_TUI_COMMAND_NAMES, CODEX_TUI_COMMANDS } from './codex-slash-commands.mjs';

const expected = [
  'model', 'fast', 'ide', 'permissions', 'keymap', 'vim', 'experimental', 'approve',
  'memories', 'skills', 'import', 'hooks', 'review', 'rename', 'new', 'archive',
  'delete', 'resume', 'fork', 'init', 'compact', 'plan', 'goal', 'agent', 'side',
  'copy', 'raw', 'diff', 'mention', 'status', 'title', 'statusline', 'theme', 'pets',
  'mcp', 'plugins', 'logout', 'exit', 'feedback', 'ps', 'stop', 'clear',
  'personality', 'subagents',
];

assert.deepEqual(CODEX_TUI_COMMAND_NAMES, expected, 'Box mirrors the runtime-visible Codex TUI inventory and order');
assert.equal(new Set(CODEX_TUI_COMMAND_NAMES).size, expected.length, 'commands are unique');
assert.equal(CODEX_TUI_COMMANDS.find((c) => c.name === 'goal')?.action, 'goal');
assert.ok(CODEX_TUI_COMMANDS.every((c) => c.desc && c.kind === 'builtin' && c.action));

console.log('codex slash commands ok');
