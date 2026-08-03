#!/usr/bin/env node
// One-time host operator tool. Keeps the Unix-account mapping out of browser APIs.
import { loadTeam, saveTeam } from '../server/team.mjs';

const [memberId, systemUser] = process.argv.slice(2);
if (!memberId || !/^box-[a-z][a-z0-9-]{0,30}$/.test(systemUser || '')) {
  console.error('usage: set-team-system-user.mjs <member-id> <box-unix-user>');
  process.exit(64);
}
const team = loadTeam();
const member = team.members.find((m) => m.id === memberId && !m.revokedAt);
if (!member) {
  console.error('active member not found');
  process.exit(65);
}
member.systemUser = systemUser;
saveTeam(team);
console.log(`mapped ${member.name} to ${systemUser}`);
