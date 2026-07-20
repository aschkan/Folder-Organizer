'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { categorizeByExtension, getExtension, OTHERS } = require('./categorize');
const { classifyWithLLM, classifyBatchWithLLM, classifyFolderWithLLM, polishCategoriesWithLLM, findFolderStraysWithLLM } = require('./llm');
const {
  detectProjectMarker, detectApplicationFolder, detectDatabaseFolder,
  detectSavedWebpageFolder, matchesNativeExeMagic, sampleEntryNames, PROJECT_JUNK_DIRS,
} = require('./projectDetect');
const { getRuleForExt } = require('./learnedRules');
const { getPhotoDateSubpath, getMusicTagSubpath } = require('./metadata');
const { isPerceptuallyHashable, computeDHash, groupBySimilarity } = require('./perceptualHash');
const { logJob } = require('./jobLog');
const { maybeCooldown } = require('./thermal');

function describeTemps(t) {
  const parts = [];
  if (t && t.cpuC != null) parts.push(`CPU ${t.cpuC}°C`);
  if (t && t.gpuC != null) parts.push(`GPU ${t.gpuC}°C`);
  return parts.join(', ') || 'temps unavailable';
}

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
    // A nested intact unit (application, database, saved web page, native binary) would
    // be BROKEN if this folder were treated as a themed collection and had files pulled
    // out of it - e.g. extracting Dumpper.exe or its notification .wav out of a portable
    // app, or CURRENT/MANIFEST out of a database. So disqualify on ANY program signal
    // (even a weak one), a database, a saved web page, or a native executable. Whether a
    // weak-signal folder is truly one app is then decided by the AI during the normal walk.
    if (opts.detectProjects) {
      if (
        detectApplicationFolder(entries, path.basename(dir)) ||
        detectDatabaseFolder(entries) ||
        detectSavedWebpageFolder(entries, path.basename(dir)) ||
        (await hasNativeExecutable(dir, entries))
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
    allFiles, // full listing, so stray detection (LLM or extension) can run afterwards
  };
}

/** Recursively lists a folder's files (skipping junk dirs/files, symlinks), capped so a
 *  huge folder doesn't produce an enormous LLM prompt. Returns [{ absPath, relPath, name }]. */
async function listFilesInFolder(root, opts, cap = 400) {
  const out = [];
  let stop = false;
  async function recurse(dir) {
    if (stop) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stop) return;
      if (entry.isSymbolicLink()) continue;
      if (ALWAYS_SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (opts.ignoreNodeModules && PROJECT_JUNK_DIRS.nodeModules.includes(entry.name)) continue;
        if (opts.ignoreJunkFolders && PROJECT_JUNK_DIRS.buildCache.includes(entry.name)) continue;
        await recurse(full);
      } else if (entry.isFile()) {
        if (JUNK_FILE_NAMES.has(entry.name)) continue;
        out.push({ absPath: full, relPath: path.relative(root, full), name: entry.name });
        if (out.length > cap) { stop = true; return; }
      }
    }
  }
  await recurse(root);
  return out;
}

/** Materializes a set of stray files as normal job.files entries (so they get categorized
 *  and moved to their own category), tagging each with the unit it was pulled out of. */
async function materializeStrays(job, strays, sourceRoot, key, unitId) {
  const ids = [];
  for (const item of strays) {
    let stat;
    try {
      stat = await fsp.stat(item.absPath);
    } catch {
      continue;
    }
    const id = nextId('f');
    const entry = {
      id, name: item.name, ext: getExtension(item.name), absPath: item.absPath,
      sourceRoot, relPath: path.relative(sourceRoot, item.absPath),
      size: stat.size, mtime: stat.mtimeMs, category: null, subPath: null,
      excluded: false, duplicateGroupId: null, similarGroupId: null, themedFolderId: null,
    };
    entry[key] = unitId;
    job.files.set(id, entry);
    ids.push(id);
    job.progress.filesFound += 1;
  }
  return ids;
}

/**
 * Decides which files inside each kept-intact folder are genuine STRAYS that should be
 * pulled out and sorted on their own (a PDF in a photo album, an unrelated download inside
 * an app). With the LLM enabled this asks the model with the FULL folder listing as context;
 * otherwise themed folders fall back to the extension-based minority and apps keep everything.
 */
async function resolveFolderStrays(job, opts, cooldown) {
  const cfg = { provider: job.llmProvider, url: job.llmUrl, model: job.llmModel };
  const useAI = !!job.useLLM && job.aiExtractStrays !== false;
  if (useAI) job.progress.phase = 'ai_review';

  for (const folder of job.themedFolders) {
    const all = folder._allFiles || [];
    let strays;
    if (useAI && all.length > 0) {
      if (cooldown) await cooldown('ai_review');
      logJob(job, `Asking the LLM which files don't belong in "${folder.name}"…`);
      const rel = await findFolderStraysWithLLM({ folderName: folder.name, kind: 'collection', files: all.map((f) => ({ relPath: f.relPath })), ...cfg });
      const set = new Set(rel);
      strays = all.filter((f) => set.has(f.relPath));
    } else {
      strays = all.filter((f) => f.category !== folder.dominantCategory);
    }
    folder.minorityFileIds = await materializeStrays(job, strays, folder.sourceRoot, 'themedFolderId', folder.id);
    delete folder._allFiles;
  }

  // Apps/programs: only when the AI is on, and with a HARD safety net. The LLM only
  // *suggests* strays; code then refuses to pull anything that isn't unmistakably the
  // user's own personal document/photo/media. A program's own files - hash-named caches,
  // data, logs, configs, code, downloads, opaque/extensionless files, or anything inside
  // an internal dir like cache/ or bin/ - can NEVER be extracted, so a tool like a
  // drug-discovery pipeline, a game, or a database is never torn apart.
  if (useAI) {
    for (const project of job.projects) {
      // Opaque collections (databases, saved web pages) are all-essential: never touch them.
      if (project.destCategory === 'databases' || project.destCategory === 'web_pages') continue;
      const files = await listFilesInFolder(project.absPath, opts, 400);
      if (files.length === 0 || files.length >= 400) continue;
      if (cooldown) await cooldown('ai_review');
      logJob(job, `Checking "${project.name}" for personal files that don't belong to it…`);
      const rel = await findFolderStraysWithLLM({
        folderName: project.name,
        kind: project.isApplication ? 'application' : 'project',
        files: files.map((f) => ({ relPath: f.relPath })),
        ...cfg,
      });
      if (rel.length === 0) continue;
      const flagged = new Set(rel);
      const strays = files.filter((f) => flagged.has(f.relPath) && isExtractablePersonalFile(f.relPath, f.name));
      project.strayFileIds = await materializeStrays(job, strays, project.sourceRoot, 'projectId', project.id);
      if (project.strayFileIds.length > 0) logJob(job, `Pulled ${project.strayFileIds.length} personal file(s) out of "${project.name}".`);
    }
  }
}

// Categories that represent the USER'S OWN content (safe to lift out of a program folder).
const EXTRACTABLE_USER_CATEGORIES = new Set(['documents', 'images', 'video', 'music', 'ebooks']);
// Directory names that are program internals - files under them are never "strays".
const PROGRAM_INTERNAL_DIR_SEGMENTS = new Set([
  'cache', '.cache', '__pycache__', 'node_modules', 'dist', 'build', 'out',
  '.git', '.svn', '.hg', 'tmp', 'temp', 'logs', 'log', 'bin', 'obj', 'target',
  '.next', 'venv', '.venv', 'env', 'site-packages', 'vendor', 'lib', 'libs',
  'data', 'assets', 'resources', 'res', 'locale', 'locales', 'i18n',
]);

/**
 * Hard guard: a file may be pulled OUT of a detected program/project only if it is
 * unmistakably the user's own personal content - a recognized document/photo/video/song,
 * NOT inside any program-internal directory. Everything else (caches, data, configs, code,
 * downloads, opaque/extensionless files) stays put, so a program can never be broken.
 */
function isExtractablePersonalFile(relPath, name) {
  const cat = categorizeByExtension(name);
  if (!cat || !EXTRACTABLE_USER_CATEGORIES.has(cat)) return false;
  const segments = relPath.split(/[\\/]+/).slice(0, -1);
  if (segments.some((seg) => PROGRAM_INTERNAL_DIR_SEGMENTS.has(seg.toLowerCase()))) return false;
  return true;
}

// Only DOCUMENTS (and e-books) count as "clearly the user's own files" here. Sounds and
// images are deliberately NOT counted: a program's notification .wav files or UI .png
// assets sit right next to its .exe and must not make it look like a media folder.
const USER_DOCUMENT_CATEGORIES = new Set(['documents', 'ebooks']);

/** True if a folder's DIRECT files are mostly user documents - i.e. it looks like a
 *  document folder that merely contains a stray executable (e.g. an installer dropped
 *  among 25 PDFs), rather than a program whose companions are its own resources. */
function documentsDominate(entries) {
  let docs = 0;
  let recognized = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const cat = categorizeByExtension(entry.name);
    if (!cat) continue; // unknown extension - stays neutral
    recognized += 1;
    if (USER_DOCUMENT_CATEGORIES.has(cat)) docs += 1;
  }
  return recognized >= 4 && docs * 2 > recognized;
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

  // Weak launcher (an .exe with no libraries). Decide app-vs-junk-drawer by WHAT sits
  // next to it: if the companions are program resources (.dll/.dat/.wav/.ini/config...)
  // rather than unrelated user documents/photos/music, it's one app - keep it intact even
  // without the LLM. This is what fixes portable apps like Dumpper (exe + notification
  // sounds + data) while still NOT grabbing a folder of 25 PDFs that happens to hold one
  // installer.exe (there the AI, if enabled, gets the final say).
  if (appSig.reason === 'launcher' && !documentsDominate(entries)) {
    return { type: appSig.type, markerFile: appSig.markerFile, destCategory: 'applications', isApplication: true };
  }

  // Still ambiguous: let the AI make the call.
  if (opts.useLLM && opts.llmFolderBudget.n > 0) {
    opts.llmFolderBudget.n -= 1;
    try {
      const verdict = await classifyFolderWithLLM({
        name, relPath: dir, entryNames: sampleEntryNames(entries),
        provider: opts.llmProvider, url: opts.llmUrl, model: opts.llmModel,
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
    llmProvider: job.llmProvider,
    llmUrl: job.llmUrl,
    llmModel: job.llmModel,
    // Bounds how many ambiguous folders we ask the LLM about, so a huge tree can't
    // fire thousands of folder-classification calls.
    llmFolderBudget: { n: 200 },
  };

  // Thermal cooldown gate: before each chunk of AI work, if the system is too hot, pause
  // (polling live temps) until it cools. A no-op when disabled or when temps are unreadable.
  const thermalCfg = job.thermal && job.thermal.enabled ? job.thermal : null;
  async function cooldownGate(activePhase) {
    if (!thermalCfg) return;
    const res = await maybeCooldown(thermalCfg, {
      onTick: ({ temps, resumeTempC, waitedMs, first }) => {
        job.temps = temps;
        job.progress.phase = 'cooling';
        job.cooling = { cpuC: temps.cpuC, gpuC: temps.gpuC, resumeTempC, waitedMs };
        if (first) logJob(job, `🌡️ Hot (${describeTemps(temps)}). Pausing to cool down below ${resumeTempC}°C…`, 'warn');
      },
    });
    if (res.temps) job.temps = res.temps;
    if (res.paused) {
      job.cooling = null;
      if (activePhase) job.progress.phase = activePhase;
      logJob(job, res.cooled
        ? `🌡️ Cooled to ${describeTemps(res.temps)} after ${Math.round((res.waitedMs || 0) / 1000)}s — resuming.`
        : `🌡️ Cooldown timed out after ${Math.round((res.waitedMs || 0) / 1000)}s — resuming anyway.`, 'warn');
    }
  }

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
        // Stray files are materialized later, in resolveFolderStrays, so the LLM (when
        // enabled) can decide which files don't belong using the full folder listing.
        job.themedFolders.push({
          id: nextId('themed'),
          name: path.basename(folderPath),
          absPath: folderPath,
          sourceRoot,
          relPath: path.relative(sourceRoot, folderPath),
          dominantCategory: themed.dominantCategory,
          totalFiles: themed.totalFiles,
          dominantCount: themed.dominantCount,
          minorityFileIds: [],
          excluded: false,
          _allFiles: themed.allFiles,
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

    // Phase 1b: decide which files inside kept-intact folders are strays that don't belong.
    logJob(job, 'Reviewing which files belong to each detected folder…');
    await resolveFolderStrays(job, opts, cooldownGate);

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
      await cooldownGate('categorizing');
      const batchResult = await classifyBatchWithLLM({ items, provider: job.llmProvider, url: job.llmUrl, model: job.llmModel });
      for (const f of withExt) {
        f.category = batchResult[f.ext] || null;
      }
      for (const f of withoutExt) {
        f.category = await classifyWithLLM({ filename: f.name, ext: f.ext, provider: job.llmProvider, url: job.llmUrl, model: job.llmModel });
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
          provider: job.llmProvider,
          url: job.llmUrl,
          model: job.llmModel,
          beforeBatch: () => cooldownGate('polishing'),
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

module.exports = { runScan, isExtractablePersonalFile };
