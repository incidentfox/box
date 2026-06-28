#!/usr/bin/env node
// google-auth.mjs — one-time setup for the `google` CLI. Walks you through an OAuth
// consent and writes ~/.config/box/google.env (client id/secret + refresh token).
//
// Works headlessly (e.g. on a server over SSH): it prints a URL, you open it in ANY
// browser, approve, and paste back the `code` from the redirected address bar.
//
// First, create an OAuth client in Google Cloud (see concierge/50-power-ups.md):
//   APIs & Services → Credentials → Create credentials → OAuth client ID →
//   Application type: **Desktop app**. Enable the Gmail, Calendar, and Drive APIs.
//
// Then run ONE of:
//   node harness/google-auth.mjs --from ~/Downloads/client_secret_xxx.json
//   node harness/google-auth.mjs --id <CLIENT_ID> --secret <CLIENT_SECRET>
//   node harness/google-auth.mjs            # will prompt for id + secret
//
// Options: --account <name> (writes google-<name>.env), --scopes "<space-separated>".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

const CFG_DIR = process.env.BOX_GOOGLE_DIR || path.join(os.homedir(), ".config", "box");
const account = opt("--account");
const OUT = path.join(CFG_DIR, !account || account === "default" ? "google.env" : `google-${account}.env`);
const REDIRECT = "http://localhost";
const SCOPES = opt("--scopes") || [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const ask = (q) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});

function fromJson(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = j.installed || j.web || j;
  return { id: c.client_id, secret: c.client_secret };
}

async function main() {
  let id, secret;
  const jsonFile = opt("--from");
  if (jsonFile) ({ id, secret } = fromJson(jsonFile));
  id = opt("--id") || id || (await ask("OAuth client ID: "));
  secret = opt("--secret") || secret || (await ask("OAuth client secret: "));
  if (!id || !secret) { console.error("client id + secret are required"); process.exit(1); }

  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: id, redirect_uri: REDIRECT, response_type: "code", scope: SCOPES,
    access_type: "offline", prompt: "consent",
  });

  console.log("\n1) Open this URL in a browser and approve access:\n");
  console.log("   " + authUrl + "\n");
  console.log("2) Your browser will redirect to http://localhost/?code=...  (the page won't load —");
  console.log("   that's fine). Copy the `code` value from the address bar.\n");
  const code = await ask("3) Paste the code here: ");
  if (!code) { console.error("no code provided"); process.exit(1); }

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
  });
  const j = await r.json();
  if (!j.refresh_token) {
    console.error("\nNo refresh_token returned. Response:\n" + JSON.stringify(j, null, 2));
    console.error("\nTip: revoke prior access at https://myaccount.google.com/permissions and retry " +
      "(refresh tokens are only issued on first consent / with prompt=consent).");
    process.exit(1);
  }

  // best-effort: which account did we just authorize?
  let email = "";
  try {
    const me = await (await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${j.access_token}` } })).json();
    email = me.email || "";
  } catch {}

  fs.mkdirSync(CFG_DIR, { recursive: true });
  const body = [
    email ? `GOOGLE_ACCOUNT_EMAIL=${email}` : null,
    `GOOGLE_OAUTH_CLIENT_ID=${id}`,
    `GOOGLE_OAUTH_CLIENT_SECRET=${secret}`,
    `GOOGLE_OAUTH_REFRESH_TOKEN=${j.refresh_token}`,
    `GOOGLE_OAUTH_SCOPES=${SCOPES}`,
  ].filter(Boolean).join("\n") + "\n";
  fs.writeFileSync(OUT, body, { mode: 0o600 });
  console.log(`\n✅ Wrote ${OUT}${email ? ` for ${email}` : ""}`);
  console.log(`   Test it:  node harness/google${account ? " " + account : ""} gmail list "is:unread" 5`);
}

main().catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
