// Coding-agent registry for the voice assistant — ONE place that says which agents the voice
// can delegate to, what each is called out loud, what it is best at, and how to tell whether
// it is usable on this box. Tool schemas (start_agent / delegate_ticket enums), prompts, and
// spoken labels are all generated from it, so adding an agent is one entry here, not a hunt
// through hard-coded "claude|codex" strings.
//
// `kind`: 'coding' = a repo agent that can edit code, run commands, and open PRs;
//         'computer' = drives a browser/desktop (no repo brief).
// `bin`: CLI that must be on PATH for the agent to be offered (null = checked another way).
// `voiceDefault`: offered to voice unless VOICE_CODING_AGENTS overrides the list.

export const CODING_AGENTS = Object.freeze([
  { id: 'claude', label: 'Claude Code', kind: 'coding', bin: 'claude', voiceDefault: true,
    bestFor: 'judgment-heavy work: design, debugging, reviews, multi-step investigations' },
  { id: 'codex', label: 'Codex', kind: 'coding', bin: 'codex', voiceDefault: true,
    bestFor: 'mechanical or parallelizable coding: refactors, scripts, data pulls, counts, test scaffolding' },
  { id: 'gemini', label: 'Gemini CLI', kind: 'coding', bin: 'gemini', voiceDefault: true,
    bestFor: 'a second opinion or an independent parallel attempt' },
  { id: 'agy', label: 'Antigravity', kind: 'coding', bin: 'agy', voiceDefault: true,
    bestFor: 'an independent parallel attempt' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'coding', bin: null, voiceDefault: false,
    bestFor: 'cheap exploratory coding' },
  { id: 'experiential', label: 'Experiential', kind: 'coding', bin: null, voiceDefault: false,
    bestFor: 'experimental agent runs' },
  { id: 'mac', label: 'Computer Use', kind: 'computer', bin: null, voiceDefault: true,
    bestFor: 'clicking through websites or desktop apps on the Mac' },
]);

const BY_ID = new Map(CODING_AGENTS.map((a) => [a.id, a]));
export const DEFAULT_CODING_AGENT = 'claude';

export function codingAgent(id) { return BY_ID.get(String(id || '').toLowerCase()) || null; }

// Spoken/display name for any agent id (unknown ids are shown as-is).
export function codingAgentLabel(id) {
  const a = codingAgent(id || DEFAULT_CODING_AGENT);
  return a ? a.label : String(id || 'coding agent');
}

// Which agents voice may delegate to right now.
//   cfg('VOICE_CODING_AGENTS') = comma list overrides the defaults (unknown ids ignored);
//   hasBin(bin) → boolean (is the CLI installed); macAvailable() → the Mac bridge is reachable.
// The default agent is always first so it is the schema default.
export function availableCodingAgents({ cfg = () => '', hasBin = () => true, macAvailable = null } = {}) {
  const override = String(cfg('VOICE_CODING_AGENTS', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const wanted = override.length ? CODING_AGENTS.filter((a) => override.includes(a.id)) : CODING_AGENTS.filter((a) => a.voiceDefault);
  const usable = wanted.filter((a) => {
    if (a.id === 'mac') return typeof macAvailable === 'function' ? true : false; // reachability is checked per call
    return !a.bin || hasBin(a.bin);
  });
  usable.sort((x, y) => (x.id === DEFAULT_CODING_AGENT ? -1 : y.id === DEFAULT_CODING_AGENT ? 1 : 0));
  return usable;
}

// Plain-language roster for prompts: "Claude Code (claude) for …; Codex (codex) for …".
export function codingAgentRoster(agents, { withIds = true } = {}) {
  return agents.map((a) => `${a.label}${withIds ? ` (${a.id})` : ''} for ${a.bestFor}`).join('; ');
}

// The agent property for a delegation tool schema: a closed enum (OpenAI function-calling
// guidance: enums prevent invalid states) whose description says when to pick which.
export function codingAgentSchema(agents, { kinds = ['coding', 'computer'] } = {}) {
  const list = agents.filter((a) => kinds.includes(a.kind));
  return {
    type: 'string',
    enum: list.map((a) => a.id),
    description: `Which agent runs it (default ${DEFAULT_CODING_AGENT}): ${codingAgentRoster(list)}. Pick by fit; if Jimmy names an agent, use that one.`,
  };
}

// Resolve a requested agent id against what is offered. Returns { agent } or { error }.
export function resolveCodingAgent(requested, agents) {
  const id = String(requested || DEFAULT_CODING_AGENT).toLowerCase();
  if (agents.some((a) => a.id === id)) return { agent: id };
  const known = codingAgent(id);
  return { error: `${known ? known.label : id} is not available for delegation on this box right now; available: ${agents.map((a) => a.label).join(', ')}` };
}
