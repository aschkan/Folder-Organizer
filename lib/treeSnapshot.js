'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Writes a chunk, resolving once it is buffered/flushed and REJECTING if the
 * stream errors while we wait. Without the error listener a mid-write failure
 * would either crash the process (unhandled 'error') or hang forever waiting on
 * a 'drain' that never comes.
 */
function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (stream.write(chunk)) return resolve();
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

/**
 * Recursively snapshots one or more root folders into a single JSON array file,
 * streamed to disk so it never holds the whole tree in memory - safe no matter
 * how large the folder structure is. Each entry: { path, relPath, type, size?, mtime? }.
 *
 * Throws if the stream errors at any point, so a corrupt/truncated snapshot is a
 * loud failure the caller can react to, never a silent one.
 */
async function snapshotTreesToFile(roots, outFile) {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const stream = fs.createWriteStream(outFile, { encoding: 'utf8' });
  // Persistent capture so an async error between writes can't become an unhandled
  // 'error' event that crashes the process.
  let streamError = null;
  const captureError = (err) => { streamError = err; };
  stream.on('error', captureError);

  let first = true;
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;

  async function writeEntry(entry) {
    if (streamError) throw streamError;
    await writeChunk(stream, (first ? '' : ',\n') + JSON.stringify(entry));
    first = false;
  }

  async function recurse(root, dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      await writeEntry({ path: dir, type: 'unreadable', error: err.message });
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
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
    await writeChunk(stream, '[\n');
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
    await writeChunk(stream, '\n]\n');
  } catch (err) {
    stream.destroy();
    throw err;
  }

  await new Promise((resolve, reject) => {
    stream.end((err) => (err || streamError ? reject(err || streamError) : resolve()));
  });
  stream.removeListener('error', captureError);

  return { fileCount, dirCount, totalBytes };
}

module.exports = { snapshotTreesToFile };
