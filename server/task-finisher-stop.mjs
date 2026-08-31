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

export function ensureTaskFinisherStopScript({
  home, stateDir, commandPath = '~/stop.sh', preserveExisting = true, shared = false,
}) {
  const fallbackDir = join(stateDir, 'autocontinue-bin');
  const fallbackPath = join(fallbackDir, 'stop.sh');
  const homePath = join(home, 'stop.sh');
  const markerDir = join(stateDir, 'autocontinue-stops');
  const script = `#!/usr/bin/env bash
${MANAGED_SENTINEL}
set -eu
session_id="\${1:-}"
if [ -z "$session_id" ]; then
  echo "Usage: bash ${commandPath} <session-id>" >&2
  exit 2
fi
marker_dir=${shellQuote(markerDir)}
mkdir -p "$marker_dir"
marker="$(printf '%s' "$session_id" | sha256sum | awk '{print $1}')"
umask 077
: > "$marker_dir/$marker"
printf 'Automatic continuation reminders stopped for session %s.\n' "$session_id"
`;

  const dirMode = shared ? 0o2770 : 0o700;
  const fileMode = shared ? 0o750 : 0o700;
  mkdirSync(home, { recursive: true, mode: dirMode });
  if (shared) chmodSync(home, dirMode);
  mkdirSync(markerDir, { recursive: true, mode: dirMode });
  mkdirSync(fallbackDir, { recursive: true, mode: dirMode });
  if (shared) {
    chmodSync(markerDir, dirMode);
    chmodSync(fallbackDir, dirMode);
  }
  writeFileSync(fallbackPath, script, { mode: fileMode });
  chmodSync(fallbackPath, fileMode);

  let homeManaged = !preserveExisting || !existsSync(homePath);
  if (!homeManaged) {
    try { homeManaged = readFileSync(homePath, 'utf8').includes(MANAGED_SENTINEL); }
    catch { homeManaged = false; }
  }
  if (homeManaged) {
    writeFileSync(homePath, script, { mode: fileMode });
    chmodSync(homePath, fileMode);
    return `bash ${commandPath}`;
  }
  return 'bash ~/.cc-mobile/autocontinue-bin/stop.sh';
}
