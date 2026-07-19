'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { categorizeByExtension } = require('../lib/categorize');
const { detectDatabaseFolder, detectSavedWebpageFolder } = require('../lib/projectDetect');
const { runScan } = require('../lib/scanner');

function dirents(spec) {
  return Object.entries(spec).map(([name, kind]) => ({
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  }));
}

function scanJob(root, extra = {}) {
  return {
    id: 't', sources: [root], destination: path.join(root, '__dest'),
    useLLM: false, ignoreNodeModules: true, ignoreJunkFolders: true,
    detectProjects: true, detectThemedFolders: false,
    organizeByDate: false, organizeByMusicTags: false, findSimilarImages: false,
    ...extra,
  };
}

test('the expanded extension map covers the formats that used to fall into others', () => {
  assert.equal(categorizeByExtension('Discord.lnk'), 'shortcuts');
  assert.equal(categorizeByExtension('site.url'), 'shortcuts');
  assert.equal(categorizeByExtension('yolov8n.pt'), 'models');
  assert.equal(categorizeByExtension('model.onnx'), 'models');
  assert.equal(categorizeByExtension('torch-2.6.0.whl'), 'packages');
  assert.equal(categorizeByExtension('x-ui.db'), 'databases');
  assert.equal(categorizeByExtension('000009.sst'), 'databases');
  assert.equal(categorizeByExtension('Vpn.conf'), 'config');
  assert.equal(categorizeByExtension('profile.mobileconfig'), 'config');
  assert.equal(categorizeByExtension('booking.eml'), 'documents');
  assert.equal(categorizeByExtension('sketch.ino'), 'code');
  assert.equal(categorizeByExtension('geoip.dat'), 'data');
});

test('detectDatabaseFolder recognizes a LevelDB/RocksDB store', () => {
  const sig = detectDatabaseFolder(dirents({
    CURRENT: 'file', 'MANIFEST-000276': 'file', '000009.sst': 'file', LOG: 'file', LOCK: 'file',
  }));
  assert.equal(sig.destCategory, 'databases');
  assert.equal(sig.strength, 'strong');
});

test('detectSavedWebpageFolder recognizes a "..._files" save-page folder', () => {
  const byName = detectSavedWebpageFolder(dirents({ 'jquery.js.download': 'file', 'style.css': 'file' }), 'AMPM Restaurants_files');
  assert.equal(byName.destCategory, 'web_pages');
  const byDownloads = detectSavedWebpageFolder(dirents({ 'a.js.download': 'file', 'b.js.download': 'file', 'c.js.download': 'file' }), 'whatever');
  assert.equal(byDownloads.destCategory, 'web_pages');
});

test('scan keeps a database folder intact instead of scattering its .sst files', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fo-db-'));
  const db = path.join(root, 'oxigraph_db');
  await fsp.mkdir(db, { recursive: true });
  await fsp.writeFile(path.join(db, 'CURRENT'), 'x');
  await fsp.writeFile(path.join(db, 'MANIFEST-000276'), 'x');
  for (let i = 0; i < 5; i++) await fsp.writeFile(path.join(db, `00000${i}.sst`), 'x');
  await fsp.writeFile(path.join(root, 'readme.txt'), 'hi');

  const job = scanJob(root);
  await runScan(job);

  const unit = job.projects.find((p) => p.name === 'oxigraph_db');
  assert.ok(unit, 'the database folder is kept intact');
  assert.equal(unit.destCategory, 'databases');
  assert.equal([...job.files.values()].some((f) => f.ext === 'sst'), false, 'no .sst leaks out as a loose file');
});

test('scan keeps a saved-web-page "_files" folder intact', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fo-web-'));
  const wp = path.join(root, 'Menu_files');
  await fsp.mkdir(wp, { recursive: true });
  await fsp.writeFile(path.join(wp, 'jquery.js.download'), 'x');
  await fsp.writeFile(path.join(wp, 'style.css'), 'x');
  await fsp.writeFile(path.join(root, 'Menu.html'), '<html>');

  const job = scanJob(root);
  await runScan(job);

  const unit = job.projects.find((p) => p.name === 'Menu_files');
  assert.ok(unit, 'the saved-page folder is kept intact');
  assert.equal(unit.destCategory, 'web_pages');
});

test('themed detection never extracts files out of a nested database (which would break it)', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fo-themed-db-'));
  const db = path.join(root, 'Maddie', 'oxigraph_db');
  await fsp.mkdir(db, { recursive: true });
  await fsp.writeFile(path.join(db, 'CURRENT'), 'c');
  await fsp.writeFile(path.join(db, 'MANIFEST-000276'), 'm');
  for (let i = 0; i < 5; i++) await fsp.writeFile(path.join(db, `00000${i}.sst`), `sst${i}`);
  await fsp.writeFile(path.join(db, 'LOG'), 'l');
  await fsp.writeFile(path.join(root, 'Maddie', 'script.py'), 'code');

  const job = scanJob(root, { detectThemedFolders: true });
  await runScan(job);

  const unit = job.projects.find((p) => p.name === 'oxigraph_db');
  assert.ok(unit && unit.destCategory === 'databases', 'the database is kept whole');
  assert.equal(job.themedFolders.length, 0, 'the parent is not treated as a themed folder that shreds the DB');
  // The DB internals (CURRENT/MANIFEST/LOG/.sst) must NOT appear as extracted loose files.
  const looseNames = [...job.files.values()].map((f) => f.name);
  assert.equal(looseNames.includes('CURRENT'), false);
  assert.equal(looseNames.includes('MANIFEST-000276'), false);
});

test('scan detects a native (ELF) binary folder as an application, even with no extension', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fo-elf-'));
  const app = path.join(root, 'x-ui');
  await fsp.mkdir(app, { recursive: true });
  await fsp.writeFile(path.join(app, 'x-ui'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
  await fsp.writeFile(path.join(app, 'x-ui.service'), 'unit');

  const job = scanJob(root);
  await runScan(job);

  const unit = job.projects.find((p) => p.name === 'x-ui');
  assert.ok(unit, 'the native-binary program folder is kept intact');
  assert.equal(unit.destCategory, 'applications');
  assert.equal(unit.isApplication, true);
});
