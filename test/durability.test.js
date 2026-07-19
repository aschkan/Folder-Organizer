'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { buildPlan, executePlan } = require('../lib/mover');

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'fo-dur-'));
}

function looseFile(id, name, ext, absPath, category) {
  return { id, name, ext, absPath, category, subPath: null, excluded: false, themedFolderId: null };
}

function baseJob(destination) {
  return {
    destination, files: new Map(), duplicateGroups: new Map(),
    themedFolders: [], projects: [],
    ignoredNodeModulesDirs: [], ignoredJunkDirs: [], ignoredJunkFiles: [],
  };
}

test('a plan resumed from a journal skips already-applied ops and finishes the rest', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(dest, { recursive: true });
  const a = path.join(src, 'a.txt');
  const b = path.join(src, 'b.txt');
  await fsp.writeFile(a, 'A');
  await fsp.writeFile(b, 'B');

  const job = baseJob(dest);
  job.files.set('a', looseFile('a', 'a.txt', 'txt', a, 'documents'));
  job.files.set('b', looseFile('b', 'b.txt', 'txt', b, 'documents'));

  const plan = await buildPlan(job);
  assert.equal(plan.ops.length, 2);

  // Simulate a crash: op 0 was applied and journaled, op 1 never ran.
  const op0 = plan.ops[0];
  await fsp.mkdir(path.dirname(op0.to), { recursive: true });
  await fsp.rename(op0.from, op0.to);

  const journaledDone = new Set([op0.i]);
  const appended = [];
  const report = await executePlan(plan, {
    journalCompleted: journaledDone,
    appendJournal: (e) => { appended.push(e); },
  });

  // Both files end up at the destination; the resumed run recorded both moves.
  assert.equal(report.moved.length, 2, 'report reflects both the pre-applied and the resumed move');
  assert.equal(report.errors.length, 0);
  for (const op of plan.ops) assert.ok(fs.existsSync(op.to), 'every planned file is at its destination');
  // Only the not-yet-done op should have been journaled this pass.
  assert.deepEqual(appended.map((e) => e.i), [plan.ops[1].i]);
});

test('re-running a fully-applied plan is idempotent (no errors, no double move)', async () => {
  const root = await tmpRoot();
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(src, { recursive: true });
  await fsp.mkdir(dest, { recursive: true });
  const a = path.join(src, 'a.txt');
  await fsp.writeFile(a, 'A');

  const job = baseJob(dest);
  job.files.set('a', looseFile('a', 'a.txt', 'txt', a, 'documents'));
  const plan = await buildPlan(job);

  await executePlan(plan);                 // first pass moves the file
  const report = await executePlan(plan);  // second pass: source gone, dest present

  assert.equal(report.errors.length, 0, 'a resumed move whose work is already done must not error');
  assert.equal(report.moved.length, 1);
  assert.ok(fs.existsSync(plan.ops[0].to));
});
