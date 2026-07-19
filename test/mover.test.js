'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { confirmJob, undoRun } = require('../lib/mover');

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'fo-test-'));
}

function looseFile(id, name, ext, absPath, category) {
  return {
    id, name, ext, absPath, category,
    subPath: null, excluded: false,
    duplicateGroupId: null, similarGroupId: null, themedFolderId: null,
  };
}

function baseJob(destination) {
  return {
    destination,
    files: new Map(),
    duplicateGroups: new Map(),
    themedFolders: [],
    projects: [],
    ignoredNodeModulesDirs: [],
    ignoredJunkDirs: [],
    ignoredJunkFiles: [],
  };
}

// Regression guard for the exclude-guarantee bug: an EXCLUDED themed folder must
// stay completely intact, even when one of its stray files is an exact duplicate
// of a loose file elsewhere (which previously caused the stray to be moved out).
test('excluded themed folder keeps its stray even when the stray is a duplicate', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'src');
  const themed = path.join(src, '2026 Birthday Photos');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(themed, { recursive: true });
  await fsp.mkdir(path.join(src, 'other'), { recursive: true });
  await fsp.mkdir(dest, { recursive: true });

  await fsp.writeFile(path.join(themed, 'a.jpg'), 'image-a');
  await fsp.writeFile(path.join(themed, 'b.jpg'), 'image-b');
  const strayPath = path.join(themed, 'note.pdf');
  const loosePath = path.join(src, 'other', 'copy.pdf');
  await fsp.writeFile(strayPath, 'IDENTICAL BYTES');
  await fsp.writeFile(loosePath, 'IDENTICAL BYTES');

  const job = baseJob(dest);
  job.files.set('m', { ...looseFile('m', 'note.pdf', 'pdf', strayPath, 'documents'), themedFolderId: 'T' });
  job.files.set('l', looseFile('l', 'copy.pdf', 'pdf', loosePath, 'documents'));
  job.duplicateGroups.set('g', { id: 'g', fileIds: ['m', 'l'], resolution: { type: 'keep_all' } });
  job.themedFolders = [{
    id: 'T', name: '2026 Birthday Photos', absPath: themed,
    dominantCategory: 'images', minorityFileIds: ['m'], excluded: true,
  }];

  const report = await confirmJob(job);

  assert.ok(fs.existsSync(strayPath), 'stray inside the excluded folder must not be moved out');
  assert.ok(fs.existsSync(themed), 'the excluded themed folder itself must stay in place');
  assert.ok(!fs.existsSync(loosePath), 'the loose duplicate elsewhere should still be organized');
  assert.equal(report.moved.some((m) => m.from === strayPath), false, 'stray must not appear in the move plan');
});

// The mirror case: a NON-excluded themed folder should still extract its stray
// and move the (now stray-free) folder as an intact unit.
test('non-excluded themed folder extracts its stray and moves the folder intact', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'src');
  const themed = path.join(src, 'Trip 2025');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(themed, { recursive: true });
  await fsp.mkdir(dest, { recursive: true });

  await fsp.writeFile(path.join(themed, 'a.jpg'), 'image-a');
  await fsp.writeFile(path.join(themed, 'b.jpg'), 'image-b');
  const strayPath = path.join(themed, 'receipt.pdf');
  await fsp.writeFile(strayPath, 'a receipt');

  const job = baseJob(dest);
  job.files.set('m', { ...looseFile('m', 'receipt.pdf', 'pdf', strayPath, 'documents'), themedFolderId: 'T' });
  job.themedFolders = [{
    id: 'T', name: 'Trip 2025', absPath: themed,
    dominantCategory: 'images', minorityFileIds: ['m'], excluded: false,
  }];

  await confirmJob(job);

  assert.ok(!fs.existsSync(strayPath), 'the stray should have been extracted out of the folder');
  assert.ok(fs.existsSync(path.join(dest, 'documents', 'receipt.pdf')), 'stray lands in its real category');
  assert.ok(fs.existsSync(path.join(dest, 'images', 'Trip 2025')), 'folder moves intact under its dominant category');
  assert.ok(fs.existsSync(path.join(dest, 'images', 'Trip 2025', 'a.jpg')), 'folder contents preserved');
});

test('undo restores moved loose files to their exact origin', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(dest, { recursive: true });
  const origPath = path.join(src, 'song.mp3');
  await fsp.writeFile(origPath, 'audio');

  const job = baseJob(dest);
  job.files.set('f', looseFile('f', 'song.mp3', 'mp3', origPath, 'music'));

  const report = await confirmJob(job);
  assert.ok(!fs.existsSync(origPath), 'file left its source after the move');

  const result = await undoRun({ report });
  assert.ok(fs.existsSync(origPath), 'undo restored the file to its origin');
  assert.equal(result.errors.length, 0);
  assert.equal(result.notRestorable.length, 0);
  assert.equal(result.restored.length, 1);
});

test('undo reports notRestorable (never a false "restored") when the origin is reoccupied', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(dest, { recursive: true });
  const origPath = path.join(src, 'doc.txt');
  await fsp.writeFile(origPath, 'v1');

  const job = baseJob(dest);
  job.files.set('f', looseFile('f', 'doc.txt', 'txt', origPath, 'documents'));
  const report = await confirmJob(job);

  // Something new appears at the original location before the user undoes.
  await fsp.writeFile(origPath, 'v2-new-file');

  const result = await undoRun({ report });
  assert.equal(result.restored.length, 0, 'must not claim to have restored over an occupied origin');
  assert.equal(result.notRestorable.length, 1);
  assert.match(result.notRestorable[0].reason, /occupied/i);
});
