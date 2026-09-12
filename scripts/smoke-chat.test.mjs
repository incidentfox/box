import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const smoke = new URL('./smoke-chat.mjs', import.meta.url).pathname;
const wsModule = new URL('../node_modules/ws/wrapper.mjs', import.meta.url).href;
const token = 'synthetic-smoke-secret-"back\\slash';

for (const mode of ['success', 'error', 'timeout', 'mismatch', 'logs']) {
  test(`smoke command redacts reflected tokens on ${mode}`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'box-smoke-redaction-'));
    try {
      await mkdir(join(root, 'server'));
      await writeFile(join(root, 'server/index.mjs'), `
        import { createServer } from 'node:http';
        import { WebSocketServer } from ${JSON.stringify(wsModule)};
        const token = process.env.CC_AUTH_TOKEN;
        const mode = ${JSON.stringify(mode)};
        const server = createServer((_req, res) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ features: { codex: true } }));
        });
        const wss = new WebSocketServer({ server });
        wss.on('connection', ws => ws.on('message', raw => {
          const msg = JSON.parse(raw);
          const send = value => ws.send(JSON.stringify(value));
          if (msg.type === 'subscribe') send({ type: 'sync' });
          if (msg.type !== 'enqueue') return;
          send({ type: 'session', id: token });
          send({ type: 'activity', activityAt: Date.now(), activityLabel: token });
          if (mode === 'logs') console.error(token);
          if (mode === 'error') {
            send({ type: 'error', msg: 'reflected token: ' + token });
            return;
          }
          // Place a token across each output truncation boundary as well.
          const text = mode === 'success' || mode === 'logs'
            ? 'BOX_SMOKE_OK ' + token + 'x'.repeat(440) + token
            : token + 'x'.repeat(mode === 'timeout' ? 220 : 480);
          send({ type: 'text', delta: text });
          if (mode !== 'timeout') send({ type: 'done', sessionId: token });
        }));
        server.listen(Number(process.env.PORT), '127.0.0.1');
      `);
      let result;
      try {
        result = await run(process.execPath, [smoke, '--root', root, '--token', token, '--timeout', '2500'], { timeout: 10000 });
        result.code = 0;
      } catch (error) {
        assert.equal(error.killed, false, 'smoke must exit on its own, including after timeout');
        result = error;
      }
      assert.equal(result.code, mode === 'success' ? 0 : 1);
      const output = result.stdout + result.stderr;
      for (const secret of [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token), 'synthetic-smoke-secret']) {
        assert.ok(!output.includes(secret), `output leaked token on ${mode}`);
      }
      const report = JSON.parse(mode === 'success' ? result.stdout : result.stderr);
      assert.equal(report.ok, mode === 'success');
      assert.ok(output.includes('[REDACTED]'));
      if (mode === 'success') {
        assert.equal(report.sessionId, '[REDACTED]');
        assert.equal(report.activity[0].label, '[REDACTED]');
        assert.match(report.response, /^BOX_SMOKE_OK/);
      } else if (mode === 'timeout') {
        assert.match(report.error, /smoke timed out/);
      } else if (mode === 'logs') {
        assert.match(report.error, /server logs exposed the authentication token/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
