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

module.exports = { detectProjectMarker, PROJECT_JUNK_DIRS, sanitizeName };
