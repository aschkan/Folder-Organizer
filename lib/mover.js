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

/** Builds a collision-free path inside destDir for the given desired name (works for files or folders). */
async function uniqueDestPath(destDir, desiredName) {
  let candidate = path.join(destDir, desiredName);
  if (!(await pathExists(candidate))) return candidate;

  const ext = path.extname(desiredName);
  const base = desiredName.slice(0, desiredName.length - ext.length);
  let counter = 1;
  while (true) {
    candidate = path.join(destDir, `${base}_${counter}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
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
 * Executes the plan:
 *  - deletes standalone junk dirs/files (node_modules, build caches, OS junk files)
 *  - for detected projects: deletes their internal junk, then moves the WHOLE
 *    project folder intact into destination/coded_programs/<name>
 *  - resolves duplicate groups (keep_all -> rename+move all, merge -> keep one + delete rest)
 *  - moves every remaining loose file into destination/<category>[/<subPath>]
 * Produces a report used both for the on-screen summary and as the on-disk undo manifest.
 */
async function confirmJob(job) {
  const report = {
    moved: [],           // { from, to, category }
    projectsMoved: [],   // { from, to, type }
    themedFoldersMoved: [], // { from, to, category, strayCount }
    deleted: [],          // duplicate files removed via "merge"
    deletedDirs: [],      // node_modules / build-cache dirs removed (standalone + inside projects)
    deletedFiles: [],     // OS junk files removed (.DS_Store etc.)
    errors: [],
    skippedExcluded: 0,
  };

  // Standalone junk dirs/files (not inside a detected project)
  for (const dir of job.ignoredNodeModulesDirs || []) {
    try {
      await deletePath(dir);
      report.deletedDirs.push(dir);
    } catch (err) {
      report.errors.push({ file: dir, error: err.message });
    }
  }
  for (const dir of job.ignoredJunkDirs || []) {
    try {
      await deletePath(dir);
      report.deletedDirs.push(dir);
    } catch (err) {
      report.errors.push({ file: dir, error: err.message });
    }
  }
  for (const file of job.ignoredJunkFiles || []) {
    try {
      await fsp.unlink(file);
      report.deletedFiles.push(file);
    } catch (err) {
      report.errors.push({ file, error: err.message });
    }
  }

  // Detected projects: clean internal junk, then move the folder intact
  for (const project of job.projects || []) {
    if (project.excluded) {
      report.skippedExcluded += 1;
      continue;
    }
    try {
      for (const junk of project.junkDirsFound || []) {
        try {
          await deletePath(junk.path);
          report.deletedDirs.push(junk.path);
        } catch (err) {
          report.errors.push({ file: junk.path, error: err.message });
        }
      }
      const destDir = path.join(job.destination, PROJECT_CATEGORY);
      await fsp.mkdir(destDir, { recursive: true });
      const destPath = await uniqueDestPath(destDir, project.name);
      await moveDirectory(project.absPath, destPath);
      report.projectsMoved.push({ from: project.absPath, to: destPath, type: project.type });
      report.moved.push({ from: project.absPath, to: destPath, category: PROJECT_CATEGORY });
    } catch (err) {
      report.errors.push({ file: project.absPath, error: err.message });
    }
  }

  // Resolve default for any duplicate groups the user never explicitly decided on.
  for (const group of job.duplicateGroups.values()) {
    if (!group.resolution) group.resolution = { type: 'keep_all' };
  }

  const handledFileIds = new Set();

  // Themed folders the user chose to leave alone: their stray files must NOT get
  // individually pulled out by the duplicate/loose-file passes below - the whole
  // original folder (majority + strays, untouched) stays exactly where it was.
  for (const folder of job.themedFolders || []) {
    if (folder.excluded) {
      for (const id of folder.minorityFileIds || []) {
        handledFileIds.add(id);
        report.skippedExcluded += 1;
      }
    }
  }

  function destDirFor(file) {
    return file.subPath ? path.join(job.destination, file.category, file.subPath) : path.join(job.destination, file.category);
  }

  for (const group of job.duplicateGroups.values()) {
    const files = group.fileIds.map((id) => job.files.get(id)).filter(Boolean);

    if (group.resolution.type === 'merge') {
      const keepId = group.resolution.keepId || files[0]?.id;
      for (const file of files) {
        handledFileIds.add(file.id);
        if (file.excluded) {
          report.skippedExcluded += 1;
          continue;
        }
        if (file.id === keepId) {
          try {
            const destDir = destDirFor(file);
            await fsp.mkdir(destDir, { recursive: true });
            const destPath = await uniqueDestPath(destDir, file.name);
            await moveFile(file.absPath, destPath);
            report.moved.push({ from: file.absPath, to: destPath, category: file.category });
          } catch (err) {
            report.errors.push({ file: file.absPath, error: err.message });
          }
        } else {
          try {
            await fsp.unlink(file.absPath);
            report.deleted.push(file.absPath);
          } catch (err) {
            report.errors.push({ file: file.absPath, error: err.message });
          }
        }
      }
    } else {
      let idx = 1;
      for (const file of files) {
        handledFileIds.add(file.id);
        if (file.excluded) {
          report.skippedExcluded += 1;
          continue;
        }
        try {
          const destDir = destDirFor(file);
          await fsp.mkdir(destDir, { recursive: true });
          const ext = path.extname(file.name);
          const base = file.name.slice(0, file.name.length - ext.length);
          const numberedName = `${base}_${idx}${ext}`;
          const destPath = await uniqueDestPath(destDir, numberedName);
          await moveFile(file.absPath, destPath);
          report.moved.push({ from: file.absPath, to: destPath, category: file.category });
          idx += 1;
        } catch (err) {
          report.errors.push({ file: file.absPath, error: err.message });
        }
      }
    }
  }

  for (const file of job.files.values()) {
    if (handledFileIds.has(file.id)) continue;
    if (file.excluded) {
      report.skippedExcluded += 1;
      continue;
    }
    try {
      const destDir = destDirFor(file);
      await fsp.mkdir(destDir, { recursive: true });
      const destPath = await uniqueDestPath(destDir, file.name);
      await moveFile(file.absPath, destPath);
      report.moved.push({ from: file.absPath, to: destPath, category: file.category });
    } catch (err) {
      report.errors.push({ file: file.absPath, error: err.message });
    }
  }

  // Themed folders move LAST, after every stray file inside them has already been
  // pulled out above (via the duplicate/loose-file passes) - by now each folder
  // contains only its dominant-category files, so moving it as one unit is safe.
  for (const folder of job.themedFolders || []) {
    if (folder.excluded) continue; // already accounted for in skippedExcluded above
    try {
      const destDir = path.join(job.destination, folder.dominantCategory);
      await fsp.mkdir(destDir, { recursive: true });
      const destPath = await uniqueDestPath(destDir, folder.name);
      await moveDirectory(folder.absPath, destPath);
      report.themedFoldersMoved.push({
        from: folder.absPath,
        to: destPath,
        category: folder.dominantCategory,
        strayCount: (folder.minorityFileIds || []).length,
      });
      report.moved.push({ from: folder.absPath, to: destPath, category: folder.dominantCategory });
    } catch (err) {
      report.errors.push({ file: folder.absPath, error: err.message });
    }
  }

  return report;
}

/**
 * Reverses a completed run using its saved manifest. Only "moved" entries (files AND
 * projects) can be restored - anything that was deleted (duplicates merged away,
 * node_modules/junk cleanup) is permanently gone and cannot be undone.
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

module.exports = { confirmJob, undoRun, PROJECT_CATEGORY };
