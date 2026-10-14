import assert from 'node:assert/strict';
import {test} from 'node:test';
import {settingsFromDialog, applySettingsAction} from './dialog-settings.mjs';
const menu = (selected = 1, shell = true) => ({kind:'dialog', title:'Teach auto mode about your environment?', body:[
  'Claude customizes auto mode.', '', 'How you use Claude here     Mixed',
  `Also scan shell history     ${shell}`, 'Also scan your other repos  false', 'Continue',
].map((line,i) => i === selected + 2 ? '❯ ' + line : '  ' + line).join('\n')});
function terminal(selected = 1) {
  let shell = true;
  const keys = [];
  return {keys, readPrompt:async () => menu(selected,shell), sendKey:async key => {
    keys.push(key); if(key === 'down') selected++; if(key === 'up') selected--; if(key === 'right') shell = !shell; return true;
  }};
}
const intent = (action,row) => ({id:'auto-mode-environment', revision:settingsFromDialog(menu()).revision, action,row});
test('known setup parses current values and each possible cursor position', () => {
  for(let selected = 0; selected < 4; selected++) {
    const settings = settingsFromDialog(menu(selected));
    assert.equal(settings.selected, selected);
    assert.deepEqual(settings.rows.map(row => row.value), ['Mixed','true','false']);
  }
});
test('unknown or ambiguous layouts stay on terminal controls', () => {
  const p = menu();
  for(const invalid of [
    {...p,title:'Different menu'}, {...p,body:p.body.replace('Mixed','')},
    {...p,body:p.body.replace('true','maybe')}, {...p,body:p.body.replace('  Continue','  New setting  true\n  Continue')},
    {...p,body:p.body.replace('❯',' ')}, {...p,body:p.body + '\n❯ Continue'},
    {...p,body:p.body.replace('Also scan your other repos','Another option')},
  ]) assert.equal(settingsFromDialog(invalid),null);
});
test('a tap navigates from the observed cursor to its row before changing it', async () => {
  const t = terminal(3);
  await applySettingsAction(t,intent('change','shellHistory'));
  assert.deepEqual(t.keys,['up','up','right']);
  assert.equal(settingsFromDialog(await t.readPrompt()).rows[1].value,'false');
});
test('Continue selects the actual Continue row before Enter; Cancel sends Escape', async () => {
  const t = terminal(0); await applySettingsAction(t,intent('continue'));
  assert.deepEqual(t.keys,['down','down','down','enter']);
  const cancel = terminal(2); await applySettingsAction(cancel,intent('cancel'));
  assert.deepEqual(cancel.keys,['escape']);
});
test('stale values, unknown target and refused movement never change a setting', async () => {
  const stale = terminal();
  await assert.rejects(applySettingsAction(stale,{...intent('change','shellHistory'),revision:'old'}),/menu changed/);
  assert.deepEqual(stale.keys,[]);
  await assert.rejects(applySettingsAction(stale,intent('change','missing')),/Unknown/);
  assert.deepEqual(stale.keys,[]);
  const stuck = terminal(0); stuck.sendKey = async key => {stuck.keys.push(key); return true;};
  await assert.rejects(applySettingsAction(stuck,intent('change','shellHistory')),/did not move/);
  assert.deepEqual(stuck.keys,['down']);
});
test('values changing during navigation abort before the mutation key', async () => {
  const t = terminal(0); let reads = 0;
  t.readPrompt = async () => menu(reads++ ? 1 : 0,reads < 2);
  await assert.rejects(applySettingsAction(t,intent('change','shellHistory')),/menu changed/);
  assert.deepEqual(t.keys,['down']);
});
