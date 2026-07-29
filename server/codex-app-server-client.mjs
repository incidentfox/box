import { spawn } from 'node:child_process';

// Make one short-lived stdio app-server connection for a control-plane request.
// Box still uses `codex exec --json` for turns; this client is only for native
// thread operations (goals, compaction, and background terminals) that exec does
// not expose as CLI flags.
export function createCodexRpc({ spawnImpl = spawn, timeoutMs = 10000 } = {}) {
  return function codexRpc(method, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (options.lingerMs > 0 && !err) setTimeout(() => { try { child.kill(); } catch {} }, options.lingerMs).unref?.();
        else { try { child.kill(); } catch {} }
        if (err) reject(err); else resolve(value);
      };
      const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
      const timer = setTimeout(() => finish(new Error(`Codex app-server timed out during ${method}`)), timeoutMs);

      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
      child.on('error', (err) => finish(err));
      child.on('exit', (code) => {
        if (!settled) finish(new Error(`Codex app-server exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
      });
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        for (;;) {
          const newline = stdout.indexOf('\n');
          if (newline < 0) break;
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 0) {
            if (message.error) return finish(new Error(message.error.message || 'Codex app-server initialization failed'));
            send({ method: 'initialized', params: {} });
            send({ method, id: 1, params });
          } else if (message.id === 1) {
            if (message.error) finish(new Error(message.error.message || `${method} failed`));
            else finish(null, message.result);
          }
        }
      });

      send({
        method: 'initialize', id: 0,
        params: { clientInfo: { name: 'box', title: 'Box', version: '1' }, capabilities: { experimentalApi: true } },
      });
    });
  };
}

export const codexRpc = createCodexRpc();
