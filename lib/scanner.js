'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { categorizeByExtension, getExtension, OTHERS } = require('./categorize');
const { classifyWithLLM, classifyBatchWithLLM, classifyFolderWithLLM, polishCategoriesWithLLM } = require('./llm');
const {
  detectProjectMarker, detectApplicationFolder, detectDatabaseFolder,
  detectSavedWebpageFolder, matchesNativeExeMagic, sampleEntryNames, PROJECT_JUNK_DIRS,
} = require('./projectDetect');
const { getRuleForExt } = require('./learnedRules');
const { getPhotoDateSubpath, getMusicTagSubpath } = require('./metadata');
const { isPerceptuallyHashable, computeDHash, groupBySimilarity } = require('./perceptualHash');
const { logJob } = require('./jobLog');

// Directories we never traverse or move, even though the user asked for hidden
// folders to be scanned in general: these are version-control internals and OS
// system/trash folders where "organizing" the contents is never what a user wants.
// Everything else that starts with a dot (.config, .aws, a folder literally named
// ".MyStuff", etc.) IS now scanned and categorized like any other folder.
const ALWAYS_SKIP_DIR_NAMES = new Set([
  '.git', '.svn', '.hg', '.bzr',
  '.Trash', '.Trashes', '.TemporaryItems', '.Spotlight-V100', '.fseventsd',
  '$RECYCLE.BIN', 'System Volume Information',
]);
const JUNK_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.directory']);

// A folder qualifies as a "themed" human-organized collection (e.g. "2026 Birthday
// Photos") if it has at least this many files and one category dominates by at
// least this ratio. Everything else inside it gets extracted and sorted normally;
// the folder itself (now just the dominant-category files) moves as one unit.
const MIN_THEMED_FILES = 3;
const THEMED_MIN_RATIO = 0.6;

let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Recursively inspects a folder (without touching disk state) to decide whether it's
 * a human-organized "themed" collection: mostly one category, with a few stray
 * misplaced files. Disqualifies itself if it contains a nested code project anywhere
 * (that stays under normal project-detection handling instead). Categories here are
 * extension/learned-rule based only (fast, synchronous-ish) - final categorization
 * for extracted stray files still goes through the full pipeline (incl. LLM) later.
 */
async function evaluateThemedFolder(dirPath, opts) {
  const allFiles = [];
  let disqualified = false;

  async function recurse(dir) {
    if (disqualified) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (opts.detectProjects && detectProjectMarker(entries)) {
      disqualified = true; // a nested code project lives here - let normal walk handle it
      return;
    }
    // A nested intact unit (application, database, saved web page) would be BROKEN if
    // this folder were treated as a themed collection and had files extracted from it
    // (e.g. pulling CURRENT/MANIFEST out of a database). Leave it to the normal walk,
    // which keeps such units together.
    if (opts.detectProjects) {
      const appSig = detectApplicationFolder(entries, path.basename(dir));
      if (
        (appSig && appSig.strength === 'strong') ||
        detectDatabaseFolder(entries) ||
        detectSavedWebpageFolder(entries, path.basename(dir))
      ) {
        disqualified = true;
        return;
      }
    }
    for (const entry of entries) {
      if (disqualified) return;
      if (entry.isSymbolicLink()) continue;
      if (ALWAYS_SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (opts.ignoreNodeModules && entry.name === 'node_modules') continue;
        if (opts.ignoreJunkFolders && PROJECT_JUNK_DIRS.buildCache.includes(entry.name)) continue;
        await recurse(full);
      } else if (entry.isFile()) {
        if (opts.ignoreJunkFolders && JUNK_FILE_NAMES.has(entry.name)) continue;
        const ext = getExtension(entry.name);
        const learned = await getRuleForExt(ext);
        const category = learned || categorizeByExtension(entry.name) || OTHERS;
        allFiles.push({ absPath: full, relPath: path.relative(dirPath, full), name: entry.name, ext, category });
      }
    }
  }

  await recurse(dirPath);
  if (disqualified || allFiles.length < MIN_THEMED_FILES) return null;

  const counts = {};
  for (const f of allFiles) counts[f.category] = (counts[f.category] || 0) + 1;
  let dominantCategory = null;
  let dominantCount = 0;
  for (const [cat, n] of Object.entries(counts)) {
    if (cat === OTHERS) continue; // a majority of "unknown" isn't a meaningful theme
    if (n > dominantCount) {
      dominantCount = n;
      dominantCategory = cat;
    }
  }
  if (!dominantCategory) return null;
  if (dominantCount / allFiles.length < THEMED_MIN_RATIO) return null;

  return {
    dominantCategory,
    totalFiles: allFiles.length,
    dominantCount,
    minorityFiles: allFiles.filter((f) => f.category !== dominantCategory),
  };
}

/** Probes a folder's extensionless / binary-named direct files for a native executable
 *  header (ELF/PE/Mach-O), so Linux/mac programs with no extension are recognized too. */
async function hasNativeExecutable(dir, entries) {
  let probed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = getExtension(entry.name);
    const looksBinary = ext === '' || /-(linux|darwin|windows|amd64|arm64|x86_64|i386|386)\b/i.test(entry.name);
    if (!looksBinary) continue;
    if (probed >= 6) break;
    probed += 1;
    let fh;
    try {
      fh = await fsp.open(path.join(dir, entry.name), 'r');
      const buf = Buffer.alloc(4);
      await fh.read(buf, 0, 4, 0);
      if (matchesNativeExeMagic(buf)) return entry.name;
    } catch {
      // unreadable - skip
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }
  return null;
}

/**
 * Decides whether a non-root folder is a self-contained UNIT to keep intact, returning
 * a descriptor { type, markerFile, destCategory, isApplication } or null. Tries, in order:
 * database signatures, a saved-web-page companion folder, an application (by extension,
 * by a native executable header, or - for ambiguous cases when the LLM is enabled - by
 * asking the model, which may also classify it as a database/model repo/dataset/etc.).
 */
async function detectIntactUnit(dir, entries, opts) {
  const name = path.basename(dir);

  const db = detectDatabaseFolder(entries);
  if (db) return { type: db.type, markerFile: db.markerFile, destCategory: db.destCategory, isApplication: false };

  const web = detectSavedWebpageFolder(entries, name);
  if (web) return { type: web.type, markerFile: web.markerFile, destCategory: web.destCategory, isApplication: false };

  let appSig = detectApplicationFolder(entries, name);
  if (!appSig || appSig.strength !== 'strong') {
    const dirCount = entries.filter((e) => e.isDirectory()).length;
    const looseFiles = entries.filter((e) => e.isFile()).length;
    const containerish = dirCount >= 6 || looseFiles >= 20;
    if (!containerish) {
      const nativeExe = await hasNativeExecutable(dir, entries);
      if (nativeExe) appSig = { type: 'Application', markerFile: nativeExe, strength: 'strong' };
    }
  }

  if (!appSig) return null;
  if (appSig.strength === 'strong') {
    return { type: appSig.type, markerFile: appSig.markerFile, destCategory: 'applications', isApplication: true };
  }
  // Weak signal: only lock it in if the LLM confirms it's a keep-together unit.
  if (opts.useLLM && opts.llmFolderBudget.n > 0) {
    opts.llmFolderBudget.n -= 1;
    try {
      const verdict = await classifyFolderWithLLM({
        name, relPath: dir, entryNames: sampleEntryNames(entries), url: opts.llmUrl, model: opts.llmModel,
      });
      if (verdict.keepIntact) {
        return {
          type: appSig.type,
          markerFile: appSig.markerFile,
          destCategory: verdict.category || 'applications',
          isApplication: !!verdict.isApplication,
        };
      }
    } catch {
      // ignore - fall through to normal handling
    }
  }
  return null;
}

/** Recursively finds junk directories inside a project (node_modules, __pycache__, etc.) without descending into ones it already found. */
async function findJunkDirsInside(root, opts) {
  const found = [];
  async function recurse(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (opts.ignoreNodeModules && PROJECT_JUNK_DIRS.nodeModules.includes(entry.name)) {
        found.push({ type: 'node_modules', path: full });
        continue;
      }
      if (opts.ignoreJunkFolders && PROJECT_JUNK_DIRS.buildCache.includes(entry.name)) {
        found.push({ type: 'build_cache', path: full });
        continue;
      }
      await recurse(full);
    }
  }
  await recurse(root);
  return found;
}

/** Sums file sizes under a directory, skipping any subtree already flagged for deletion. */
async function estimateDirSize(root, skipPaths) {
  const skipSet = new Set(skipPaths);
  let total = 0;
  async function recurse(dir) {
    if (skipSet.has(dir)) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full);
          total += stat.size;
        } catch {
          // skip unreadable file
        }
      }
    }
  }
  await recurse(root);
  return total;
}

/**
 * Walks a source tree, yielding either individual file paths OR, when a directory
 * looks like a self-contained code project or a human-organized "themed" folder,
 * a single descriptor instead of descending into it file-by-file. This is what
 * keeps codebases intact and keeps things like "2026 Birthday Photos" as a folder
 * instead of shredding it into flat category dumps.
 */
async function* walk(dir, opts, onProject, onThemedFolder, isRoot = false) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  if (opts.detectProjects) {
    const marker = detectProjectMarker(entries);
    if (marker) {
      await onProject(dir, marker);
      return; // don't descend - the whole folder is handled as one unit
    }

    // A self-contained UNIT to keep intact (application/program, database, saved web
    // page, etc.). Never applied to a source ROOT: that's the folder the user chose to
    // organize, so it must be scanned into, not swallowed whole.
    if (!isRoot) {
      const unit = await detectIntactUnit(dir, entries, opts);
      if (unit) {
        await onProject(dir, unit);
        return;
      }
    }
  }

  if (opts.detectThemedFolders && !isRoot) {
    const themed = await evaluateThemedFolder(dir, opts);
    if (themed) {
      await onThemedFolder(dir, themed);
      return; // don't descend - stray files get extracted, the rest moves as a unit
    }
  }

  for (const entry of entries) {
    if (ALWAYS_SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (opts.ignoreNodeModules && entry.name === 'node_modules') {
        opts.ignoredNodeModulesDirs.push(full);
        continue;
      }
      if (opts.ignoreJunkFolders && PROJECT_JUNK_DIRS.buildCache.includes(entry.name)) {
        opts.ignoredJunkDirs.push(full);
        continue;
      }
      yield* walk(full, opts, onProject, onThemedFolder, false);
    } else if (entry.isFile()) {
      // OS junk (Thumbs.db, .DS_Store, desktop.ini, .directory) is never something to
      // organize: delete it if cleanup is on, otherwise just leave it where it is -
      // never categorize/move it (so it can't end up as e.g. a "database" file).
      if (JUNK_FILE_NAMES.has(entry.name)) {
        if (opts.ignoreJunkFolders) opts.ignoredJunkFiles.push(full);
        continue;
      }
      yield full;
    }
  }
}

/**
 * Runs a full scan for a job in the background, mutating the job object as it goes
 * so the frontend can poll for progress.
 */
async function runScan(job) {
  job.status = 'scanning';
  if (!Array.isArray(job.log)) job.log = [];
  logJob(job, `Scan started across ${job.sources.length} source folder(s).`);
  job.files = new Map();
  job.duplicateGroups = new Map();
  job.similarGroups = [];
  job.projects = [];
  job.themedFolders = [];
  job.ignoredNodeModulesDirs = [];
  job.ignoredJunkDirs = [];
  job.ignoredJunkFiles = [];
  job.progress = { phase: 'listing', filesFound: 0, filesProcessed: 0 };

  const opts = {
    detectProjects: job.detectProjects,
    detectThemedFolders: job.detectThemedFolders,
    ignoreNodeModules: job.ignoreNodeModules,
    ignoreJunkFolders: job.ignoreJunkFolders,
    ignoredNodeModulesDirs: job.ignoredNodeModulesDirs,
    ignoredJunkDirs: job.ignoredJunkDirs,
    ignoredJunkFiles: job.ignoredJunkFiles,
    useLLM: job.useLLM,
    llmUrl: job.llmUrl,
    llmModel: job.llmModel,
    // Bounds how many ambiguous folders we ask the LLM about, so a huge tree can't
    // fire thousands of folder-classification calls.
    llmFolderBudget: { n: 200 },
  };

  try {
    // Phase 1: walk all source directories - collect loose files AND detect project folders
    for (const sourceRoot of job.sources) {
      const onProject = async (projectPath, marker) => {
        const junkDirsFound = await findJunkDirsInside(projectPath, opts);
        const size = await estimateDirSize(projectPath, junkDirsFound.map((j) => j.path));
        job.projects.push({
          id: nextId('proj'),
          name: path.basename(projectPath),
          absPath: projectPath,
          sourceRoot,
          relPath: path.relative(sourceRoot, projectPath),
          type: marker.type,
          markerFile: marker.markerFile,
          destCategory: marker.destCategory || 'coded_programs',
          isApplication: !!marker.isApplication,
          junkDirsFound,
          sizeBytes: size,
          excluded: false,
        });
      };

      const onThemedFolder = async (folderPath, themed) => {
        const minorityFileIds = [];
        for (const mf of themed.minorityFiles) {
          let stat;
          try {
            stat = await fsp.stat(mf.absPath);
          } catch {
            continue;
          }
          const id = nextId('f');
          job.files.set(id, {
            id,
            name: mf.name,
            ext: mf.ext,
            absPath: mf.absPath,
            sourceRoot,
            relPath: path.relative(sourceRoot, mf.absPath),
            size: stat.size,
            mtime: stat.mtimeMs,
            category: null,
            subPath: null,
            excluded: false,
            duplicateGroupId: null,
            similarGroupId: null,
            themedFolderId: null, // filled in below once we know the folder's id
          });
          minorityFileIds.push(id);
          job.progress.filesFound += 1;
        }
        const folderId = nextId('themed');
        for (const id of minorityFileIds) job.files.get(id).themedFolderId = folderId;
        job.themedFolders.push({
          id: folderId,
          name: path.basename(folderPath),
          absPath: folderPath,
          sourceRoot,
          relPath: path.relative(sourceRoot, folderPath),
          dominantCategory: themed.dominantCategory,
          totalFiles: themed.totalFiles,
          dominantCount: themed.dominantCount,
          minorityFileIds,
          excluded: false,
        });
      };

      logJob(job, `Listing ${sourceRoot}…`);
      for await (const filePath of walk(sourceRoot, opts, onProject, onThemedFolder, true)) {
        let stat;
        try {
          stat = await fsp.stat(filePath);
        } catch {
          continue;
        }
        const name = path.basename(filePath);
        const ext = getExtension(name);
        const id = nextId('f');
        job.files.set(id, {
          id,
          name,
          ext,
          absPath: filePath,
          sourceRoot,
          relPath: path.relative(sourceRoot, filePath),
          size: stat.size,
          mtime: stat.mtimeMs,
          category: null,
          subPath: null,
          excluded: false,
          duplicateGroupId: null,
          similarGroupId: null,
          themedFolderId: null,
        });
        job.progress.filesFound += 1;
      }
    }

    // Phase 2: categorize - learned rules first, then built-in extension map, then batched LLM
    job.progress.phase = 'categorizing';
    logJob(job, `Found ${job.files.size} file(s), ${job.projects.length} project(s), ${job.themedFolders.length} organized folder(s). Categorizing…`);
    const stillUnknown = [];
    for (const file of job.files.values()) {
      const learned = await getRuleForExt(file.ext);
      const builtin = categorizeByExtension(file.name);
      file.category = learned || builtin || null;
      if (!file.category) stillUnknown.push(file);
      job.progress.filesProcessed += 1;
    }

    if (stillUnknown.length > 0 && job.useLLM) {
      const withExt = stillUnknown.filter((f) => f.ext);
      const withoutExt = stillUnknown.filter((f) => !f.ext);
      // One representative file per unknown extension, carrying its name + path so the
      // LLM has real context (not just a bare extension) and can classify formats we
      // don't have hard-coded - and even propose a new category when nothing fits.
      const byExt = new Map();
      for (const f of withExt) if (!byExt.has(f.ext)) byExt.set(f.ext, f);
      const items = [...byExt.values()].map((f) => ({ ext: f.ext, example: f.name, samplePath: f.relPath }));
      logJob(job, `Asking the local LLM about ${items.length} unrecognized file type(s)…`);
      const batchResult = await classifyBatchWithLLM({ items, url: job.llmUrl, model: job.llmModel });
      for (const f of withExt) {
        f.category = batchResult[f.ext] || null;
      }
      for (const f of withoutExt) {
        f.category = await classifyWithLLM({ filename: f.name, ext: f.ext, url: job.llmUrl, model: job.llmModel });
      }
    }
    for (const file of job.files.values()) {
      if (!file.category) file.category = OTHERS;
    }

    // Phase 2.5: FINAL LLM POLISH - re-send every file (name + path + current category)
    // back to the LLM so it can review the whole picture and correct mistakes, exactly
    // like a human proofreading the plan. Runs before metadata/dup/similarity so those
    // work off the corrected categories.
    if (job.useLLM) {
      job.progress.phase = 'polishing';
      const all = [...job.files.values()].map((f) => ({ id: f.id, name: f.name, relPath: f.relPath, category: f.category }));
      logJob(job, `Sending all ${all.length} file(s) back to the LLM for a final review…`);
      try {
        const corrections = await polishCategoriesWithLLM({
          files: all,
          url: job.llmUrl,
          model: job.llmModel,
          onProgress: (p, total) => {
            job.progress.filesProcessed = p;
            job.progress.filesFound = total;
            if (p % 120 === 0 || p === total) logJob(job, `LLM reviewed ${p}/${total} file(s)…`);
          },
        });
        let changed = 0;
        for (const [id, cat] of Object.entries(corrections)) {
          const f = job.files.get(id);
          if (f && cat && cat !== f.category) { f.category = cat; changed += 1; }
        }
        logJob(job, `LLM review adjusted ${changed} categorization(s).`);
      } catch (err) {
        logJob(job, `LLM review skipped: ${err.message}`, 'warn');
      }
    }

    // Phase 3: smart subfolders from metadata (photo capture date, music tags)
    if (job.organizeByDate || job.organizeByMusicTags) {
      job.progress.phase = 'metadata';
      for (const file of job.files.values()) {
        try {
          if (job.organizeByDate && file.category === 'images') {
            file.subPath = await getPhotoDateSubpath(file.absPath);
          } else if (job.organizeByMusicTags && file.category === 'music') {
            file.subPath = await getMusicTagSubpath(file.absPath);
          }
        } catch {
          file.subPath = null;
        }
      }
    }

    // Phase 4: duplicate detection - group by size first (cheap), then hash within groups
    job.progress.phase = 'hashing';
    logJob(job, 'Checking for duplicate files…');
    const bySize = new Map();
    for (const file of job.files.values()) {
      if (!bySize.has(file.size)) bySize.set(file.size, []);
      bySize.get(file.size).push(file);
    }

    const byHash = new Map();
    for (const [size, filesOfSize] of bySize) {
      if (filesOfSize.length < 2 || size === 0) continue;
      for (const file of filesOfSize) {
        let hash;
        try {
          hash = await hashFile(file.absPath);
        } catch {
          continue;
        }
        const key = `${size}_${hash}`;
        if (!byHash.has(key)) byHash.set(key, []);
        byHash.get(key).push(file);
      }
    }

    for (const [key, group] of byHash) {
      if (group.length < 2) continue;
      const groupId = nextId('dup');
      job.duplicateGroups.set(groupId, {
        id: groupId,
        hash: key,
        size: group[0].size,
        fileIds: group.map((f) => f.id),
        resolution: null,
      });
      for (const f of group) f.duplicateGroupId = groupId;
    }

    // Phase 5: near-duplicate (visually similar) image detection - separate from exact duplicates
    if (job.findSimilarImages) {
      job.progress.phase = 'similarity';
      const imageFiles = [...job.files.values()].filter(
        (f) => f.category === 'images' && !f.duplicateGroupId && isPerceptuallyHashable(f.ext)
      );
      const hashed = [];
      for (const f of imageFiles) {
        const hash = await computeDHash(f.absPath);
        if (hash) hashed.push({ id: f.id, hash });
      }
      const groups = groupBySimilarity(hashed, 6);
      for (const idsGroup of groups) {
        const groupId = nextId('sim');
        job.similarGroups.push({ id: groupId, fileIds: idsGroup });
        for (const fid of idsGroup) {
          const f = job.files.get(fid);
          if (f) f.similarGroupId = groupId;
        }
      }
    }

    job.status = 'done';
    job.progress.phase = 'done';
    logJob(job, `Scan complete. ${job.duplicateGroups.size} duplicate group(s), ${job.similarGroups.length} similar-photo group(s). Ready for review.`);
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    logJob(job, `Scan failed: ${err.message}`, 'error');
  }
}

module.exports = { runScan };
