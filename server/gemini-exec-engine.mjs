import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_STUDIO_API_KEY || process.env.GOOGLE_API_KEY || '';
}

function mimeTypeFor(filePath) {
  const ext = extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.heic') return 'image/heic';
  return 'application/octet-stream';
}

function imagePart(filePath) {
  const data = readFileSync(filePath);
  return { inlineData: { mimeType: mimeTypeFor(filePath), data: data.toString('base64') } };
}

function historyToContents(history = []) {
  const contents = [];
  for (const msg of history || []) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const parts = [];
    for (const part of msg.parts || []) {
      if (!part) continue;
      if (part.t === 'text' && part.text) parts.push({ text: String(part.text) });
      else if (part.t === 'image' && part.path) {
        try { parts.push(imagePart(part.path)); } catch {}
      }
    }
    if (!parts.length) continue;
    contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}

export class GeminiExecEngine {
  run({ sessionId, prompt, images = [], settings = {}, history = [], onEvent, apiKey: providedKey }) {
    const controller = new AbortController();
    const sid = sessionId || randomUUID();
    const emit = (event) => {
      try { onEvent?.(event); } catch {}
    };
    const promise = (async () => {
      const key = String(providedKey || '').trim() || apiKey();
      if (!key) throw new Error('Missing Gemini API key. Set GEMINI_API_KEY, GOOGLE_AI_STUDIO_API_KEY, or GOOGLE_API_KEY.');
      const model = settings.model || 'gemini-3.5-flash';
      const contents = historyToContents(history);
      const userParts = [];
      if (String(prompt || '').trim()) userParts.push({ text: String(prompt) });
      for (const img of images || []) {
        try { userParts.push(imagePart(img)); } catch {}
      }
      if (userParts.length) contents.push({ role: 'user', parts: userParts });
      const body = { contents };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await r.text();
      let data = null;
      try { data = JSON.parse(raw); } catch {}
      if (!r.ok) throw new Error((data && data.error && data.error.message) || raw || `Gemini request failed (${r.status})`);
      const candidate = (data && data.candidates && data.candidates[0]) || null;
      const text = (candidate && candidate.content && candidate.content.parts || [])
        .map((p) => p && p.text ? String(p.text) : '')
        .filter(Boolean)
        .join('')
        .trim();
      if (!text) {
        const reason = (candidate && candidate.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason) || 'no text';
        throw new Error(`Gemini returned ${reason}`);
      }
      emit({ type: 'text', delta: text });
      return text;
    })();
    return {
      sessionId: sid,
      promise,
      kill() {
        try { controller.abort(); } catch {}
      },
    };
  }
}
