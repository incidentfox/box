#!/usr/bin/env node
// google — a tiny, dependency-free CLI for Gmail / Calendar / Drive, so your Box agents
// can read & send your email, check your calendar, and read your Drive. (Node 18+.)
//
// Setup: run `node harness/google-auth.mjs` once to create ~/.config/box/google.env
// (client id/secret + refresh token). See concierge/50-power-ups.md for the full walkthrough.
//
// Usage (the account arg is OPTIONAL — omit it to use the default ~/.config/box/google.env):
//   google status
//   google token
//   google api <METHOD> <path-or-url> [jsonBody]
//   google gmail list "<query>" [max]
//   google gmail get <messageId>
//   google gmail send <to> "<subject>" "<body>"
//   google cal list [max] [calendarId]
//   google cal add "<summary>" <startISO> <endISO> [calendarId]
//   google drive list ["<query>"] [max]
//   google drive get <fileId> [outPath]
//
// Multiple accounts: put extra creds in ~/.config/box/google-<name>.env and prefix commands
// with <name>, e.g. `google work gmail list "is:unread" 5`.
//
// Examples:
//   google gmail list "is:unread newer_than:2d" 10
//   google gmail send me@example.com "box note" "deploy finished ✅"
//   google cal list 5
//   google drive list "name contains 'invoice'" 20

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CFG_DIR = process.env.BOX_GOOGLE_DIR || path.join(os.homedir(), ".config", "box");
const GROUPS = new Set(["status", "token", "api", "gmail", "cal", "drive"]);

function die(msg, code = 1) { process.stderr.write(msg + "\n"); process.exit(code); }

function parseEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function accountFile(name) {
  const fname = (!name || name === "default" || name === "me") ? "google.env" : `google-${name}.env`;
  return path.join(CFG_DIR, fname);
}

function loadAccount(name) {
  const file = accountFile(name);
  if (!fs.existsSync(file)) die(`Credentials file not found: ${file}\nRun: node harness/google-auth.mjs   (see concierge/50-power-ups.md)`);
  const env = parseEnv(file);
  for (const k of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"])
    if (!env[k]) die(`Missing ${k} in ${file}`);
  return env;
}

let _tokenCache = null;
async function accessToken(env, { dieOnError = true } = {}) {
  if (_tokenCache) return _tokenCache;
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const j = await r.json();
  if (!j.access_token) {
    const msg = `Token refresh failed: ${JSON.stringify(j)}`;
    if (dieOnError) die(msg);
    throw new Error(msg);
  }
  _tokenCache = j.access_token;
  return _tokenCache;
}

async function api(env, method, urlOrPath, body, { raw = false } = {}) {
  const token = await accessToken(env);
  const url = urlOrPath.startsWith("http")
    ? urlOrPath
    : "https://www.googleapis.com" + (urlOrPath.startsWith("/") ? urlOrPath : "/" + urlOrPath);
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined && body !== null) {
    headers["Content-Type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const r = await fetch(url, { method, headers, body: payload });
  if (raw) return r;
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) die(`HTTP ${r.status} ${method} ${url}\n${typeof j === "string" ? j : JSON.stringify(j, null, 2)}`);
  return j;
}

const out = (x) => process.stdout.write((typeof x === "string" ? x : JSON.stringify(x, null, 2)) + "\n");
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function gmailBodyText(payload) {
  if (!payload) return "";
  if (payload.body?.data && (payload.mimeType || "").startsWith("text/")) return b64urlDecode(payload.body.data);
  for (const p of payload.parts || []) {
    if (p.mimeType === "text/plain" && p.body?.data) return b64urlDecode(p.body.data);
  }
  for (const p of payload.parts || []) { const t = gmailBodyText(p); if (t) return t; }
  return "";
}

function showHelp() {
  out(fs.readFileSync(new URL(import.meta.url)).toString().split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
}

async function showStatus(account) {
  const file = accountFile(account);
  out("google CLI: installed");
  out(`config dir: ${CFG_DIR}`);
  out(`credentials: ${file}`);
  if (!fs.existsSync(file)) {
    out("status: not authorized");
    out("next: node harness/google-auth.mjs --from /path/client_secret.json");
    return;
  }

  const env = parseEnv(file);
  out(`account: ${env.GOOGLE_ACCOUNT_EMAIL || account || "default"}`);
  out(`scopes: ${env.GOOGLE_OAUTH_SCOPES || "(not recorded)"}`);
  try {
    await accessToken(env, { dieOnError: false });
    out("token refresh: OK");
    out("ready: google gmail list \"is:unread\" 5");
  } catch (e) {
    out(`token refresh: FAILED (${String(e?.message || e)})`);
    process.exitCode = 1;
  }
}

async function main() {
  let [a0, ...restAll] = process.argv.slice(2);
  if (!a0 || a0 === "-h" || a0 === "--help" || a0 === "help") { showHelp(); process.exit(0); }
  // account arg is optional: if the first token is a known group, use the default account.
  let account, group, rest;
  if (GROUPS.has(a0)) { account = "default"; group = a0; rest = restAll; }
  else { account = a0; group = restAll[0]; rest = restAll.slice(1); }
  if (group === "status") { await showStatus(account); return; }
  const env = loadAccount(account);

  switch (group) {
    case "token": out(await accessToken(env)); break;

    case "api": {
      const [method, url, jsonBody] = rest;
      if (!method || !url) die("usage: google [account] api <METHOD> <path-or-url> [jsonBody]");
      out(await api(env, method.toUpperCase(), url, jsonBody));
      break;
    }

    case "gmail": {
      const [sub, ...a] = rest;
      const U = "https://gmail.googleapis.com/gmail/v1/users/me";
      if (sub === "list") {
        const q = a[0] || ""; const max = a[1] || "20";
        const res = await api(env, "GET", `${U}/messages?q=${encodeURIComponent(q)}&maxResults=${max}`);
        const msgs = res.messages || [];
        for (const m of msgs) {
          const full = await api(env, "GET", `${U}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          const h = Object.fromEntries((full.payload?.headers || []).map((x) => [x.name, x.value]));
          out(`${m.id}\t${h.Date || ""}\t${(h.From || "").slice(0, 40)}\t${h.Subject || ""}`);
        }
        if (!msgs.length) out("(no messages)");
      } else if (sub === "get") {
        if (!a[0]) die("usage: google [account] gmail get <messageId>");
        const full = await api(env, "GET", `${U}/messages/${a[0]}?format=full`);
        const h = Object.fromEntries((full.payload?.headers || []).map((x) => [x.name, x.value]));
        out(`From: ${h.From}\nTo: ${h.To}\nDate: ${h.Date}\nSubject: ${h.Subject}\n\n${gmailBodyText(full.payload)}`);
      } else if (sub === "send") {
        const [to, subject, bodyText] = a;
        if (!to || !subject) die('usage: google [account] gmail send <to> "<subject>" "<body>"');
        const raw = Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText || ""}`)
          .toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
        out(await api(env, "POST", `${U}/messages/send`, { raw }));
      } else die("gmail subcommands: list | get | send");
      break;
    }

    case "cal": {
      const [sub, ...a] = rest;
      if (sub === "list") {
        const max = a[0] || "10"; const cal = a[1] || "primary";
        const nowIso = new Date(Date.now()).toISOString();
        const res = await api(env, "GET",
          `/calendar/v3/calendars/${encodeURIComponent(cal)}/events?singleEvents=true&orderBy=startTime&maxResults=${max}&timeMin=${encodeURIComponent(nowIso)}`);
        for (const e of res.items || []) out(`${(e.start?.dateTime || e.start?.date || "").slice(0, 16)}\t${e.summary || "(no title)"}\t[${e.id}]`);
        if (!(res.items || []).length) out("(no upcoming events)");
      } else if (sub === "add") {
        const [summary, start, end, cal = "primary"] = a;
        if (!summary || !start || !end) die('usage: google [account] cal add "<summary>" <startISO> <endISO> [calendarId]');
        out(await api(env, "POST", `/calendar/v3/calendars/${encodeURIComponent(cal)}/events`,
          { summary, start: { dateTime: start }, end: { dateTime: end } }));
      } else die("cal subcommands: list | add");
      break;
    }

    case "drive": {
      const [sub, ...a] = rest;
      if (sub === "list") {
        const q = a[0]; const max = a[1] || "20";
        let url = `/drive/v3/files?pageSize=${max}&fields=files(id,name,mimeType,modifiedTime,size)`;
        if (q) url += `&q=${encodeURIComponent(q)}`;
        const res = await api(env, "GET", url);
        for (const f of res.files || []) out(`${f.id}\t${f.mimeType}\t${f.name}`);
        if (!(res.files || []).length) out("(no files)");
      } else if (sub === "get") {
        const [fileId, outPath] = a;
        if (!fileId) die("usage: google [account] drive get <fileId> [outPath]");
        const r = await api(env, "GET", `/drive/v3/files/${fileId}?alt=media`, undefined, { raw: true });
        if (!r.ok) die(`HTTP ${r.status}: ${await r.text()}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (outPath) { fs.writeFileSync(outPath, buf); out(`wrote ${buf.length} bytes -> ${outPath}`); }
        else process.stdout.write(buf);
      } else die("drive subcommands: list | get");
      break;
    }

    default: die(`Unknown command "${group}". Run: google --help`);
  }
}

main().catch((e) => die(String(e?.stack || e)));
