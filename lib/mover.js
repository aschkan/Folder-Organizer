'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PROJECT_CATEGORY = 'coded_programs';

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Reserves a collision-free path inside destDir, accounting BOTH for what's on disk
 *  and for paths already reserved earlier in this same plan (so two files planned for
 *  the same name don't both resolve to it before either has actually moved). */
async function reserveDestPath(destDir, desiredName, reserved) {
  let candidate = path.join(destDir, desiredName);
  if (!reserved.has(candidate) && !(await pathExists(candidate))) {
    reserved.add(candidate);
    return candidate;
  }
  const ext = path.extname(desiredName);
  const base = desiredName.slice(0, desiredName.length - ext.length);
  let counter = 1;
  while (true) {
    candidate = path.join(destDir, `${base}_${counter}${ext}`);
    if (!reserved.has(candidate) && !(await pathExists(candidate))) {
      reserved.add(candidate);
      return candidate;
    }
    counter += 1;
  }
}

async function moveFile(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(src, dest);
      await fsp.unlink(src);
    } else {
      throw err;
    }
  }
}

async function moveDirectory(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.cp(src, dest, { recursive: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

async function deletePath(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

/**
 * PURE-ish PLANNING PASS. Turns a reviewed job into an ordered, fully-resolved list
 * of filesystem operations WITHOUT executing any of them. Destination paths (incl.
 * collision numbering) are computed here and frozen, which is what makes execution
 * deterministic and safely resumable after a crash. Order matches the load-bearing
 * confirm pipeline: junk -> projects -> duplicates -> loose files -> themed folders last.
 *
 * Op kinds: deleteDir | deleteJunkFile | deleteDupFile | moveFile | moveProject | moveThemed
 */
async function buildPlan(job) {
  const ops = [];
  const reserved = new Set();
  let skippedExcluded = 0;
  let seq = 0;
  const push = (op) => { ops.push({ i: seq++, ...op }); };

  const destDirFor = (file) =>
    file.subPath
      ? path.join(job.destination, file.category, file.subPath)
      : path.join(job.destination, file.category);

  // 1) Standalone junk dirs/files (not inside a detected project).
  for (const dir of job.ignoredNodeModulesDirs || []) push({ kind: 'deleteDir', from: dir });
  for (const dir of job.ignoredJunkDirs || []) push({ kind: 'deleteDir', from: dir });
  for (const file of job.ignoredJunkFiles || []) push({ kind: 'deleteJunkFile', from: file });

  // 2) Detected projects/applications: delete internal junk, then move intact into
  //    their destination category (source projects -> coded_programs, detected
  //    applications -> applications, etc.).
  for (const project of job.projects || []) {
    if (project.excluded) { skippedExcluded += 1; continue; }
    for (const junk of project.junkDirsFound || []) push({ kind: 'deleteDir', from: junk.path });
    const destCategory = project.destCategory || PROJECT_CATEGORY;
    const to = await reserveDestPath(path.join(job.destination, destCategory), project.name, reserved);
    push({ kind: 'moveProject', from: project.absPath, to, projectType: project.type, category: destCategory });
  }

  // Default any undecided duplicate group to "keep all".
  for (const group of job.duplicateGroups.values()) {
    if (!group.resolution) group.resolution = { type: 'keep_all' };
  }

  const handled = new Set();

  // Strays of an EXCLUDED themed folder must stay physically inside the untouched
  // folder - pre-seed them so neither the duplicate nor loose passes can touch them.
  for (const folder of job.themedFolders || []) {
    if (folder.excluded) {
      for (const id of folder.minorityFileIds || []) { handled.add(id); skippedExcluded += 1; }
    }
  }

  // 3) Duplicate groups.
  for (const group of job.duplicateGroups.values()) {
    const files = group.fileIds.map((id) => job.files.get(id)).filter(Boolean);
    if (group.resolution.type === 'merge') {
      const keepId = group.resolution.keepId || files[0]?.id;
      for (const file of files) {
        if (handled.has(file.id)) continue;
        handled.add(file.id);
        if (file.excluded) { skippedExcluded += 1; continue; }
        if (file.id === keepId) {
          const to = await reserveDestPath(destDirFor(file), file.name, reserved);
          push({ kind: 'moveFile', from: file.absPath, to, category: file.category });
        } else {
          push({ kind: 'deleteDupFile', from: file.absPath });
        }
      }
    } else {
      let idx = 1;
      for (const file of files) {
        if (handled.has(file.id)) continue;
        handled.add(file.id);
        if (file.excluded) { skippedExcluded += 1; continue; }
        const ext = path.extname(file.name);
        const base = file.name.slice(0, file.name.length - ext.length);
        const to = await reserveDestPath(destDirFor(file), `${base}_${idx}${ext}`, reserved);
        push({ kind: 'moveFile', from: file.absPath, to, category: file.category });
        idx += 1;
      }
    }
  }

  // 4) All remaining loose files.
  for (const file of job.files.values()) {
    if (handled.has(file.id)) continue;
    handled.add(file.id);
    if (file.excluded) { skippedExcluded += 1; continue; }
    const to = await reserveDestPath(destDirFor(file), file.name, reserved);
    push({ kind: 'moveFile', from: file.absPath, to, category: file.category });
  }

  // 5) Themed folders LAST, once every stray has already been pulled out above.
  for (const folder of job.themedFolders || []) {
    if (folder.excluded) continue;
    const to = await reserveDestPath(path.join(job.destination, folder.dominantCategory), folder.name, reserved);
    push({
      kind: 'moveThemed', from: folder.absPath, to,
      category: folder.dominantCategory, strayCount: (folder.minorityFileIds || []).length,
    });
  }

  return { ops, skippedExcluded, destination: job.destination };
}

function emptyReport(skippedExcluded) {
  return {
    moved: [], projectsMoved: [], themedFoldersMoved: [],
    deleted: [], deletedDirs: [], deletedFiles: [],
    errors: [], skippedExcluded: skippedExcluded || 0,
  };
}

/** Executes a single op. Tolerant of resume: a move whose source is already gone but
 *  whose destination exists is treated as already done rather than an error. */
async function execOp(op) {
  switch (op.kind) {
    case 'deleteDir':
      if (await pathExists(op.from)) await deletePath(op.from);
      return;
    case 'deleteJunkFile':
    case 'deleteDupFile':
      if (await pathExists(op.from)) await fsp.unlink(op.from);
      return;
    case 'moveFile':
      if (!(await pathExists(op.from)) && (await pathExists(op.to))) return;
      await fsp.mkdir(path.dirname(op.to), { recursive: true });
      await moveFile(op.from, op.to);
      return;
    case 'moveProject':
    case 'moveThemed':
      if (!(await pathExists(op.from)) && (await pathExists(op.to))) return;
      await fsp.mkdir(path.dirname(op.to), { recursive: true });
      await moveDirectory(op.from, op.to);
      return;
    default:
      throw new Error(`Unknown op kind: ${op.kind}`);
  }
}

function recordSuccess(report, op) {
  switch (op.kind) {
    case 'deleteDir': report.deletedDirs.push(op.from); break;
    case 'deleteJunkFile': report.deletedFiles.push(op.from); break;
    case 'deleteDupFile': report.deleted.push(op.from); break;
    case 'moveFile': report.moved.push({ from: op.from, to: op.to, category: op.category }); break;
    case 'moveProject':
      report.projectsMoved.push({ from: op.from, to: op.to, type: op.projectType });
      report.moved.push({ from: op.from, to: op.to, category: op.category || PROJECT_CATEGORY });
      break;
    case 'moveThemed':
      report.themedFoldersMoved.push({ from: op.from, to: op.to, category: op.category, strayCount: op.strayCount });
      report.moved.push({ from: op.from, to: op.to, category: op.category });
      break;
  }
}

/**
 * Executes a plan and returns the report. Options:
 *  - journalCompleted: Set<opIndex> already done in a prior (interrupted) attempt - skipped here.
 *  - appendJournal(entry): persist each op outcome durably as it happens (for crash resume).
 *  - onProgress(processed, total, op): progress callback for the live UI.
 */
async function executePlan(plan, opts = {}) {
  const { journalCompleted, appendJournal, onProgress } = opts;
  const report = emptyReport(plan.skippedExcluded);
  const done = journalCompleted || new Set();
  const total = plan.ops.length;
  let processed = 0;

  for (const op of plan.ops) {
    if (done.has(op.i)) {
      recordSuccess(report, op); // already applied in a previous attempt
      processed += 1;
      if (onProgress) onProgress(processed, total, op);
      continue;
    }
    try {
      await execOp(op);
      if (appendJournal) await appendJournal({ i: op.i, status: 'done' });
      recordSuccess(report, op);
    } catch (err) {
      if (appendJournal) await appendJournal({ i: op.i, status: 'error', error: err.message });
      report.errors.push({ file: op.from, error: err.message });
    }
    processed += 1;
    if (onProgress) onProgress(processed, total, op);
  }

  return report;
}

/**
 * Convenience one-shot: plan + execute with no journaling. Behaviourally identical
 * to the original confirmJob, kept for callers/tests that don't need durability.
 */
async function confirmJob(job) {
  const plan = await buildPlan(job);
  return executePlan(plan);
}

/**
 * Reverses a completed run using its saved manifest. Only "moved" entries (files AND
 * folders) can be restored - anything deleted (merged duplicates, junk cleanup) is
 * permanently gone. Never reports a move as restored unless it actually put the item
 * back at its original location.
 */
async function undoRun(manifest) {
  const result = { restored: [], errors: [], notRestorable: [] };
  const moved = manifest.report?.moved || [];

  // reverse order, in case later moves created the destination folders earlier ones depend on
  for (let i = moved.length - 1; i >= 0; i--) {
    const { from, to } = moved[i];
    try {
      if (!(await pathExists(to))) {
        result.notRestorable.push({ from, to, reason: 'Moved file no longer exists at destination' });
        continue;
      }
      if (await pathExists(from)) {
        result.notRestorable.push({ from, to, reason: 'Original location is occupied again' });
        continue;
      }
      await fsp.mkdir(path.dirname(from), { recursive: true });
      const stat = await fsp.stat(to);
      if (stat.isDirectory()) {
        await moveDirectory(to, from);
      } else {
        await moveFile(to, from);
      }
      result.restored.push({ from: to, to: from });
    } catch (err) {
      result.errors.push({ file: to, error: err.message });
    }
  }

  const deletedCount =
    (manifest.report?.deleted?.length || 0) +
    (manifest.report?.deletedDirs?.length || 0) +
    (manifest.report?.deletedFiles?.length || 0);
  if (deletedCount > 0) {
    result.permanentlyLostCount = deletedCount;
  }

  return result;
}

module.exports = { buildPlan, executePlan, confirmJob, undoRun, PROJECT_CATEGORY };
