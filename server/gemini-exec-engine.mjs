// Gemini engine — spawns the real `gemini` CLI as a full agent (tools, file access,
// context files, hooks), exactly the way the Codex engine spawns `codex exec`. The old
// version called the bare `generateContent` REST endpoint, so Gemini was a stateless
// chatbot with NO harness: no system prompt / CLAUDE.md context, no hooks, no tools. This
// makes Gemini a real peer of Claude/Codex on the box.
//
// We drive it headless with `gemini -p` and `--output-format stream-json`, which emits one
// JSON object per line:
//   {type:init,        session_id, model}                      -> {type:session}
//   {type:message,     role:assistant, content, delta:true}    -> {type:text}
//   {type:tool_use,    tool_name, tool_id, parameters}         -> {type:tool}
//   {type:tool_result, tool_id, status, output}                -> {type:tool_result}
//   {type:result,      status, stats:{input_tokens, output_tokens, tool_calls, ...}} -> {type:context}
//   {type:error,       message}                                -> {type:error}
//
// Session continuity mirrors Codex: the box mints a UUID and passes `--session-id <uuid>`
// on the first turn, then `--resume <uuid>` on every later turn (verified: resume restores
// the prior conversation + tool memory). The harness (context files + hooks) is configured
// in ~/.gemini/settings.json + ~/.gemini/GEMINI.md (the gemini analogue of ~/.codex).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const basename = (p) => String(p || '').split('/').filter(Boolean).pop() || String(p || '');

// Map a gemini stream-json `tool_use` to the box's neutral tool-chip shape ({name,input,detail})
// so the phone SEES what Gemini is doing — the same chips Codex/Claude turns render. Gemini's
// tool names differ from the others; normalize the common ones so the UI icon/label matches.
function toolFromUse(o) {
  const raw = String(o.tool_name || o.name || 'tool');
  const p = o.parameters || o.args || {};
  const NAMES = {
    run_shell_command: 'Bash', shell: 'Bash', execute_bash: 'Bash',
    read_file: 'Read', read_many_files: 'Read',
    write_file: 'Write',
    replace: 'Edit', edit: 'Edit',
    google_web_search: 'WebSearch', web_search: 'WebSearch',
    web_fetch: 'WebFetch',
    list_directory: 'List', glob: 'Glob', search_file_content: 'Grep',
    save_memory: 'Memory',
  };
  const name = NAMES[raw] || raw;
  let input = '';
  if (name === 'Bash') input = String(p.command || '').replace(/\s+/g, ' ').slice(0, 160);
  else if (name === 'WebSearch' || name === 'WebFetch') input = String(p.query || p.prompt || p.url || '');
  else if (name === 'Grep') input = String(p.pattern || p.query || '');
  else if (name === 'Glob') input = String(p.pattern || '');
  else if (p.file_path || p.path || p.absolute_path) input = basename(p.file_path || p.path || p.absolute_path);
  else input = Object.values(p).filter((v) => typeof v === 'string').join(' ').slice(0, 160);
  return { name, input, detail: { tool: raw, parameters: p } };
}

export class GeminiExecEngine {
  // sessionId: the box-minted UUID for this chat. isNew=true on the first turn (start the
  // session with that id); else resume it. Returns a ChildProcess — caller wires
  // .on('close', finish) / .on('error', …) and .kill(), same as the Codex engine.
  run({ sessionId, cwd, prompt, images = [], settings = {}, isNew = false, apiKey = '', onEvent }) {
    const model = settings.model || 'gemini-3.5-flash';
    const emit = (ev) => { try { onEvent?.(ev); } catch {} };

    // `-p` takes ONE text prompt; reference attachments by path so Gemini opens them with its
    // own read tools (the box stages uploads on disk — same convention as Claude/Codex turns).
    let fullPrompt = String(prompt || '');
    if (images && images.length) {
      const isImg = (p) => /\.(png|jpe?g|gif|webp|svg|bmp|heic|heif|avif|tiff?)$/i.test(p || '');
      const refs = images.map((pp) => `[${isImg(pp) ? 'Image' : 'File'} attached at ${pp} — open it with the read_file tool]`).join('\n');
      fullPrompt = refs + (fullPrompt ? '\n\n' + fullPrompt : '');
    }

    // --skip-trust + GEMINI_CLI_TRUST_WORKSPACE=true: the box is a single-user trust boundary
    // (like Codex's danger-full-access), so YOLO must actually auto-approve. Without trust the
    // CLI silently downgrades `-y` to interactive approval and then stalls forever headless.
    const args = ['--skip-trust', '-y', '-o', 'stream-json', '-m', model];
    if (sessionId && !isNew) args.push('--resume', sessionId);
    else if (sessionId) args.push('--session-id', sessionId);
    args.push('-p', fullPrompt);

    // The box reads its API key from .env / EXTRA_ENV_FILE (cfg()), which is NOT in the server
    // process.env — so the spawned CLI wouldn't inherit it. Inject it explicitly. (An AI Studio
    // key works as GEMINI_API_KEY.) GEMINI_CLI_TRUST_WORKSPACE pairs with --skip-trust so YOLO
    // actually auto-approves headless.
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
    if (apiKey) env.GEMINI_API_KEY = String(apiKey);
    const child = spawn('gemini', args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: child.stdout });
    const seenTools = new Set();
    let sawResult = false;       // a stdout `result` event means the turn ran to completion
    let stderrTail = '';         // keep a small tail to explain a hard non-zero exit

    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let o;
      try { o = JSON.parse(t); } catch { return; }
      switch (o.type) {
        case 'init':
          if (o.session_id) emit({ type: 'session', id: o.session_id });
          return;
        case 'tool_use': {
          const tool = toolFromUse(o);
          const id = o.tool_id || `tool-${seenTools.size + 1}`;
          seenTools.add(id);
          emit({ type: 'tool', id, name: tool.name, input: tool.input, detail: tool.detail });
          return;
        }
        case 'tool_result': {
          const id = o.tool_id || `tool-${seenTools.size}`;
          const out = o.output != null
            ? (typeof o.output === 'string' ? o.output : JSON.stringify(o.output))
            : (o.status ? `(${o.status})` : '');
          emit({ type: 'tool_result', id, content: String(out) });
          return;
        }
        case 'message':
          // assistant messages stream as `delta:true` chunks of one reply — concatenate
          // verbatim (no separator). user-role lines are our own prompt echoed back; skip.
          if (o.role === 'assistant' && o.content != null) emit({ type: 'text', delta: String(o.content) });
          return;
        case 'result': {
          sawResult = true;
          const st = o.stats || {};
          // `input_tokens` is the LAST request's input = live context occupancy (what we want
          // for the meter), not a cumulative session total. window comes from index.mjs.
          emit({ type: 'context', info: {
            input_tokens: Number(st.input_tokens != null ? st.input_tokens : st.input) || 0,
            output_tokens: Number(st.output_tokens) || 0,
            model,
          } });
          if (o.status && o.status !== 'success') emit({ type: 'error', msg: `Gemini turn ${o.status}` });
          return;
        }
        case 'error':
          emit({ type: 'error', msg: String(o.message || o.error || 'Gemini error') });
          return;
        default:
          return;
      }
    });

    // Gemini floods stderr with benign startup noise (color warning, ignore-file, YOLO banner,
    // key-selection, experiments, heap size) — NOT errors. Real failures arrive on stdout as
    // {type:error} or a non-success {type:result}. So we don't scrape stderr for "error-ish"
    // lines (that produced false notices); we just keep a short tail to explain a hard crash.
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-1500);
    });

    // A non-zero exit with no `result` emitted = a real startup/crash failure the JSON stream
    // never surfaced (bad model id, auth, OOM). Turn the stderr tail into one error event so
    // the chat shows WHY instead of going silent. Registered before the caller's own close
    // handler, so the box records this as the turn's lastError.
    child.on('close', (code) => {
      if (code && code !== 0 && !sawResult) {
        const tail = stderrTail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' ');
        emit({ type: 'error', msg: `Gemini exited ${code}${tail ? ': ' + tail.slice(-280) : ''}` });
      }
    });

    return child;
  }
}
