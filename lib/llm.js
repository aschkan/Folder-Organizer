'use strict';

const { knownCategories, OTHERS } = require('./categorize');

const DEFAULT_URL = 'http://localhost:1234/api/v1/chat';
const DEFAULT_MODEL = 'gemma-3-4b-it';

/**
 * Pulls a plausible text answer out of an arbitrary LLM response JSON shape,
 * since the local API's response format is not guaranteed.
 */
function extractText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (typeof data.output === 'string') return data.output;
  if (typeof data.response === 'string') return data.response;
  if (typeof data.text === 'string') return data.text;
  if (typeof data.result === 'string') return data.result;
  if (typeof data.content === 'string') return data.content;
  if (Array.isArray(data.content)) {
    const t = data.content.find((c) => typeof c?.text === 'string');
    if (t) return t.text;
  }
  if (Array.isArray(data.choices) && data.choices[0]) {
    const c = data.choices[0];
    if (typeof c.text === 'string') return c.text;
    if (typeof c.message?.content === 'string') return c.message.content;
  }
  if (typeof data.message?.content === 'string') return data.message.content;
  return '';
}

async function testConnection(url = DEFAULT_URL, model = DEFAULT_MODEL) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        system_prompt: 'Reply with only the single word: OK',
        input: 'ping',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    const text = extractText(data);
    return { ok: true, sample: text || JSON.stringify(data).slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Asks the local LLM to pick a category for a file it couldn't classify by extension.
 * Falls back to "others" on any failure or if the answer doesn't match a known category.
 */
async function classifyWithLLM({ filename, ext, url = DEFAULT_URL, model = DEFAULT_MODEL }) {
  const categories = knownCategories().filter((c) => c !== OTHERS);
  const system_prompt =
    `You classify files into exactly one category by their filename and extension. ` +
    `Valid categories: ${categories.join(', ')}, ${OTHERS}. ` +
    `Reply with ONLY the category word, nothing else, no punctuation, no explanation.`;
  const input = `Filename: "${filename}"  Extension: "${ext || '(none)'}"`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, system_prompt, input }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return OTHERS;
    const data = await res.json().catch(() => null);
    const raw = extractText(data).toLowerCase();
    const found = categories.find((c) => raw.includes(c.replace(/_/g, ' ')) || raw.includes(c));
    return found || OTHERS;
  } catch {
    return OTHERS;
  }
}

/** Normalizes a free-form category name from the LLM into a safe slug, or '' if unusable. */
function normalizeCategory(raw) {
  if (!raw) return '';
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/[\s/\\-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  s = s.replace(/^_+|_+$/g, '');
  if (!s || s.length > 40) return '';
  return s;
}

function stripFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

/**
 * Classifies unknown file types in a single LLM call. Each item carries CONTEXT
 * (a sample filename and its path), not just the bare extension, so the model can
 * tell e.g. an action-cam ".insv" video from some unrelated ".insv". The model may
 * return one of the known categories OR invent a sensible new one - the whole point
 * is that we can't enumerate every format up front. Returns a map ext -> category.
 */
async function classifyBatchWithLLM({ items, url = DEFAULT_URL, model = DEFAULT_MODEL }) {
  if (!items || items.length === 0) return {};
  const categories = knownCategories().filter((c) => c !== OTHERS);
  const system_prompt =
    `You classify files into a single lowercase category based on their name, extension and folder path. ` +
    `Prefer one of these existing categories when it fits: ${categories.join(', ')}, ${OTHERS}. ` +
    `If none fits, invent a short, sensible lowercase category (one or two words, use _ for spaces). ` +
    `Reply with ONLY a JSON object mapping each extension to one category, no explanation, no markdown fences. ` +
    `Example: {"insv": "video", "sqlite": "databases"}`;
  const lines = items.map((it) => {
    const ex = it.example ? ` e.g. "${it.example}"` : '';
    const where = it.samplePath ? ` in "${it.samplePath}"` : '';
    return `.${it.ext}${ex}${where}`;
  });
  const input = `Files:\n${lines.join('\n')}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, system_prompt, input }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return {};
    const data = await res.json().catch(() => null);
    const parsed = JSON.parse(stripFences(extractText(data)));
    const result = {};
    for (const [ext, cat] of Object.entries(parsed)) {
      const normalized = normalizeCategory(cat);
      if (normalized) result[ext.toLowerCase()] = normalized;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Asks the LLM whether a folder is a self-contained application/program that must be
 * kept intact (moving its files apart would break it). Given the folder's name, path
 * and a sample of its contents. Returns { isApplication, category, appName } - defaults
 * to not-an-application on any failure, so a missing/broken LLM never locks a folder.
 */
async function classifyFolderWithLLM({ name, relPath, entryNames = [], url = DEFAULT_URL, model = DEFAULT_MODEL }) {
  const system_prompt =
    `You decide whether a folder is a self-contained software application/program/game whose files ` +
    `must stay together (splitting them would break it) - e.g. an installed app, portable app, browser, ` +
    `emulator, game, or SDK/runtime. A folder of ordinary documents, photos, music or videos is NOT one. ` +
    `Reply with ONLY a JSON object: {"isApplication": true/false, "category": "applications", "name": "<clean name or empty>"}. ` +
    `No explanation, no markdown fences.`;
  const input =
    `Folder name: "${name}"\nPath: "${relPath || name}"\nContains: ${entryNames.slice(0, 40).join(', ')}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, system_prompt, input }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { isApplication: false };
    const data = await res.json().catch(() => null);
    const raw = stripFences(extractText(data));
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // tolerate a bare yes/no answer
      return { isApplication: /\b(yes|true|application)\b/i.test(raw), category: 'applications' };
    }
    return {
      isApplication: parsed.isApplication === true || /^(yes|true)$/i.test(String(parsed.isApplication)),
      category: normalizeCategory(parsed.category) || 'applications',
      appName: typeof parsed.name === 'string' ? parsed.name.trim() : '',
    };
  } catch {
    return { isApplication: false };
  }
}

module.exports = {
  classifyWithLLM,
  classifyBatchWithLLM,
  classifyFolderWithLLM,
  normalizeCategory,
  testConnection,
  DEFAULT_URL,
  DEFAULT_MODEL,
};
