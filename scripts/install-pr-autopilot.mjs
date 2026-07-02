#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] || process.cwd());
const serviceDir = join(homedir(), '.config', 'systemd', 'user');
const servicePath = join(serviceDir, 'box-pr-autopilot.service');
const timerPath = join(serviceDir, 'box-pr-autopilot.timer');
const node = process.execPath;

mkdirSync(serviceDir, { recursive: true });

writeFileSync(servicePath, `[Unit]
Description=Box PR autopilot
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${root}
TimeoutStartSec=30min
Environment=BOX_PR_REPO=incidentfox/box
Environment=BOX_PR_AUTO_MERGE=1
Environment=BOX_PR_REAL_MODEL=trusted
Environment=BOX_PR_REVIEW_MODEL=gpt-4.1-mini
Environment=BOX_PR_SMOKE_MODEL=gpt-4.1-mini
ExecStart=${node} scripts/pr-autopilot.mjs --once
`, 'utf8');

writeFileSync(timerPath, `[Unit]
Description=Run Box PR autopilot every 3 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=3min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
`, 'utf8');

console.log(`wrote ${servicePath}`);
console.log(`wrote ${timerPath}`);
console.log('enable with: systemctl --user daemon-reload && systemctl --user enable --now box-pr-autopilot.timer');
