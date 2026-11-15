import assert from 'node:assert/strict';
import { CODING_AGENTS, availableCodingAgents, codingAgentLabel, codingAgentRoster, codingAgentSchema, resolveCodingAgent } from './coding-agents.mjs';

const cfgOf = (env) => (k, d = '') => (env[k] == null || env[k] === '' ? d : env[k]);
const ids = (l) => l.map((a) => a.id);

// labels: every agent has one; unknown ids pass through
assert.equal(codingAgentLabel('claude'), 'Claude Code');
assert.equal(codingAgentLabel('codex'), 'Codex');
assert.equal(codingAgentLabel(''), 'Claude Code');
assert.equal(codingAgentLabel('newagent'), 'newagent');
for (const a of CODING_AGENTS) assert.ok(a.label && a.bestFor && ['coding', 'computer'].includes(a.kind), a.id);

// availability: default set filtered by installed CLIs; claude first; mac only with a bridge
{
  const l = availableCodingAgents({ cfg: cfgOf({}), hasBin: (b) => ['claude', 'codex', 'gemini'].includes(b), macAvailable: () => true });
  assert.deepEqual(ids(l), ['claude', 'codex', 'gemini', 'mac']);
  assert.deepEqual(ids(availableCodingAgents({ cfg: cfgOf({}), hasBin: (b) => b === 'codex' })), ['codex']);
  // override list: only those, unknown ids ignored, opt-in agents allowed
  assert.deepEqual(ids(availableCodingAgents({ cfg: cfgOf({ VOICE_CODING_AGENTS: 'codex, deepseek ,claude,bogus' }), hasBin: () => true })), ['claude', 'codex', 'deepseek']);
}

// schema: closed enum + when-to-pick description; kinds filter
{
  const l = availableCodingAgents({ cfg: cfgOf({}), hasBin: () => true, macAvailable: () => true });
  const s = codingAgentSchema(l);
  assert.deepEqual(s.enum, ['claude', 'codex', 'gemini', 'agy', 'mac']);
  assert.match(s.description, /Claude Code \(claude\) for judgment-heavy/);
  assert.ok(!codingAgentSchema(l, { kinds: ['coding'] }).enum.includes('mac'));
  assert.match(codingAgentRoster(l.slice(0, 2), { withIds: false }), /^Claude Code for .*; Codex for /);
}

// resolve: default, offered, not offered
{
  const l = availableCodingAgents({ cfg: cfgOf({}), hasBin: (b) => b === 'claude' || b === 'codex' });
  assert.deepEqual(resolveCodingAgent(undefined, l), { agent: 'claude' });
  assert.deepEqual(resolveCodingAgent('CODEX', l), { agent: 'codex' });
  assert.match(resolveCodingAgent('gemini', l).error, /Gemini CLI is not available.*Claude Code, Codex/);
}
console.log('coding-agents ok');
