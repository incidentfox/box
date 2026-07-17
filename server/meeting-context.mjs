import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_TRANSCRIPT_MAX = 240000;
const DEFAULT_BRIEF_MAX = 80000;

const uniq = (xs) => [...new Set(xs.filter(Boolean))];

function firstExistingDir(candidates) {
  for (const d of candidates.filter(Boolean)) {
    try { if (existsSync(join(d, 'meetings'))) return d; } catch {}
  }
  return null;
}

export function meetingIdsFromText(...parts) {
  const ids = [];
  for (const part of parts) {
    const text = String(part || '');
    for (const m of text.matchAll(/\bmeeting:\s*(mtg-cb-\d+)\b/gi)) ids.push(m[1]);
    for (const m of text.matchAll(/\bSource:\s*meeting\s+(mtg-cb-\d+)\b/gi)) ids.push(m[1]);
    for (const m of text.matchAll(/\b(mtg-cb-\d+)\b/gi)) ids.push(m[1]);
  }
  return uniq(ids.map((id) => id.toLowerCase()));
}

export function findCompanyBrainDir(opts = {}) {
  return firstExistingDir([
    opts.brainDir,
    process.env.COMPANY_BRAIN_DIR,
    process.env.BRAIN_DIR,
    '/opt/software-factory/company-brain',
    join(homedir(), 'development', 'software-factory', 'brain'),
  ]);
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

function findMeetingArtifactFiles(meetingId, brainDir) {
  const meetingsDir = join(brainDir, 'meetings');
  let files = [];
  try { files = readdirSync(meetingsDir).filter((f) => f.includes(meetingId)); } catch {}
  const pick = (ext) => files.find((f) => f.endsWith(ext));
  return {
    meetingsDir,
    json: pick('.json') ? join(meetingsDir, pick('.json')) : '',
    markdown: pick('.md') ? join(meetingsDir, pick('.md')) : '',
    pdf: pick('.pdf') ? join(meetingsDir, pick('.pdf')) : '',
  };
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function normalizeTranscript(transcript) {
  if (!transcript) return '';
  if (typeof transcript === 'string') return transcript.trim();
  if (Array.isArray(transcript)) {
    return transcript.map((seg) => {
      if (typeof seg === 'string') return seg.trim();
      const speaker = seg.speaker || seg.name || seg.role || 'Speaker';
      const text = seg.text || seg.transcript || seg.content || '';
      const ts = seg.timestamp ?? seg.start ?? seg.startTime ?? seg.start_seconds;
      const prefix = ts == null ? `**${speaker}:**` : `**[${fmtTime(ts)}] ${speaker}:**`;
      return text ? `${prefix} ${String(text).trim()}` : '';
    }).filter(Boolean).join('\n\n');
  }
  if (Array.isArray(transcript.segments)) return normalizeTranscript(transcript.segments);
  if (Array.isArray(transcript.results)) return normalizeTranscript(transcript.results);
  if (transcript.text) return String(transcript.text).trim();
  return JSON.stringify(transcript, null, 2);
}

function briefWithoutTranscript(markdown) {
  const text = String(markdown || '');
  const idx = text.search(/^## Transcript\b/m);
  const brief = idx >= 0 ? text.slice(0, idx).trim() : text.trim();
  return brief
    .replace(/https:\/\/[^\s)]+X-Amz-[^\s)]*/g, '[presigned-url-redacted-use-stable-r2-key]')
    .trim();
}

function limitText(label, text, max, file) {
  const n = Number(max);
  if (!n || n < 0 || text.length <= n) return text;
  return `${text.slice(0, n)}\n\n[TRUNCATED ${label}: ${text.length - n} chars omitted. Read the complete artifact at ${file}.]`;
}

function localFramePath(meetingsDir, r2Key) {
  if (!r2Key || !String(r2Key).startsWith('frames/')) return '';
  return join(meetingsDir, r2Key);
}

function frameLines(j, files) {
  const frames = Array.isArray(j?.keyFrames) ? j.keyFrames : [];
  if (!frames.length) return [];
  return frames.map((f, i) => {
    const r2 = f.r2Key || f.key || '';
    const local = localFramePath(files.meetingsDir, r2);
    const parts = [
      `- ${fmtTime(f.timestamp)} ${f.category || 'frame'}: ${f.caption || f.frameId || `frame ${i + 1}`}`,
      r2 ? `R2 key: ${r2}` : '',
      local ? `local path: ${local}${existsSync(local) ? '' : ' (not present locally)'}` : '',
    ].filter(Boolean);
    return parts.join(' · ');
  });
}

export function renderMeetingContext(meetingId, opts = {}) {
  const brainDir = findCompanyBrainDir(opts);
  if (!brainDir) return '';
  const id = String(meetingId || '').toLowerCase();
  const files = findMeetingArtifactFiles(id, brainDir);
  if (!files.json && !files.markdown) return '';

  const j = files.json ? readJson(files.json) : null;
  const md = files.markdown ? readText(files.markdown) : '';
  const title = j?.title || (md.match(/^title:\s*"?([^"\n]+)"?/m) || [])[1] || id;
  const transcript = normalizeTranscript(j?.transcript);
  const transcriptSource = j?.transcriptSource || j?.transcript_source || (md.match(/^transcript_source:\s*"?([^"\n]+)"?/m) || [])[1] || 'unknown';
  const brief = briefWithoutTranscript(md);
  const transcriptFallback = transcript || (md.match(/^## Transcript\b[\s\S]*$/m) || [])[0] || '';
  const maxBrief = opts.maxBriefChars ?? Number(process.env.MEETING_CONTEXT_MAX_BRIEF_CHARS || DEFAULT_BRIEF_MAX);
  const maxTranscript = opts.maxTranscriptChars ?? Number(process.env.MEETING_CONTEXT_MAX_TRANSCRIPT_CHARS || DEFAULT_TRANSCRIPT_MAX);
  const frames = frameLines(j, files);

  const artifactLines = [
    `- Meeting id: ${id}`,
    `- Title: ${title}`,
    j?.date ? `- Date: ${j.date}` : '',
    j?.durationSeconds ? `- Duration: ${fmtTime(j.durationSeconds)}` : '',
    files.markdown ? `- Summary/brief markdown: ${files.markdown}` : '',
    files.json ? `- Structured transcript JSON: ${files.json}` : '',
    files.pdf ? `- PDF brief: ${files.pdf}` : '',
    j?.recordingR2Key ? `- Recording R2 key: ${j.recordingR2Key}` : '',
    `- Transcript source: ${transcriptSource}`,
  ].filter(Boolean);

  const out = [
    `## Meeting Context (${id})`,
    'This Linear issue was generated from a meeting. Use this context before implementation; do not rely only on the short Linear description.',
    '',
    '### Resolved Artifacts',
    ...artifactLines,
  ];

  if (frames.length) out.push('', `### Captured Screenshots / Frames (${frames.length})`, ...frames);
  if (brief) out.push('', '### Meeting Brief / Summary', limitText('meeting brief', brief, maxBrief, files.markdown));
  if (transcriptFallback) out.push('', `### Full Transcript (${transcriptSource})`, limitText('meeting transcript', transcriptFallback, maxTranscript, files.json || files.markdown));

  return out.join('\n').trim();
}

export function renderMeetingContextForIssue(issue, opts = {}) {
  const labelText = ((issue?.labels?.nodes || issue?.labels || [])).map((l) => l?.name || l).join('\n');
  const ids = meetingIdsFromText(issue?.description, issue?.title, labelText);
  return ids.map((id) => renderMeetingContext(id, opts)).filter(Boolean).join('\n\n---\n\n');
}
