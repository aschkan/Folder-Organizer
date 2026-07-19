'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

async function writeEntry(stream, entry, first) {
  const chunk = (first ? '' : ',\n') + JSON.stringify(entry);
  if (!stream.write(chunk)) {
    await new Promise((resolve) => stream.once('drain', resolve));
  }
}

/**
 * Recursively snapshots one or more root folders into a single JSON array file,
 * streamed to disk so it never holds the whole tree in memory - safe no matter
 * how large the folder structure is. Each entry: { path, relPath, type, size?, mtime? }.
 */
async function snapshotTreesToFile(roots, outFile) {
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const stream = fs.createWriteStream(outFile, { encoding: 'utf8' });
  stream.write('[\n');
  let first = true;
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;

  async function recurse(root, dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      await writeEntry(stream, { path: dir, type: 'unreadable', error: err.message }, first);
      first = false;
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirCount += 1;
        await writeEntry(stream, { path: full, relPath: path.relative(root, full), type: 'dir' }, first);
        first = false;
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
        await writeEntry(stream, { path: full, relPath: path.relative(root, full), type: 'file', size, mtime }, first);
        first = false;
      }
    }
  }

  for (const root of roots) {
    let exists = true;
    try {
      await fsp.access(root);
    } catch {
      exists = false;
    }
    await writeEntry(stream, { path: root, relPath: '.', type: 'root', exists }, first);
    first = false;
    if (exists) await recurse(root, root);
  }

  stream.write('\n]\n');
  await new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });

  return { fileCount, dirCount, totalBytes };
}

module.exports = { snapshotTreesToFile };
