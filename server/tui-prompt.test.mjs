import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePrompt, promptFromBuffer } from './tui-prompt.mjs';
const panel = [
  '1. A numbered list in an earlier response',
  '────────────────────────────────────────',
  'Teach auto mode about your environment?', '',
  'Claude analyzes this data and customizes auto mode.', '',
  '  How you use Claude here     Mixed',
  '❯ Also scan shell history     true',
  '  Also scan your other repos  false', '', '  Continue', '',
  '←/→ to change · Enter to continue · Esc to cancel',
];
test('cursor settings panel exposes actual values and navigation, excluding earlier response', () => {
  const p = promptFromBuffer('\x1b[2J\x1b[H' + panel.join('\r\n'));
  assert.equal(p.kind, 'dialog');
  assert.equal(p.title, 'Teach auto mode about your environment?');
  assert.match(p.body, /❯ Also scan shell history\s+true/);
  assert.match(p.body, /other repos\s+false/);
  assert.ok(!p.body.includes('earlier response'));
  assert.deepEqual(p.actions, ['up', 'down', 'left', 'right', 'enter', 'escape']);
});
test('numbered questions retain their answer mapping', () => {
  const p = parsePrompt(['Which one?', '❯ 1. First', '2. Other', 'Enter to select']);
  assert.equal(p.kind, 'question');
  assert.deepEqual(p.options.map(x => [x.n, x.label, x.freeText]), [[1,'First',false],[2,'Other',true]]);
});
test('ordinary output does not become a dialog', () => {
  assert.equal(parsePrompt(['1. Build the app', '2. Ship it']), null);
});
