import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MANAGED_SENTINEL = '# Managed by Box automatic continuation reminders.';

function markerName(sessionId) {
  return createHash('sha256').update(String(sessionId || '')).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function taskFinisherStopMarkerPath(stateDir, sessionId) {
  return join(stateDir, 'autocontinue-stops', markerName(sessionId));
}

export function taskFinisherStopped(stateDir, sessionId) {
  return existsSync(taskFinisherStopMarkerPath(stateDir, sessionId));
}

export function clearTaskFinisherStop(stateDir, sessionId) {
  try { unlinkSync(taskFinisherStopMarkerPath(stateDir, sessionId)); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

export function taskFinisherReminder(sessionId, stopCommand = 'bash ~/stop.sh') {
  return `This is an automated message. Continue. If done already, run the command \`${stopCommand} ${shellQuote(sessionId)}\` to stop future automated continuation reminders and prevent going in a loop.`;
}

export function ensureTaskFinisherStopScript({ home, stateDir }) {
  const fallbackDir = join(stateDir, 'autocontinue-bin');
  const fallbackPath = join(fallbackDir, 'stop.sh');
  const homePath = join(home, 'stop.sh');
  const markerDir = join(stateDir, 'autocontinue-stops');
  const script = `#!/usr/bin/env bash
${MANAGED_SENTINEL}
set -eu
session_id="\${1:-}"
if [ -z "$session_id" ]; then
  echo "Usage: bash ~/stop.sh <session-id>" >&2
  exit 2
fi
marker_dir=${shellQuote(markerDir)}
mkdir -p "$marker_dir"
marker="$(printf '%s' "$session_id" | sha256sum | awk '{print $1}')"
umask 077
: > "$marker_dir/$marker"
printf 'Automatic continuation reminders stopped for session %s.\n' "$session_id"
`;

  mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
  writeFileSync(fallbackPath, script, { mode: 0o700 });
  chmodSync(fallbackPath, 0o700);

  let homeManaged = !existsSync(homePath);
  if (!homeManaged) {
    try { homeManaged = readFileSync(homePath, 'utf8').includes(MANAGED_SENTINEL); }
    catch { homeManaged = false; }
  }
  if (homeManaged) {
    writeFileSync(homePath, script, { mode: 0o700 });
    chmodSync(homePath, 0o700);
    return 'bash ~/stop.sh';
  }
  return 'bash ~/.cc-mobile/autocontinue-bin/stop.sh';
}
