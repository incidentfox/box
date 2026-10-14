// Recognize only the known auto-mode setup menu. Unknown layouts retain PTY controls.
const FIELDS = [
  ['usage', 'How you use Claude here', 'cycle'],
  ['shellHistory', 'Also scan shell history', 'boolean'],
  ['otherRepos', 'Also scan your other repos', 'boolean'],
];
export function settingsFromDialog(prompt) {
  if (prompt?.kind !== 'dialog' || prompt.title !== 'Teach auto mode about your environment?') return null;
  const lines = prompt.body.split('\n');
  const rows = [], rowLines = [];
  for (const [id, label, type] of FIELDS) {
    const matches = lines.map((line, index) => ({line, index})).filter(({line}) => line.replace(/^\s*[❯>›▶]?\s*/, '').startsWith(label + ' '));
    if (matches.length !== 1) return null;
    const {line, index} = matches[0];
    const value = line.replace(/^\s*[❯>›▶]?\s*/, '').slice(label.length).trim();
    if (!value || value.length > 50 || (type === 'boolean' && !['true', 'false'].includes(value))) return null;
    rows.push({id, label, type, value}); rowLines.push(index);
  }
  const continues = lines.map((line, index) => ({line, index})).filter(({line}) => /^\s*[❯>›▶]?\s*Continue\s*$/.test(line));
  if (continues.length !== 1 || !(rowLines[0] < rowLines[1] && rowLines[1] < rowLines[2] && rowLines[2] < continues[0].index)) return null;
  const menuLines = [...rowLines, continues[0].index];
  const selections = lines.map((line, index) => /^\s*[❯>›▶]/.test(line) ? index : -1).filter(index => index >= 0);
  if (selections.length !== 1 || !menuLines.includes(selections[0])) return null;
  // Extra selectable rows would invalidate the number of cursor movements.
  const first = rowLines[0], last = continues[0].index;
  if (lines.slice(first, last + 1).some((line, offset) => line.trim() && !menuLines.includes(first + offset))) return null;
  const description = lines.slice(0, first).join('\n').trim();
  return {id:'auto-mode-environment', rows, description, selected:menuLines.indexOf(selections[0]), revision:JSON.stringify(rows.map(row => [row.id, row.value]))};
}

// A form action navigates using freshly observed cursor positions, never a guessed
// initial row or a burst of keys. A changed layout/value aborts before changing a setting.
export async function applySettingsAction({readPrompt, sendKey}, intent) {
  if (intent?.id !== 'auto-mode-environment' || !['change', 'continue', 'cancel'].includes(intent.action)) throw new Error('Unsupported setup action.');
  const read = async () => {
    const settings = settingsFromDialog(await readPrompt());
    if (!settings || settings.revision !== intent.revision) throw new Error('This menu changed. Review its current settings and try again.');
    return settings;
  };
  let settings = await read();
  const target = intent.action === 'continue' ? 3 : settings.rows.findIndex(row => row.id === intent.row);
  if (intent.action === 'change' && target < 0) throw new Error('Unknown setup setting.');
  if (intent.action === 'cancel') {
    if (!await sendKey('escape')) throw new Error('Unable to send the menu action.');
    return;
  }
  for (let moves = 0; settings.selected !== target; moves++) {
    if (moves >= 3) throw new Error('Unable to confirm the menu selection.');
    const next = settings.selected + (target > settings.selected ? 1 : -1);
    if (!await sendKey(target > settings.selected ? 'down' : 'up')) throw new Error('Unable to move the menu selection.');
    settings = await read();
    if (settings.selected !== next) throw new Error('Claude did not move the menu selection. Try again.');
  }
  if (!await sendKey(intent.action === 'continue' ? 'enter' : 'right')) throw new Error('Unable to send the menu action.');
}
