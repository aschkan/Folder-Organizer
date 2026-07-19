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
 * Asks the LLM whether a folder is a self-contained UNIT that must be kept intact
 * (splitting its files apart would break it or lose its meaning) - e.g. an installed
 * or portable app, a browser, an emulator, a game, an SDK/runtime, an on-disk database,
 * a saved web page, a machine-learning model repo, or a dataset. A folder of ordinary
 * loose documents/photos/music/videos is NOT one. Given the folder's name, path and a
 * sample of its contents. Returns { keepIntact, isApplication, category, name }.
 * Defaults to "don't keep intact" on any failure, so a missing/broken LLM never locks
 * a folder.
 */
async function classifyFolderWithLLM({ name, relPath, entryNames = [], url = DEFAULT_URL, model = DEFAULT_MODEL }) {
  const system_prompt =
    `You decide whether a folder is a self-contained UNIT whose files must stay together ` +
    `(splitting them would break it or destroy its meaning): an installed/portable app, browser, ` +
    `emulator, game, SDK/runtime, an on-disk database, a saved web page, a machine-learning model ` +
    `repository, or a dataset. A folder of ordinary loose documents, photos, music or videos is NOT one. ` +
    `Reply with ONLY a JSON object, no markdown fences: ` +
    `{"keepIntact": true/false, "category": "<one lowercase word: applications|databases|web_pages|models|datasets|game|or your own>", "name": "<clean name or empty>"}.`;
  const input =
    `Folder name: "${name}"\nPath: "${relPath || name}"\nContains: ${entryNames.slice(0, 40).join(', ')}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, system_prompt, input }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { keepIntact: false, isApplication: false };
    const data = await res.json().catch(() => null);
    const raw = stripFences(extractText(data));
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const yes = /\b(yes|true|keep|application|database|website|model)\b/i.test(raw);
      return { keepIntact: yes, isApplication: yes, category: 'applications' };
    }
    const keep = parsed.keepIntact === true || parsed.isApplication === true || /^(yes|true)$/i.test(String(parsed.keepIntact));
    const category = normalizeCategory(parsed.category) || 'applications';
    return {
      keepIntact: keep,
      isApplication: keep && category === 'applications',
      category,
      name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
    };
  } catch {
    return { keepIntact: false, isApplication: false };
  }
}

/**
 * FINAL POLISH PASS. Re-sends the ENTIRE categorized file list back to the LLM in
 * batches so it can review its own (and the fast heuristics') work with full context -
 * name + folder path + the category currently assigned - and correct any mistakes,
 * inventing better categories where the built-ins don't fit. Returns a map of
 * fileId -> corrected category (only entries the model actually changed).
 *
 * files: [{ id, name, relPath, category }]. onProgress(done, total) is optional.
 */
async function polishCategoriesWithLLM({ files, url = DEFAULT_URL, model = DEFAULT_MODEL, batchSize = 60, onProgress }) {
  if (!files || files.length === 0) return {};
  const categories = knownCategories();
  const system_prompt =
    `You are reviewing an automatic file categorization for mistakes. For EACH file you are ` +
    `given its name, its folder path, and the category currently assigned. Return the BEST ` +
    `lowercase category for each file: keep the current one if it is already right, otherwise ` +
    `fix it. Prefer these when they fit: ${categories.join(', ')}. If none fits, invent a short, ` +
    `sensible lowercase category (one or two words, use _ for spaces). Use the folder path as a ` +
    `strong hint (e.g. files inside a "..._files" website-dump folder, a database folder, or a ` +
    `model folder). Reply with ONLY a JSON object mapping each file id to its category, no prose, ` +
    `no markdown fences.`;

  const corrections = {};
  let done = 0;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const lines = batch.map((f) => `${f.id}\t${f.name}\t${f.relPath || ''}\t[${f.category}]`);
    const input = `id\tname\tpath\tcurrent_category\n${lines.join('\n')}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, system_prompt, input }),
        signal: AbortSignal.timeout(45000),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const parsed = JSON.parse(stripFences(extractText(data)));
        for (const [id, cat] of Object.entries(parsed)) {
          const normalized = normalizeCategory(cat);
          if (normalized) corrections[id] = normalized;
        }
      }
    } catch {
      // a failed batch just leaves those files at their pre-polish category
    }
    done += batch.length;
    if (onProgress) onProgress(done, files.length);
  }
  return corrections;
}

module.exports = {
  classifyWithLLM,
  classifyBatchWithLLM,
  classifyFolderWithLLM,
  polishCategoriesWithLLM,
  normalizeCategory,
  testConnection,
  DEFAULT_URL,
  DEFAULT_MODEL,
};
