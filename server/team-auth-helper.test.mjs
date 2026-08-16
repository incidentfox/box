import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const helper = readFileSync(join(root, 'scripts/box-team-codex'), 'utf8');
const config = readFileSync(join(root, 'scripts/box-team-sandbox.conf'), 'utf8');

assert.match(helper, /SHARED_AUTH_HOME/);
assert.match(helper, /SHARED_AUTH_USERS/);
assert.match(helper, /\.codex\/auth\.json/);
assert.match(helper, /\.claude\/\.credentials\.json/);
assert.match(helper, /codex:OPENAI_API_KEY\|codex:CODEX_API_KEY/);
assert.match(helper, /claude:ANTHROPIC_API_KEY\|claude:CLAUDE_CODE_OAUTH_TOKEN\|claude:CLAUDE_OAUTH_TOKEN/);
assert.match(helper, /--bind "\$auth_file" "\$auth_guest_file"/);
assert.match(config, /^SHARED_AUTH_HOME=$/m);
assert.match(config, /^SHARED_AUTH_USERS=$/m);

console.log('✅ team-auth-helper.test.mjs passed');
