'use strict';

const path = require('path');

// Marker file (relative to a candidate folder's root) -> project type label.
// If ANY of these exist directly inside a folder, that folder is treated as
// a single project unit and never decomposed file-by-file.
const PROJECT_MARKERS = [
  { file: 'package.json', type: 'Node.js' },
  { file: 'requirements.txt', type: 'Python' },
  { file: 'pyproject.toml', type: 'Python' },
  { file: 'setup.py', type: 'Python' },
  { file: 'Pipfile', type: 'Python' },
  { file: 'Cargo.toml', type: 'Rust' },
  { file: 'go.mod', type: 'Go' },
  { file: 'pom.xml', type: 'Java (Maven)' },
  { file: 'build.gradle', type: 'Java/Kotlin (Gradle)' },
  { file: 'build.gradle.kts', type: 'Java/Kotlin (Gradle)' },
  { file: 'composer.json', type: 'PHP' },
  { file: 'Gemfile', type: 'Ruby' },
  { file: '.csproj', type: '.NET', isSuffix: true },
  { file: '.sln', type: '.NET', isSuffix: true },
  { file: 'CMakeLists.txt', type: 'C/C++' },
];

// Junk/cache directories commonly found INSIDE a project that should never be
// copied to the destination, keyed by which cleanup toggle controls them.
const PROJECT_JUNK_DIRS = {
  nodeModules: ['node_modules'],
  buildCache: [
    '__pycache__', '.venv', 'venv', 'env', 'dist', 'build', '.next', 'target',
    '.gradle', '.pytest_cache', '.mypy_cache', '.tox', '.cache', 'out',
  ],
};

// Signals that a folder is a self-contained, compiled APPLICATION/program (as opposed
// to a source-code project) - the kind of folder that stops working the moment its
// files are split across category folders. There are effectively infinite such layouts,
// so this only catches the confident cases statically; the LLM handles the long tail.
const APP_LAUNCHER_EXTS = new Set(['exe', 'msi', 'app', 'appimage', 'bat', 'cmd', 'com', 'run', 'apk']);
const APP_LIBRARY_EXTS = new Set(['dll', 'so', 'dylib', 'sys', 'ocx', 'drv']);
const APP_MARKER_FILES = new Set(['omni.ja', 'resources.pak', 'application.ini']);
// Folder-name hints (installers, repacks, portable apps, browsers, emulators, versioned builds).
const APP_NAME_HINTS = /(repack|installer|setup|portable|browser|emulator|runtime|hyperv|win(32|64)|x(86|64)|v?\d+[._]\d+)/i;

function extOfName(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/**
 * Inspects a folder's DIRECT entries (+ its name) and returns an application signal:
 *   { type, markerFile, strength: 'strong' | 'weak' } or null.
 * 'strong' = confident it's a program (lock it intact without asking the LLM).
 * 'weak'   = looks program-ish (only lock it if the LLM confirms, when enabled).
 */
function detectApplicationFolder(entries, folderName = '') {
  let launcher = null;
  let libCount = 0;
  let markerHit = null;
  for (const e of entries) {
    if (!e.isFile || !e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (APP_MARKER_FILES.has(lower)) { markerHit = e.name; continue; }
    const ext = extOfName(e.name);
    if (APP_LAUNCHER_EXTS.has(ext)) launcher = launcher || e.name;
    else if (APP_LIBRARY_EXTS.has(ext)) libCount += 1;
  }

  // STRONG = unambiguous program evidence, so we lock the folder intact WITHOUT asking
  // the LLM - no matter how many resource files (sounds, images, data, config) ship
  // alongside. A program's own resources must never be counted against it.
  if (markerHit) return { type: 'Application', markerFile: markerHit, strength: 'strong', reason: 'marker' };
  if (launcher && libCount >= 1) return { type: 'Application', markerFile: launcher, strength: 'strong', reason: 'launcher' };
  if (libCount >= 3) return { type: 'Application', markerFile: `${libCount} libraries`, strength: 'strong', reason: 'libraries' };

  // WEAK = "there's an executable here, but is this ONE program to keep together, or a
  // folder that merely happens to contain an .exe among unrelated files (e.g. a Desktop
  // with a stray installer)?" That's a human judgement call, so we defer it to the AI
  // (the local LLM confirms) rather than guessing with brittle file/subfolder counts.
  if (launcher) return { type: 'Possible application', markerFile: launcher, strength: 'weak', reason: 'launcher' };
  if (libCount >= 1) {
    return { type: 'Possible application', markerFile: `${libCount} librar${libCount === 1 ? 'y' : 'ies'}`, strength: 'weak', reason: 'libraries' };
  }
  if (folderName && APP_NAME_HINTS.test(folderName)) {
    return { type: 'Possible application', markerFile: 'name/structure', strength: 'weak', reason: 'name' };
  }
  return null;
}

// On-disk databases are folders of opaque files that only work as a set (a stray
// .sst is useless) - keep them intact. Detects LevelDB/RocksDB, LMDB, and .sst piles.
function detectDatabaseFolder(entries) {
  let hasCurrent = false;
  let hasManifest = false;
  let hasLmdb = false;
  let sstCount = 0;
  for (const e of entries) {
    if (!e.isFile || !e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (lower === 'current') hasCurrent = true;
    else if (lower.startsWith('manifest-')) hasManifest = true;
    else if (lower === 'data.mdb' || lower === 'lock.mdb') hasLmdb = true;
    const ext = extOfName(e.name);
    if (ext === 'sst' || ext === 'ldb') sstCount += 1;
  }
  if (hasCurrent && (hasManifest || sstCount >= 1)) {
    return { type: 'Database (LevelDB/RocksDB)', markerFile: 'CURRENT', destCategory: 'databases', strength: 'strong' };
  }
  if (hasLmdb) return { type: 'Database (LMDB)', markerFile: 'data.mdb', destCategory: 'databases', strength: 'strong' };
  if (sstCount >= 5) return { type: 'Database', markerFile: `${sstCount} .sst files`, destCategory: 'databases', strength: 'strong' };
  return null;
}

const WEB_ASSET_EXTS = new Set(['js', 'css', 'html', 'htm', 'download', 'woff', 'woff2', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'json', 'map', 'aspx']);

// A "Save page as" companion folder (named "<Page>_files") is a pile of the page's
// assets that only make sense together - keep it intact instead of scattering hundreds
// of .js/.css/.download files into "others".
function detectSavedWebpageFolder(entries, folderName = '') {
  const nameMatch = /_files$/i.test(folderName);
  let downloadCount = 0;
  let fileCount = 0;
  for (const e of entries) {
    if (!e.isFile || !e.isFile()) continue;
    fileCount += 1;
    if (extOfName(e.name) === 'download') downloadCount += 1;
  }
  if (nameMatch && fileCount >= 1) {
    return { type: 'Saved web page', markerFile: '_files', destCategory: 'web_pages', strength: 'strong' };
  }
  if (downloadCount >= 3) {
    return { type: 'Saved web page', markerFile: `${downloadCount} .download files`, destCategory: 'web_pages', strength: 'strong' };
  }
  return null;
}

const NATIVE_EXE_MAGICS = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF   (Linux)
  [0x4d, 0x5a],             // MZ    (Windows PE)
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64 LE
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal
];

function matchesNativeExeMagic(buf) {
  return NATIVE_EXE_MAGICS.some((m) => m.every((b, i) => buf[i] === b));
}

/** A compact sample of a folder's direct entries, for handing folder context to the LLM. */
function sampleEntryNames(entries, limit = 40) {
  const names = [];
  for (const e of entries) {
    names.push(e.isDirectory() ? `${e.name}/` : e.name);
    if (names.length >= limit) break;
  }
  return names;
}

/**
 * Given a directory's entries (fs.Dirent[]), returns the matched project marker
 * info if this directory looks like a project root, else null.
 */
function detectProjectMarker(entries) {
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    for (const marker of PROJECT_MARKERS) {
      if (marker.isSuffix ? entry.name.endsWith(marker.file) : entry.name === marker.file) {
        return { markerFile: entry.name, type: marker.type };
      }
    }
  }
  // A .git directory also strongly signals "this is a project, don't touch it"
  const hasGit = entries.some((e) => e.isDirectory() && e.name === '.git');
  if (hasGit) return { markerFile: '.git', type: 'Git repository' };
  return null;
}

function sanitizeName(name) {
  return name.replace(/[<>:"|?*\x00-\x1f]/g, '_');
}

module.exports = {
  detectProjectMarker,
  detectApplicationFolder,
  detectDatabaseFolder,
  detectSavedWebpageFolder,
  matchesNativeExeMagic,
  sampleEntryNames,
  PROJECT_JUNK_DIRS,
  sanitizeName,
};
