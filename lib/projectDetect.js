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
  let dirCount = 0;
  let otherFileCount = 0;
  for (const e of entries) {
    if (e.isDirectory()) { dirCount += 1; continue; }
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (APP_MARKER_FILES.has(lower)) { markerHit = e.name; continue; }
    const ext = extOfName(e.name);
    if (APP_LAUNCHER_EXTS.has(ext)) launcher = launcher || e.name;
    else if (APP_LIBRARY_EXTS.has(ext)) libCount += 1;
    else otherFileCount += 1;
  }

  // A folder that's clearly a CONTAINER of many unrelated things (lots of subfolders or
  // loose files) is NOT a single application, even if a stray launcher sits in it. This
  // is what stops an entire Desktop being swallowed just because of one .exe.
  const containerish = dirCount >= 6 || otherFileCount >= 20;
  if (containerish) return null;

  // Confident (lock intact without asking the LLM):
  if (markerHit) return { type: 'Application', markerFile: markerHit, strength: 'strong' };
  // an executable shipped alongside real libraries is unambiguously a program,
  if (launcher && libCount >= 1) return { type: 'Application', markerFile: launcher, strength: 'strong' };
  // a pile of libraries that make up a real share of the folder,
  if (libCount >= 3 && libCount * 2 >= otherFileCount) {
    return { type: 'Application', markerFile: `${libCount} libraries`, strength: 'strong' };
  }
  // or a lone launcher in a small, self-contained folder (a portable single-exe tool).
  if (launcher) return { type: 'Application', markerFile: launcher, strength: 'strong' };

  // Weak (only locked if the LLM confirms): a couple libraries, or an app-ish name.
  if (libCount >= 1) {
    return { type: 'Possible application', markerFile: `${libCount} librar${libCount === 1 ? 'y' : 'ies'}`, strength: 'weak' };
  }
  if (folderName && APP_NAME_HINTS.test(folderName) && (dirCount > 0 || otherFileCount >= 3)) {
    return { type: 'Possible application', markerFile: 'name/structure', strength: 'weak' };
  }
  return null;
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
  sampleEntryNames,
  PROJECT_JUNK_DIRS,
  sanitizeName,
};
