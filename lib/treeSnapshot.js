'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// A snapshot of a big folder structure can easily exceed what a single JSON file
// can be opened/parsed as (hundreds of MB). So we stream entries into a series of
// bounded CHUNK files and write a small INDEX file that lists them. The index is
// self-describing (`chunked: true`, plus the ordered chunk list), so the reader
// can stitch the chunks back into one logical JSON array without ever holding the
// whole tree in memory.
const DEFAULT_MAX_ENTRIES_PER_CHUNK = 50000;
const DEFAULT_MAX_BYTES_PER_CHUNK = 64 * 1024 * 1024; // 64 MB

/** Writes a chunk of text, honoring backpressure and rejecting if the stream errors. */
function writeRaw(stream, text) {
  return new Promise((resolve, reject) => {
    if (stream.write(text)) return resolve();
    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (err) => { cleanup(); reject(err); };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
}

function chunkFileName(indexFile, n) {
  const base = path.basename(indexFile).replace(/\.json$/i, '');
  return `${base}.part${n}.json`;
}

/**
 * Recursively snapshots one or more root folders into chunked JSON files plus a
 * self-describing index at `indexFile`. Streams to disk, so memory stays bounded
 * regardless of tree size. Throws (loudly, never silently truncating) on any
 * write error. Returns { fileCount, dirCount, totalBytes, chunks }.
 */
async function snapshotTreesToFile(roots, indexFile, opts = {}) {
  const maxEntries = opts.maxEntriesPerChunk || DEFAULT_MAX_ENTRIES_PER_CHUNK;
  const maxBytes = opts.maxBytesPerChunk || DEFAULT_MAX_BYTES_PER_CHUNK;
  const dir = path.dirname(indexFile);
  await fsp.mkdir(dir, { recursive: true });

  const chunks = [];
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;

  let stream = null;
  let streamError = null;
  let entriesInChunk = 0;
  let bytesInChunk = 0;
  let firstInChunk = true;

  async function closeChunk() {
    if (!stream) return;
    await writeRaw(stream, '\n]\n');
    await endStream(stream);
    stream = null;
  }

  async function openChunk() {
    const name = chunkFileName(indexFile, chunks.length);
    stream = fs.createWriteStream(path.join(dir, name), { encoding: 'utf8' });
    streamError = null;
    stream.on('error', (err) => { streamError = err; });
    await writeRaw(stream, '[\n');
    chunks.push(name);
    entriesInChunk = 0;
    bytesInChunk = 0;
    firstInChunk = true;
  }

  async function writeEntry(entry) {
    if (streamError) throw streamError;
    if (!stream || entriesInChunk >= maxEntries || bytesInChunk >= maxBytes) {
      await closeChunk();
      await openChunk();
    }
    const text = JSON.stringify(entry);
    await writeRaw(stream, (firstInChunk ? '' : ',\n') + text);
    firstInChunk = false;
    entriesInChunk += 1;
    bytesInChunk += text.length + 2;
  }

  async function recurse(root, current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (err) {
      await writeEntry({ path: current, type: 'unreadable', error: err.message });
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        dirCount += 1;
        await writeEntry({ path: full, relPath: path.relative(root, full), type: 'dir' });
        await recurse(root, full);
      } else if (entry.isFile()) {
        let size = null;
        let mtime = null;
        try {
          const stat = await fsp.stat(full);
          size = stat.size;
          mtime = stat.mtimeMs;
          totalBytes += size;
        } catch {
          // unreadable file - still record that it existed
        }
        fileCount += 1;
        await writeEntry({ path: full, relPath: path.relative(root, full), type: 'file', size, mtime });
      }
    }
  }

  try {
    await openChunk();
    for (const root of roots) {
      let exists = true;
      try {
        await fsp.access(root);
      } catch {
        exists = false;
      }
      await writeEntry({ path: root, relPath: '.', type: 'root', exists });
      if (exists) await recurse(root, root);
    }
    await closeChunk();
  } catch (err) {
    if (stream) stream.destroy();
    throw err;
  }

  const index = {
    chunked: true,
    version: 1,
    createdAt: Date.now(),
    roots,
    chunks,
    fileCount,
    dirCount,
    totalBytes,
  };
  await fsp.writeFile(indexFile, JSON.stringify(index, null, 2));

  return { fileCount, dirCount, totalBytes, chunks: chunks.length };
}

/** Parses the index (or a legacy single-array snapshot). Returns { chunked, chunks, ... } or null. */
async function readIndex(indexFile) {
  let raw;
  try {
    raw = await fsp.readFile(indexFile, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.chunked && Array.isArray(parsed.chunks)) return parsed;
    if (Array.isArray(parsed)) return { legacy: true, entries: parsed };
  } catch {
    // fall through
  }
  return null;
}

/**
 * Reads a whole snapshot back into a single array of entries, transparently
 * stitching chunk files. Fine for tests and small/medium snapshots; the serving
 * path uses streamSnapshot instead so it never buffers the whole thing.
 */
async function readAllEntries(indexFile) {
  const index = await readIndex(indexFile);
  if (!index) return null;
  if (index.legacy) return index.entries;
  const dir = path.dirname(indexFile);
  const out = [];
  for (const name of index.chunks) {
    const raw = await fsp.readFile(path.join(dir, name), 'utf8');
    const arr = JSON.parse(raw);
    for (const e of arr) out.push(e);
  }
  return out;
}

/**
 * Streams the snapshot back to an HTTP response as ONE logical JSON array,
 * reading at most one chunk file into memory at a time. Returns false if there's
 * no snapshot to serve. Reconstructs identical output whether stored as a single
 * legacy file or as chunks - the caller/browser sees a single JSON tree.
 */
async function streamSnapshot(indexFile, res) {
  const index = await readIndex(indexFile);
  if (!index) return false;
  if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');

  if (index.legacy) {
    res.end(JSON.stringify(index.entries));
    return true;
  }

  const dir = path.dirname(indexFile);
  res.write('[\n');
  let first = true;
  for (const name of index.chunks) {
    let content;
    try {
      content = await fsp.readFile(path.join(dir, name), 'utf8');
    } catch {
      continue; // a missing chunk shouldn't abort the rest
    }
    const inner = content.trim().replace(/^\[\s*/, '').replace(/\s*\]\s*$/, '').trim();
    if (inner) {
      res.write((first ? '' : ',\n') + inner);
      first = false;
    }
  }
  res.write('\n]\n');
  res.end();
  return true;
}

module.exports = { snapshotTreesToFile, readAllEntries, streamSnapshot, readIndex };
