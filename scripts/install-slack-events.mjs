#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] || process.cwd());
const serviceDir = join(homedir(), '.config', 'systemd', 'user');
const servicePath = join(serviceDir, 'box-slack-events.service');
const timerPath = join(serviceDir, 'box-slack-events.timer');
const envPath = join(homedir(), '.config', 'box', 'slack-events.env');
const node = process.execPath;

mkdirSync(serviceDir, { recursive: true });

writeFileSync(servicePath, `[Unit]
Description=Emit Box Slack messages into the factory activity stream
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${root}
TimeoutStartSec=2min
EnvironmentFile=-${envPath}
ExecStart=${node} harness/slack.mjs emit-recent
`, 'utf8');

writeFileSync(timerPath, `[Unit]
Description=Poll Slack for Box activity events

[Timer]
OnBootSec=90s
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
`, 'utf8');

console.log(`wrote ${servicePath}`);
console.log(`wrote ${timerPath}`);
console.log('enable with: systemctl --user daemon-reload && systemctl --user enable --now box-slack-events.timer');
