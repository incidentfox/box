import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');

assert.match(app, /clientMessageId.*type: 'team_chat'/s);
assert.match(app, /type === 'team_chat_ack'/);
assert.match(app, /type === 'team_chat_error'/);
assert.doesNotMatch(app, /type: 'team_chat', key: cur\.key, text \}\)\);\s*input\.value = ''/);
assert.match(server, /teamChatReply\('team_chat_ack'/);
assert.match(server, /teamChatReply\('team_chat_error'/);

console.log('team chat delivery checks passed');
