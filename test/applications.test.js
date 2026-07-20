'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { detectApplicationFolder } = require('../lib/projectDetect');
const { categorizeByExtension } = require('../lib/categorize');
const { normalizeCategory } = require('../lib/llm');
const { runScan } = require('../lib/scanner');
const { confirmJob } = require('../lib/mover');

function dirents(spec) {
  // spec: { name: 'file' | 'dir' }
  return Object.entries(spec).map(([name, kind]) => ({
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  }));
}

test('detectApplicationFolder: a lone .exe is a WEAK signal (its companions decide)', () => {
  const sig = detectApplicationFolder(dirents({ 'tor-browser.exe': 'file', 'readme.txt': 'file' }), 'Tor Browser');
  assert.equal(sig.strength, 'weak');
  assert.equal(sig.reason, 'launcher');
});

test('detectApplicationFolder: several shared libraries are a strong signal', () => {
  const sig = detectApplicationFolder(dirents({ 'a.dll': 'file', 'b.dll': 'file', 'c.dll': 'file' }), 'MEmuHyperv64-551');
  assert.equal(sig.strength, 'strong');
});

test('detectApplicationFolder: a lone library is only a weak signal (needs LLM confirmation)', () => {
  const sig = detectApplicationFolder(dirents({ 'x.dll': 'file', 'notes.txt': 'file' }), 'stuff');
  assert.equal(sig.strength, 'weak');
});

test('detectApplicationFolder: a plain media folder is not an application', () => {
  const sig = detectApplicationFolder(dirents({ 'a.jpg': 'file', 'b.jpg': 'file', 'c.jpg': 'file' }), '2026 Photos');
  assert.equal(sig, null);
});

test('a portable app (exe + its own resource files, no dll) is kept intact offline, not shredded', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fo-portable-'));
  const app = path.join(root, 'src', 'Dumpper');
  await fsp.mkdir(app, { recursive: true });
  await fsp.writeFile(path.join(app, 'Dumpper.exe'), 'MZ');       // launcher
  // several notification sounds - would each be dragged into music/ by the old logic
  for (let i = 0; i < 6; i++) await fsp.writeFile(path.join(app, `notify${i}.wav`), `snd${i}`);
  await fsp.writeFile(path.join(app, 'settings.ini'), 'cfg');     // resource (config)
  await fsp.writeFile(path.join(app, 'data.dat'), 'dat');         // resource (data)

  const job = {
    id: 'p', sources: [path.join(root, 'src')], destination: path.join(root, 'dest'),
    useLLM: false, ignoreNodeModules: true, ignoreJunkFolders: true,
    detectProjects: true, detectThemedFolders: true,
    organizeByDate: false, organizeByMusicTags: false, findSimilarImages: false,
  };
  await runScan(job);

  const unit = job.projects.find((p) => p.name === 'Dumpper');
  assert.ok(unit, 'the portable app is kept intact');
  assert.equal(unit.destCategory, 'applications');
  assert.equal(job.files.size, 0, 'none of the app internals (exe/wav/ini/dat) are extracted');
  assert.equal(job.themedFolders.length, 0, 'it is not treated as a themed folder either');
});

test('a documents folder that merely contains one installer.exe is NOT locked as an app (offline)', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fo-drawer-'));
  const drawer = path.join(root, 'src', 'Papers');
  await fsp.mkdir(drawer, { recursive: true });
  for (let i = 0; i < 25; i++) await fsp.writeFile(path.join(drawer, `doc${i}.pdf`), `p${i}`);
  await fsp.writeFile(path.join(drawer, 'installer.exe'), 'MZ');

  const job = {
    id: 'd', sources: [path.join(root, 'src')], destination: path.join(root, 'dest'),
    useLLM: false, ignoreNodeModules: true, ignoreJunkFolders: true,
    detectProjects: true, detectThemedFolders: true,
    organizeByDate: false, organizeByMusicTags: false, findSimilarImages: false,
  };
  await runScan(job);

  assert.equal(job.projects.find((p) => p.name === 'Papers'), undefined, 'a doc folder with a stray exe is not one app');
  assert.ok(job.files.size >= 25, 'its documents are categorized individually');
});

test('a source root with a stray .exe is scanned normally, not swallowed as one application', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fo-root-'));
  await fsp.writeFile(path.join(root, 'Dumpper.exe'), 'MZ');
  await fsp.mkdir(path.join(root, 'docs'), { recursive: true });
  await fsp.writeFile(path.join(root, 'docs', 'a.txt'), 'a');
  await fsp.writeFile(path.join(root, 'docs', 'b.txt'), 'b');
  await fsp.mkdir(path.join(root, 'pics'), { recursive: true });
  await fsp.writeFile(path.join(root, 'pics', 'x.jpg'), 'img');

  const job = {
    id: 'r', sources: [root], destination: path.join(root, '__dest'),
    useLLM: false, ignoreNodeModules: true, ignoreJunkFolders: true,
    detectProjects: true, detectThemedFolders: false,
    organizeByDate: false, organizeByMusicTags: false, findSimilarImages: false,
  };
  await runScan(job);

  assert.equal(job.projects.length, 0, 'the whole root must NOT be treated as one application');
  assert.equal(job.files.size, 4, 'every file (incl. the .exe) is scanned individually');
  const exe = [...job.files.values()].find((f) => f.name === 'Dumpper.exe');
  assert.equal(exe.category, 'executables');
});

test('action-cam / proxy video formats now categorize as video, not others', () => {
  assert.equal(categorizeByExtension('VID_001.insv'), 'video');
  assert.equal(categorizeByExtension('VID_001.lrv'), 'video');
  assert.equal(categorizeByExtension('clip.360'), 'video');
  assert.equal(categorizeByExtension('a.mts'), 'video');
});

test('normalizeCategory turns free-form LLM output into a safe slug', () => {
  assert.equal(normalizeCategory('Video'), 'video');
  assert.equal(normalizeCategory('3D Models'), '3d_models');
  assert.equal(normalizeCategory('  disk images '), 'disk_images');
  assert.equal(normalizeCategory('!!!'), '');
});

test('a folder full of .dll/.exe is preserved intact as an application (no LLM needed)', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fo-app-'));
  const app = path.join(root, 'Tor Browser', 'Browser');
  await fsp.mkdir(app, { recursive: true });
  await fsp.writeFile(path.join(app, 'firefox.exe'), 'MZ');
  await fsp.writeFile(path.join(app, 'nss3.dll'), 'lib');
  await fsp.writeFile(path.join(app, 'mozglue.dll'), 'lib');
  await fsp.writeFile(path.join(app, 'omni.ja'), 'pack');

  const job = {
    id: 't', sources: [root], destination: path.join(root, '__dest'),
    useLLM: false, ignoreNodeModules: true, ignoreJunkFolders: true,
    detectProjects: true, detectThemedFolders: false,
    organizeByDate: false, organizeByMusicTags: false, findSimilarImages: false,
  };
  await runScan(job);

  assert.equal(job.status, 'done');
  assert.equal(job.projects.length, 1, 'the application folder is detected as one intact unit');
  assert.equal(job.projects[0].isApplication, true);
  assert.equal(job.projects[0].destCategory, 'applications');
  assert.equal(job.files.size, 0, 'none of the app internals leak out as loose files');
});

test('a detected application is moved intact into destination/applications/<name>', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fo-appmove-'));
  const dest = path.join(root, 'dest');
  const appDir = path.join(root, 'src', 'MEmu');
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.writeFile(path.join(appDir, 'run.exe'), 'MZ');
  await fsp.writeFile(path.join(appDir, 'engine.dll'), 'lib');

  const job = {
    destination: dest,
    files: new Map(),
    duplicateGroups: new Map(),
    themedFolders: [],
    projects: [{
      id: 'p1', name: 'MEmu', absPath: appDir, type: 'Application',
      destCategory: 'applications', isApplication: true, junkDirsFound: [], excluded: false,
    }],
    ignoredNodeModulesDirs: [], ignoredJunkDirs: [], ignoredJunkFiles: [],
  };

  const report = await confirmJob(job);
  assert.ok(fs.existsSync(path.join(dest, 'applications', 'MEmu', 'run.exe')), 'app moved intact under applications/');
  assert.ok(!fs.existsSync(appDir), 'app removed from source');
  assert.equal(report.projectsMoved.length, 1);
  assert.equal(report.moved[0].category, 'applications');
});
