import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { promptFromBuffer } from './tui-prompt.mjs';

// Exercise the actual server handlers with a terminal that stays parked after
// Enter, repaints after arrows, and leaves waiting status only when dismissed.
const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('async function checkWaiting(s)'), source.indexOf('\nfunction killAgentProcess('));
function harness() {
  const s = { sessionId: 'synthetic-dialog', subs: new Set([{}]), settings: {} };
  let status = 'waiting', selected = 'shell', value = true;
  const events = [], writes = [];
  const engine = {
    sessionState: () => ({ status }),
    open: () => ({}),
    captureScreen: async () => '\x1b[2J\x1b[H' + [
      '─────────────────────────', 'Teach auto mode about your environment?',
      'Claude customizes auto mode.',
      `${selected === 'shell' ? '❯' : ' '} Also scan shell history     ${value}`,
      `${selected === 'continue' ? '❯' : ' '} Continue`,
      '←/→ to change · Enter to continue · Esc to cancel',
    ].join('\r\n'),
    answerWaiting: async (_, sel) => {
      writes.push(sel);
      if (sel.key === 'right' || (sel.key === 'enter' && selected === 'shell')) value = !value;
      if (sel.key === 'down') selected = 'continue';
      if (sel.key === 'escape' || (sel.key === 'enter' && selected === 'continue')) status = 'idle';
      return true;
    },
  };
  const context = vm.createContext({
    rcEngine: engine, promptFromBuffer, rt: () => s,
    sessionUsesTeamSandbox: () => false, sessionIsGuest: () => false,
    rcName: () => 'synthetic', bcast: (_, event) => events.push(event),
  });
  vm.runInContext(handlers, context);
  return { s, events, writes, poll: () => context.checkWaiting(s), answer: sel => context.answerWaiting('synthetic', sel) };
}

test('Enter on a setting preserves the panel and refreshes values; Continue closes only after terminal confirmation', async () => {
  const h = harness();
  await h.poll();
  assert.match(h.events.at(-1).prompt.body, /shell history\s+true/);
  await h.answer({ key: 'enter' });
  assert.ok(h.s.waitingActive);
  assert.ok(!h.events.some(e => e.type === 'waiting_clear'));
  await h.poll();
  assert.match(h.events.at(-1).prompt.body, /shell history\s+false/);
  await h.answer({ key: 'right' });
  await h.poll();
  assert.match(h.events.at(-1).prompt.body, /shell history\s+true/);
  await h.answer({ key: 'down' });
  await h.poll();
  assert.match(h.events.at(-1).prompt.body, /❯ Continue/);
  await h.answer({ key: 'enter' });
  assert.equal(h.events.at(-1).type, 'waiting');
  await h.poll();
  assert.equal(h.events.at(-1).type, 'waiting_clear');
});
test('Escape closes after confirmation while ordinary numbered answers still clear optimistically', async () => {
  const h = harness();
  await h.poll();
  await h.answer({ key: 'escape' });
  assert.ok(h.s.waitingActive);
  await h.poll();
  assert.equal(h.events.at(-1).type, 'waiting_clear');
  const numbered = harness();
  await numbered.poll();
  await numbered.answer({ index: 1 });
  assert.equal(numbered.events.at(-1).type, 'waiting_clear');
});
