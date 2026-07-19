'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { snapshotTreesToFile, readAllEntries, streamSnapshot, readIndex } = require('../lib/treeSnapshot');

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'fo-snap-'));
}

function collector() {
  let buf = '';
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    write(s) { buf += s; },
    end(s) { if (s) buf += s; },
    get body() { return buf; },
  };
}

test('a large tree is split into multiple chunks but re-reads as one JSON array', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'many');
  await fsp.mkdir(src, { recursive: true });
  for (let i = 0; i < 25; i++) await fsp.writeFile(path.join(src, `f${i}.txt`), `x${i}`);

  const indexFile = path.join(root, 'snap', 'source-tree-before.json');
  // tiny chunk cap forces several chunk files
  const stats = await snapshotTreesToFile([src], indexFile, { maxEntriesPerChunk: 5 });

  const index = await readIndex(indexFile);
  assert.equal(index.chunked, true);
  assert.ok(index.chunks.length > 1, 'should have produced multiple chunk files');
  assert.equal(stats.fileCount, 25);

  // Stitched read returns every entry.
  const entries = await readAllEntries(indexFile);
  const files = entries.filter((e) => e.type === 'file');
  assert.equal(files.length, 25);
  const rootEntry = entries.find((e) => e.type === 'root');
  assert.ok(rootEntry, 'the root marker is preserved');

  // Streamed reconstruction is valid JSON identical in content.
  const res = collector();
  const served = await streamSnapshot(indexFile, res);
  assert.equal(served, true);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.filter((e) => e.type === 'file').length, 25);
  assert.equal(res.headers['Content-Type'], 'application/json');
});

test('streamSnapshot returns false when there is no snapshot', async () => {
  const res = collector();
  const served = await streamSnapshot(path.join(os.tmpdir(), 'does-not-exist-xyz.json'), res);
  assert.equal(served, false);
});

test('an unreadable directory is recorded, not fatal', async () => {
  const root = await tmpRoot();
  const indexFile = path.join(root, 'snap.json');
  const stats = await snapshotTreesToFile([path.join(root, 'missing-root')], indexFile);
  const entries = await readAllEntries(indexFile);
  const rootEntry = entries.find((e) => e.type === 'root');
  assert.equal(rootEntry.exists, false);
  assert.equal(stats.fileCount, 0);
});
