import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meetingIdsFromText, renderMeetingContextForIssue } from './meeting-context.mjs';

const root = mkdtempSync(join(tmpdir(), 'box-meeting-context-'));
try {
  const meetings = join(root, 'meetings');
  mkdirSync(join(meetings, 'frames', '2026', '06', '30', '10062208'), { recursive: true });
  writeFileSync(join(meetings, 'frames', '2026', '06', '30', '10062208', 'frame-0000-t34.jpg'), 'fake');
  writeFileSync(join(meetings, '2026-06-30--billing--mtg-cb-10062208.md'), `---
id: mtg-cb-10062208
title: "Billing System Updates"
transcript_source: "deepgram-nova-3"
---

# Billing System Updates

## Notes

Party notice should populate the patient address.

## Captured Frames

![frame](https://example.r2.dev/x?X-Amz-Signature=secret)

## Transcript

This markdown transcript should not be used when JSON transcript exists.
`);
  writeFileSync(join(meetings, '2026-06-30--billing--mtg-cb-10062208.json'), JSON.stringify({
    id: 'mtg-cb-10062208',
    title: 'Billing System Updates',
    date: '2026-06-30',
    durationSeconds: 860,
    transcriptSource: 'deepgram-nova-3',
    recordingR2Key: 'recordings/2026/06/30/10062208/recording.mp4',
    keyFrames: [{ timestamp: 33.9747, category: 'demo-ui', caption: 'MindBill UI', r2Key: 'frames/2026/06/30/10062208/frame-0000-t34.jpg' }],
    transcript: [
      { speaker: 'Jimmy', timestamp: 794, text: 'Add a drop down to upload the party notice.' },
      { speaker: 'Elizabeth', timestamp: 805, text: 'That should fill the patient address.' },
    ],
  }), 'utf8');

  assert.deepEqual(meetingIdsFromText('Source: meeting mtg-cb-10062208.\nmeeting:mtg-cb-10062208'), ['mtg-cb-10062208']);

  const ctx = renderMeetingContextForIssue({
    title: 'Add party notice upload',
    description: 'Repo: daisybill-clone\nSource: meeting mtg-cb-10062208.\nmeeting:mtg-cb-10062208',
    labels: [{ name: 'from-meeting' }],
  }, { brainDir: root });
  assert.match(ctx, /Meeting Context \(mtg-cb-10062208\)/);
  assert.match(ctx, /Party notice should populate the patient address/);
  assert.match(ctx, /Full Transcript \(deepgram-nova-3\)/);
  assert.match(ctx, /\[13:14\] Jimmy/);
  assert.match(ctx, /frames\/2026\/06\/30\/10062208\/frame-0000-t34\.jpg/);
  assert.doesNotMatch(ctx, /X-Amz-Signature=secret/);

  console.log('meeting-context.test.mjs passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
