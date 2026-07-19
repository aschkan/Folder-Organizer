'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { runScan } = require('../lib/scanner');

async function tmpRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'fo-scan-'));
}

function scanJob(sources, overrides = {}) {
  return {
    id: 'test',
    sources,
    destination: path.join(os.tmpdir(), 'unused-dest'),
    useLLM: false,
    ignoreNodeModules: true,
    ignoreJunkFolders: true,
    detectProjects: true,
    detectThemedFolders: false,
    organizeByDate: false,
    organizeByMusicTags: false,
    findSimilarImages: false,
    ...overrides,
  };
}

function names(job) {
  return [...job.files.values()].map((f) => f.name).sort();
}

test('hidden files AND hidden directories are scanned, not silently skipped', async () => {
  const root = await tmpRoot();
  await fsp.writeFile(path.join(root, 'visible.txt'), 'x');
  await fsp.writeFile(path.join(root, '.env'), 'SECRET=1');           // hidden file
  await fsp.mkdir(path.join(root, '.config'), { recursive: true });
  await fsp.writeFile(path.join(root, '.config', 'settings.json'), '{}'); // file in hidden dir

  const job = scanJob([root]);
  await runScan(job);

  assert.equal(job.status, 'done');
  const found = names(job);
  assert.ok(found.includes('visible.txt'));
  assert.ok(found.includes('.env'), 'hidden dotfile must be seen');
  assert.ok(found.includes('settings.json'), 'file inside a hidden directory must be seen');
});

test('.git and OS system folders are still left alone', async () => {
  const root = await tmpRoot();
  await fsp.mkdir(path.join(root, 'real'), { recursive: true });
  await fsp.writeFile(path.join(root, 'real', 'keep.txt'), 'x');
  // a bare .git dir with no project markers - should be skipped, not scanned as files
  await fsp.mkdir(path.join(root, 'real', '.git'), { recursive: true });
  await fsp.writeFile(path.join(root, 'real', '.git', 'HEAD'), 'ref: x');

  const job = scanJob([root], { detectProjects: false });
  await runScan(job);

  const found = names(job);
  assert.ok(found.includes('keep.txt'));
  assert.equal(found.includes('HEAD'), false, '.git internals must never be scanned as loose files');
});

test('a code project is preserved atomically instead of being flattened', async () => {
  const root = await tmpRoot();
  const proj = path.join(root, 'my-app');
  await fsp.mkdir(path.join(proj, 'src'), { recursive: true });
  await fsp.writeFile(path.join(proj, 'package.json'), '{"name":"x"}');
  await fsp.writeFile(path.join(proj, 'src', 'index.js'), 'console.log(1)');

  const job = scanJob([root]);
  await runScan(job);

  assert.equal(job.projects.length, 1, 'the project folder should be detected as one unit');
  assert.equal(job.projects[0].name, 'my-app');
  assert.equal(job.files.size, 0, 'no file inside the project should be listed as a loose file');
});
