import assert from 'node:assert/strict';
import { existingOAuthAccountForEmail } from './accounts.mjs';

const accounts = [
  { id: 'secondary', type: 'oauth', email: 'owner@example.com', configDir: '/tmp/secondary', primary: false },
  { id: 'mine', type: 'oauth', email: 'Owner@Example.com ', configDir: '/tmp/primary', primary: true },
  { id: 'api', type: 'apikey', email: 'owner@example.com', configDir: '/tmp/api', primary: false },
];

assert.equal(existingOAuthAccountForEmail(accounts, ' owner@example.COM ')?.id, 'mine',
  'an existing primary OAuth account wins over a stale duplicate');
assert.equal(existingOAuthAccountForEmail(accounts, 'new@example.com'), null,
  'a different email remains a new account');
assert.equal(existingOAuthAccountForEmail(accounts, ''), null,
  'an unknown email cannot be deduplicated');
assert.equal(existingOAuthAccountForEmail([
  { id: 'api', type: 'apikey', email: 'owner@example.com', configDir: '/tmp/api' },
], 'owner@example.com'), null, 'API-key accounts are never overwritten by OAuth login');

console.log('accounts tests passed');
