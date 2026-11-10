// GPT-Live (gpt-live-1) voice sessions — OpenAI's full-duplex speech-to-speech model.
//
// GPT-Live only handles the spoken conversation; real work is "delegated" to a backend:
//   • thread scope  → CLIENT delegation: the browser hands the user's request to the
//     chat thread's own agent (Claude Code / Codex) by enqueueing it in that thread, then
//     returns the agent's reply with session.commentary.append. Voice becomes a mode of
//     the thread, like switching to voice inside a ChatGPT chat.
//   • global scope  → RESPONSES delegation: OpenAI runs a Responses backend model with the
//     box voice tools; the browser executes each function call via /api/voice/tool.
//
// The browser creates the WebRTC offer; this server exchanges it with
// POST /v1/live/sessions (the API key never leaves the box). Docs:
// developers.openai.com/api/docs/guides/live, …/live-delegation, …/live-conversations.

export const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';
export const LIVE_INPUT_MAX_MESSAGES = 128;   // session.input hard limits (docs)
export const LIVE_INPUT_MAX_TOKENS = 8192;

const approxTokens = (s) => Math.ceil(String(s || '').length / 3.6);

export function liveVoiceConfig(cfg) {
  const num = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
  return {
    model: cfg('VOICE_LIVE_MODEL', 'gpt-live-1'),
    voice: cfg('VOICE_LIVE_VOICE', cfg('VOICE_ASSISTANT_VOICE', 'marin')),
    backendModel: cfg('VOICE_LIVE_BACKEND_MODEL', 'gpt-6-luna'),
    backendReasoning: cfg('VOICE_LIVE_BACKEND_REASONING', 'low'),
    ackDelayMs: Math.max(0, Math.min(5000, num(cfg('VOICE_LIVE_ACK_DELAY_MS'), 600))),
  };
}

// Plain speakable text: strip markdown/code so the voice model gets facts, not syntax.
export function speakableText(text, maxChars = 1600) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, ' (code omitted) ');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, '(link)');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '• ');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  t = t.replace(/^\s*\|.*\|\s*$/gm, (row) => row.replace(/\|/g, ' ').replace(/\s*-{3,}\s*/g, ' ').trim());
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
    t = (end > maxChars * 0.6 ? cut.slice(0, end + 1) : cut) + ' … (the rest is in the chat)';
  }
  return t;
}

// Thread turns → session.input messages, newest kept, inside the documented limits.
// Assistant turns use output_text, user turns input_text; one text part each.
export function liveInputFromTurns(turns, {
  maxMessages = 40, maxTokens = 6500, maxCharsPerTurn = 2400, redact = (s) => s,
} = {}) {
  const all = (Array.isArray(turns) ? turns : []).filter((t) => t && t.text && (t.role === 'user' || t.role === 'assistant'));
  const kept = [];
  let tokens = 0;
  for (let i = all.length - 1; i >= 0 && kept.length < Math.min(maxMessages, LIVE_INPUT_MAX_MESSAGES); i--) {
    const t = all[i];
    let text = String(redact(t.text) || '').trim();
    if (!text) continue;
    if (text.length > maxCharsPerTurn) {
      // Keep the head and the tail: agent replies usually end with the conclusion.
      const head = Math.floor(maxCharsPerTurn * 0.4);
      text = `${text.slice(0, head)}\n…\n${text.slice(-(maxCharsPerTurn - head))}`;
    }
    const cost = approxTokens(text) + 8;
    if (kept.length && tokens + cost > Math.min(maxTokens, LIVE_INPUT_MAX_TOKENS - 600)) break;
    tokens += cost;
    kept.unshift(t.role === 'assistant'
      ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
      : { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  }
  return { input: kept, tokens, omitted: Math.max(0, all.length - kept.length) };
}

// The "who Jimmy is right now" block (server/jimmy-context.mjs) framed for a voice model:
// it IS part of his Claude setup and should answer from this, not claim ignorance.
export function liveContextSection(context = '', ownerName = 'Jimmy') {
  const c = String(context || '').trim();
  if (!c) return '';
  return `\n\nYou are part of ${ownerName}'s Claude setup — the same assistant system as his Claude Code sessions on this box, and you share their context about him, below. Answer questions about him, his job, his company, his customers, and what is going on from this context directly and confidently; never say you don't know who he is or that you have no context. If he tells you something newer than this, believe him. For live state not covered here, use the backend.\n\n${c}`;
}

export function liveThreadInstructions({ ownerName = 'Jimmy', title = '', agent = 'claude', cwd = '', omitted = 0, hasHistory = false, context = '' } = {}) {
  const agentName = agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude Code' : agent;
  return `You are the voice of one of ${ownerName}'s coding-agent chat threads on his always-on dev box. He switched this chat into voice mode so he can talk instead of type. Thread: "${title || 'untitled'}" — agent: ${agentName}${cwd ? `, working in ${cwd}` : ''}.
${hasHistory ? `The prior messages are this thread's recent history${omitted ? ` (${omitted} older messages omitted)` : ''}: "user" is ${ownerName}, "assistant" is the ${agentName} agent. Treat them as what has already happened in this chat.` : 'This is a brand-new chat with no history yet.'}

Speak like a sharp, warm colleague pair-programming with him: direct, brief, a little opinionated. Plain spoken English — never read markdown, code, file paths, hashes, or URLs character by character; describe them ("the voice module", "the PR link is in the chat"). Round numbers. One question at a time. He may be driving; never ask him to look at or read the screen.

Backchannel policy: Use sparse backchannels. A short "mm-hm" is fine during long explanations; otherwise stay quiet while he talks.
Interruption policy: Stop speaking when he interrupts. Listen to what he says. "Stop" or "wait" means stop talking — it does not cancel the agent's work.

Delegation policy:
Backend tools:
- Thread agent (${agentName}): does the real work in this chat — reads and edits code, runs commands and tests, investigates, opens PRs, searches the web, and answers anything that needs fresh information from the repo or the box. Its reply also appears in the chat.
Generate <|SpawnThinking|> when:
- He asks for something to be done, changed, fixed, built, run, checked, or looked up.
- He answers a question the agent asked, or approves, rejects, or adjusts a plan the agent proposed.
- A correction changes work already requested.
- The answer needs details that are not in the thread history.
Do not generate <|SpawnThinking|> when:
- You can answer from the thread history: "what did it just say", "where are we", "summarize this", explaining something already discussed.
${context ? '- You can answer from the context about him below: who he is, where he works, his company, customers, priorities, and what is going on.\n' : ''}- He is greeting you, chatting, or thinking out loud without asking for anything.
- You need a brief clarification to understand the request.
Generate <|SpawnThinking|> before giving an answer that depends on backend work.
Do not guess the result while waiting.

While the agent works, keep it short ("on it") and then stay quiet — agent turns can take minutes. If he asks, say it's still working and what it's doing if you know. When a result arrives, give the gist in one to three sentences and offer more detail instead of reading long output. Never claim the agent did something before its result arrives.${liveContextSection(context, ownerName)}`;
}

export function liveGlobalInstructions({ ownerName = 'Jimmy', snapshot = '', context = '' } = {}) {
  return `You are "Box", ${ownerName}'s realtime voice copilot on his always-on dev server — the voice layer of the app that runs his coding-agent fleet (Claude Code, Codex), his Linear board, research, the company brain, notes, Slack, email, and calendar. Success means he gets real work done and real decisions made, hands-free. He is usually driving.

Personality: a sharp, warm, direct colleague and thought partner, not a yes-man — push back with reasons and numbers. Plain spoken English only: no markdown or lists, no reading URLs ("I'll email the link"). Round numbers. Name work by what it is ("the clearinghouse-rejections ticket"), not by its code. Ask one question at a time. Never ask him to look at the screen.

Backchannel policy: Use sparse backchannels; stay mostly quiet while he talks.
Interruption policy: Stop speaking when he interrupts. Listen to what he says. Ignore background noise, music, the car's own prompts, and side conversations that aren't addressed to you — say nothing.

Delegation policy:
Backend tools:
- Agent fleet: list, check, read the output or history of, message, start, and archive Claude/Codex sessions; delegate Linear tickets to agents; watch sessions for completion.
- Linear: the board, ticket details, create and update tickets, open needs-Jimmy decisions.
- Research: web search for current facts; big research questions go to a background agent.
- Company brain, the drive briefing, notes, Slack, email to Jimmy's own inbox, his calendar.
- think_hard: careful analysis for strategy, pricing, and prioritization.
Generate <|SpawnThinking|> when:
- He asks about the current state of anything (agents, tickets, PRs, Slack, calendar, the brain, the briefing).
- He asks for an action: start or message an agent, file or update a ticket, take a note, send an email, research something.
- The question needs facts, numbers, or careful reasoning beyond a simple reply.
- A correction changes work already requested.
Do not generate <|SpawnThinking|> when:
- He greets you, chats, or asks you to repeat or rephrase a result already provided.
- You can answer from this conversation or a still-current result.
${context ? '- You can answer from the context about him below: who he is, where he works, his company, customers, priorities, and what is going on.\n' : ''}- You need a brief clarification to understand the request.
Generate <|SpawnThinking|> before giving an answer that depends on backend work.
Do not guess the result while waiting.

Report results in one or two crisp sentences; offer detail rather than reading long output. If a result says something failed, say so plainly.${liveContextSection(context, ownerName)}
${snapshot ? `\nCURRENT CONTEXT SNAPSHOT (may be stale; the backend has live tools):\n${snapshot}` : ''}`;
}

// The backend (Responses) prompt: the full box persona + tool rules, with the parts that
// only make sense for a model that speaks (wait_for_user, self-echo) removed.
export function liveBackendInstructions(persona = '', snapshot = '', context = '') {
  const kept = String(persona || '').split('\n')
    .filter((l) => !/wait_for_user|Self-echo|microphone loopback|deep_research/i.test(l))
    .map((l) => l.replace(/,?\s*web_search\b/g, ''))
    .join('\n');
  return `You are the backend for a live voice conversation. A separate voice model talks with Jimmy and hands you requests; it speaks whatever text you return (paraphrasing it). So: do the work with your tools, then return a SHORT, speakable result — the concrete facts, outcome, and next step in plain sentences, no markdown, no URLs, no long lists. Never claim an action happened unless its tool call succeeded. If the request is ambiguous, return the single clarifying question to ask.

${kept}${context ? `\n\n${String(context).trim()}` : ''}${snapshot ? `\n\nCURRENT CONTEXT SNAPSHOT:\n${snapshot}` : ''}`;
}

// Realtime-style tool schemas → Responses function tools (same shape). Voice-only tools are
// dropped, and the Parallel-backed search tools (Jimmy: too expensive) give way to the
// Responses backend's hosted web search.
const LIVE_DROPPED_TOOLS = new Set(['wait_for_user', 'web_search', 'deep_research']);
export function liveBackendTools(toolSchemas = []) {
  const fns = (Array.isArray(toolSchemas) ? toolSchemas : [])
    .filter((t) => t && t.name && !LIVE_DROPPED_TOOLS.has(t.name))
    .map((t) => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } }));
  return [{ type: 'web_search' }, ...fns];
}

export function buildLiveSession({ scope = 'thread', config, instructions, input = [], backendInstructions = '', tools = [] } = {}) {
  const session = {
    model: config.model,
    instructions,
    audio: { output: { voice: config.voice } },
  };
  if (input.length) session.input = input;
  if (scope === 'global') {
    session.delegation = {
      type: 'responses',
      responses: {
        model: config.backendModel,
        instructions: backendInstructions,
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        ...(config.backendReasoning && config.backendReasoning !== 'none' ? { reasoning: { effort: config.backendReasoning } } : {}),
      },
    };
  } else {
    session.delegation = { type: 'client', acknowledgement_delay_ms: config.ackDelayMs };
  }
  return session;
}

export async function createLiveWebrtcSession({ apiKey, session, sdp, fetchImpl = fetch }) {
  const r = await fetchImpl(LIVE_SESSIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, transport: { type: 'webrtc', sdp } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.transport || !j.transport.sdp) {
    const msg = (j.error && (j.error.message || j.error.code)) || `HTTP ${r.status}`;
    const err = new Error(`GPT-Live session failed: ${msg}`);
    err.status = r.status;
    // A reasoning setting the backend model rejects shouldn't kill the call.
    err.retryWithoutReasoning = /reasoning/i.test(String(msg));
    throw err;
  }
  return j;
}
