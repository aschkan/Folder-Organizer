'use strict';

const { knownCategories, OTHERS } = require('./categorize');

const DEFAULT_URL = 'http://localhost:1234/api/v1/chat';
const DEFAULT_MODEL = 'gemma-3-4b-it';
const DEFAULT_PROVIDER = 'custom';

// Local LLM backends we can talk to. `style` selects the request/response shape;
// `path` is appended when the user gives only a base URL (host:port). Everything runs
// locally - which backend actually uses CPU vs GPU is configured in that backend
// (e.g. Ollama/LM Studio settings), not here; this app just sends HTTP requests.
const PROVIDERS = {
  lmstudio: { style: 'openai', path: '/v1/chat/completions', defaultUrl: 'http://localhost:1234' },
  ollama:   { style: 'ollama', path: '/api/chat',            defaultUrl: 'http://localhost:11434' },
  openai:   { style: 'openai', path: '/v1/chat/completions', defaultUrl: 'http://localhost:8080' }, // AirLLM & other OpenAI-compatible servers
  custom:   { style: 'custom', path: '/api/v1/chat',         defaultUrl: 'http://localhost:1234/api/v1/chat' },
};

const KNOWN_ENDPOINT_SUFFIXES = [
  '/v1/chat/completions', '/chat/completions', '/completions',
  '/api/chat', '/api/generate', '/api/v1/chat',
];

function providerConfig(provider) {
  return PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
}

/** Turns a base URL or full endpoint into the exact URL to POST to for this provider. */
function resolveEndpoint(url, provider) {
  const p = providerConfig(provider);
  const u = (url || p.defaultUrl).replace(/\/+$/, '');
  if (KNOWN_ENDPOINT_SUFFIXES.some((s) => u.endsWith(s))) return u;
  return u + p.path;
}

/** Builds the provider-specific request body for a system+user chat turn. */
function buildBody(provider, model, system, user) {
  const style = providerConfig(provider).style;
  if (style === 'openai') {
    return { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, stream: false };
  }
  if (style === 'ollama') {
    return { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false, options: { temperature: 0 } };
  }
  // custom: the simple { model, system_prompt, input } shape (LM-Studio-style proxy)
  return { model, system_prompt: system, input: user };
}

/**
 * Pulls a plausible text answer out of an arbitrary LLM response JSON shape,
 * covering OpenAI (choices[].message.content), Ollama (message.content), and the
 * custom proxy shapes - since the local API's exact format isn't guaranteed.
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

/** Normalizes a config that may arrive as { provider, url, model } or a legacy { url, model }. */
function normalizeCfg(cfg = {}) {
  return {
    provider: cfg.provider || DEFAULT_PROVIDER,
    url: cfg.url || undefined,
    model: cfg.model || DEFAULT_MODEL,
  };
}

/** One system+user chat turn against the configured local backend. Returns the raw text, or null on failure. */
async function chat(cfg, system, user, timeoutMs = 30000) {
  const { provider, url, model } = normalizeCfg(cfg);
  try {
    const res = await fetch(resolveEndpoint(url, provider), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(provider, model, system, user)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return extractText(data);
  } catch {
    return null;
  }
}

function stripFences(text) {
  return String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
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

function firstJson(text, open, close) {
  const raw = stripFences(text);
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  return JSON.parse(raw.slice(start, end + 1));
}

async function testConnection(cfg) {
  try {
    const text = await chat(cfg, 'Reply with only the single word: OK', 'ping', 8000);
    if (text === null) return { ok: false, error: 'No response (check the URL, that the server is running, and the model name)' };
    return { ok: true, sample: text || '(empty reply)' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Asks the local LLM to pick a category for a file it couldn't classify by extension.
 * Falls back to "others" on any failure or if the answer doesn't match a known category.
 */
async function classifyWithLLM({ filename, ext, ...cfg }) {
  const categories = knownCategories().filter((c) => c !== OTHERS);
  const system =
    `You classify files into exactly one category by their filename and extension. ` +
    `Valid categories: ${categories.join(', ')}, ${OTHERS}. ` +
    `Reply with ONLY the category word, nothing else, no punctuation, no explanation.`;
  const user = `Filename: "${filename}"  Extension: "${ext || '(none)'}"`;
  const text = await chat(cfg, system, user, 15000);
  if (text === null) return OTHERS;
  const raw = text.toLowerCase();
  const found = categories.find((c) => raw.includes(c.replace(/_/g, ' ')) || raw.includes(c));
  return found || OTHERS;
}

/**
 * Classifies unknown file types in a single call, WITH context (a sample filename and
 * its path), and may invent new categories. Returns a map ext -> category.
 */
async function classifyBatchWithLLM({ items, ...cfg }) {
  if (!items || items.length === 0) return {};
  const categories = knownCategories().filter((c) => c !== OTHERS);
  const system =
    `You classify files into a single lowercase category based on their name, extension and folder path. ` +
    `Prefer one of these existing categories when it fits: ${categories.join(', ')}, ${OTHERS}. ` +
    `If none fits, invent a short, sensible lowercase category (one or two words, use _ for spaces). ` +
    `Reply with ONLY a JSON object mapping each extension to one category, no explanation, no markdown fences. ` +
    `Example: {"insv": "video", "sqlite": "databases"}`;
  const user = `Files:\n${items.map((it) => `.${it.ext}${it.example ? ` e.g. "${it.example}"` : ''}${it.samplePath ? ` in "${it.samplePath}"` : ''}`).join('\n')}`;
  const text = await chat(cfg, system, user, 30000);
  if (text === null) return {};
  try {
    const parsed = firstJson(text, '{', '}');
    const result = {};
    for (const [ext, cat] of Object.entries(parsed || {})) {
      const normalized = normalizeCategory(cat);
      if (normalized) result[ext.toLowerCase()] = normalized;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Asks the LLM whether a folder is a self-contained UNIT to keep intact (app, database,
 * saved web page, model repo, dataset, …). Returns { keepIntact, isApplication, category, name }.
 */
async function classifyFolderWithLLM({ name, relPath, entryNames = [], ...cfg }) {
  const system =
    `You decide whether a folder is a self-contained UNIT whose files must stay together ` +
    `(splitting them would break it or destroy its meaning): an installed/portable app, browser, ` +
    `emulator, game, SDK/runtime, an on-disk database, a saved web page, a machine-learning model ` +
    `repository, or a dataset. A folder of ordinary loose documents, photos, music or videos is NOT one. ` +
    `Reply with ONLY a JSON object, no markdown fences: ` +
    `{"keepIntact": true/false, "category": "<one lowercase word: applications|databases|web_pages|models|datasets|game|or your own>", "name": "<clean name or empty>"}.`;
  const user = `Folder name: "${name}"\nPath: "${relPath || name}"\nContains: ${entryNames.slice(0, 40).join(', ')}`;
  const text = await chat(cfg, system, user, 20000);
  if (text === null) return { keepIntact: false, isApplication: false };
  try {
    const parsed = firstJson(text, '{', '}');
    if (!parsed) {
      const yes = /\b(yes|true|keep|application|database|website|model)\b/i.test(text);
      return { keepIntact: yes, isApplication: yes, category: 'applications' };
    }
    const keep = parsed.keepIntact === true || parsed.isApplication === true || /^(yes|true)$/i.test(String(parsed.keepIntact));
    const category = normalizeCategory(parsed.category) || 'applications';
    return { keepIntact: keep, isApplication: keep && category === 'applications', category, name: typeof parsed.name === 'string' ? parsed.name.trim() : '' };
  } catch {
    return { keepIntact: false, isApplication: false };
  }
}

/**
 * FULL-CONTEXT STRAY DETECTION. Given the COMPLETE file listing of a folder, asks the
 * LLM which files clearly DON'T belong - a personal document/photo accidentally dropped
 * into a program or a collection (e.g. a PDF in a photo album, an invoice inside an app
 * folder). Conservative by design: program resources and on-topic files are never flagged.
 * Returns an array of the exact relative paths that are strays (validated against the input).
 */
async function findFolderStraysWithLLM({ folderName, kind = 'collection', files, ...cfg }) {
  if (!files || files.length === 0) return [];
  const purpose = (kind === 'application' || kind === 'project')
    ? `a single software ${kind} whose files must stay together - its executables, libraries, configs, data, sounds, fonts, localization and other resources ALL belong`
    : `a folder of related files that belong together as a collection`;
  const system =
    `The message is the COMPLETE file listing (one relative path per line) of a folder named "${folderName}", which is ${purpose}. ` +
    `Identify ONLY files that clearly DO NOT belong here - a personal document, photo, video, or unrelated download accidentally saved into this folder ` +
    `(for example a PDF sitting in a photo album, or someone's invoice inside a program folder). ` +
    `Be conservative: if a file could plausibly be part of this folder (ESPECIALLY any program/resource file), do NOT flag it - never risk breaking a program. ` +
    `Reply with ONLY a JSON array of the exact relative paths that are strays, e.g. ["subdir/random.pdf"]. Reply [] if there are none.`;
  const user = files.map((f) => f.relPath).join('\n');
  const text = await chat({ ...cfg }, system, user, 45000);
  if (text === null) return [];
  try {
    const parsed = firstJson(text, '[', ']');
    if (!Array.isArray(parsed)) return [];
    const valid = new Set(files.map((f) => f.relPath));
    return parsed.filter((p) => typeof p === 'string' && valid.has(p));
  } catch {
    return [];
  }
}

/**
 * FINAL POLISH PASS. Re-sends the entire categorized file list back to the LLM in
 * batches so it can review its own (and the heuristics') work with full context and
 * correct mistakes. Returns a map of fileId -> corrected category.
 */
async function polishCategoriesWithLLM({ files, batchSize = 60, onProgress, beforeBatch, ...cfg }) {
  if (!files || files.length === 0) return {};
  const categories = knownCategories();
  const system =
    `You are reviewing an automatic file categorization for mistakes. For EACH file you are ` +
    `given its name, its folder path, and the category currently assigned. Return the BEST ` +
    `lowercase category for each file: keep the current one if it is already right, otherwise ` +
    `fix it. Prefer these when they fit: ${categories.join(', ')}. If none fits, invent a short, ` +
    `sensible lowercase category. Use the folder path as a strong hint. Reply with ONLY a JSON ` +
    `object mapping each file id to its category, no prose, no markdown fences.`;

  const corrections = {};
  let done = 0;
  for (let i = 0; i < files.length; i += batchSize) {
    if (beforeBatch) await beforeBatch(); // e.g. thermal cooldown between batches
    const batch = files.slice(i, i + batchSize);
    const user = `id\tname\tpath\tcurrent_category\n` +
      batch.map((f) => `${f.id}\t${f.name}\t${f.relPath || ''}\t[${f.category}]`).join('\n');
    const text = await chat(cfg, system, user, 45000);
    if (text !== null) {
      try {
        const parsed = firstJson(text, '{', '}');
        for (const [id, cat] of Object.entries(parsed || {})) {
          const normalized = normalizeCategory(cat);
          if (normalized) corrections[id] = normalized;
        }
      } catch {
        // leave this batch unchanged
      }
    }
    done += batch.length;
    if (onProgress) onProgress(done, files.length);
  }
  return corrections;
}

module.exports = {
  chat,
  classifyWithLLM,
  classifyBatchWithLLM,
  classifyFolderWithLLM,
  findFolderStraysWithLLM,
  polishCategoriesWithLLM,
  normalizeCategory,
  resolveEndpoint,
  buildBody,
  testConnection,
  PROVIDERS,
  DEFAULT_URL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
};
