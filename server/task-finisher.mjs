const ACTIONS = new Set(['continue', 'complete', 'blocked', 'needs_input']);

function textPart(part) {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  return '';
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.text === 'string') return message.text;
  const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [];
  return parts.map(textPart).filter(Boolean).join('\n');
}

export function taskFinisherTranscript(messages = [], { maxMessages = 10, maxChars = 12000 } = {}) {
  const rows = messages
    .filter((message) => message && ['user', 'assistant'].includes(message.role))
    .map((message) => ({ role: message.role, text: messageText(message).trim() }))
    .filter((message) => message.text)
    .slice(-maxMessages)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`);
  let transcript = rows.join('\n\n');
  if (transcript.length > maxChars) transcript = transcript.slice(-maxChars);
  return transcript;
}

function responseOutputText(json) {
  if (typeof json?.output_text === 'string') return json.output_text;
  return (json?.output || []).flatMap((item) => item?.content || []).map(textPart).filter(Boolean).join('');
}

export async function judgeTaskFinisher({ messages, apiKey, endpoint = 'https://api.openai.com/v1', model = 'gpt-5-nano', fetchImpl = fetch, signal } = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const transcript = taskFinisherTranscript(messages);
  if (!transcript) return { action: 'complete', reason: 'No task transcript remains to continue' };
  const response = await fetchImpl(`${String(endpoint).replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: signal || AbortSignal.timeout(15_000),
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 120,
      reasoning: { effort: 'minimal' },
      instructions: [
        'Decide whether an autonomous coding/operations agent should receive one more Continue message.',
        'Use only the transcript. Return continue when requested work is still materially unfinished, the agent stopped midway, or it explicitly named safe remaining work.',
        'Return complete only when the requested outcome was actually delivered and verified, not merely attempted or planned.',
        'Return needs_input only when a real user decision, approval, credential, or missing fact is required.',
        'Return blocked only when there is no safe in-scope action the agent can take by itself.',
        'Do not expand the task scope. Keep the reason concrete and under 240 characters.',
      ].join(' '),
      input: transcript,
      text: { format: {
        type: 'json_schema', name: 'task_finisher_decision', strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            action: { type: 'string', enum: [...ACTIONS] },
            reason: { type: 'string' },
          },
          required: ['action', 'reason'],
        },
      } },
    }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || `OpenAI ${response.status}`);
  let parsed;
  try { parsed = JSON.parse(responseOutputText(json)); }
  catch { throw new Error('Task finisher returned invalid JSON'); }
  if (!ACTIONS.has(parsed?.action) || typeof parsed?.reason !== 'string' || !parsed.reason.trim()) {
    throw new Error('Task finisher returned an invalid decision');
  }
  return { action: parsed.action, reason: parsed.reason.trim().slice(0, 240) };
}
