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

/**
 * Classifies many unknown extensions in a single LLM call instead of one request per file.
 * Returns a map of ext -> category. Falls back to an empty map on any failure
 * (callers should then fall back to "others" per-extension).
 */
async function classifyBatchWithLLM({ extensions, url = DEFAULT_URL, model = DEFAULT_MODEL }) {
  if (!extensions || extensions.length === 0) return {};
  const categories = knownCategories().filter((c) => c !== OTHERS);
  const system_prompt =
    `You classify file extensions into categories. ` +
    `Valid categories: ${categories.join(', ')}, ${OTHERS}. ` +
    `Reply with ONLY a JSON object mapping each given extension to one category, ` +
    `no explanation, no markdown fences. Example: {"xyz": "documents", "foo": "others"}`;
  const input = `Extensions: ${extensions.join(', ')}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, system_prompt, input }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return {};
    const data = await res.json().catch(() => null);
    let raw = extractText(data).trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    const parsed = JSON.parse(raw);
    const result = {};
    for (const [ext, cat] of Object.entries(parsed)) {
      const normalized = String(cat).toLowerCase().trim();
      result[ext.toLowerCase()] = categories.includes(normalized) ? normalized : OTHERS;
    }
    return result;
  } catch {
    return {};
  }
}

module.exports = { classifyWithLLM, classifyBatchWithLLM, testConnection, DEFAULT_URL, DEFAULT_MODEL };
