'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isExtractablePersonalFile } = require('../lib/scanner');

// Regression guard: the AI stray-extraction must NEVER pull a program's own files out of
// its folder (which was ripping caches/data/downloads of real programs into "others").
// Only a genuine personal document/photo/media, not inside a program-internal directory,
// may ever be extracted.

test('a program cache file (hash name, no extension) is NEVER extractable', () => {
  assert.equal(isExtractablePersonalFile('cache/api/11210b6f71534c174c1d9efd8d895f06', '11210b6f71534c174c1d9efd8d895f06'), false);
  assert.equal(isExtractablePersonalFile('cache/ai/363ff09da85ed71dfd7cd8bad13ee803', '363ff09da85ed71dfd7cd8bad13ee803'), false);
});

test('program data/log/download/config files are NEVER extractable', () => {
  assert.equal(isExtractablePersonalFile('torch_gpu_live.log', 'torch_gpu_live.log'), false);
  assert.equal(isExtractablePersonalFile('Data/Chinese/generals.csf', 'generals.csf'), false); // game data
  assert.equal(isExtractablePersonalFile('login_files/jquery.min.js.download', 'jquery.min.js.download'), false);
  assert.equal(isExtractablePersonalFile('db/000009.sst', '000009.sst'), false);       // database file
  assert.equal(isExtractablePersonalFile('config.ini', 'config.ini'), false);
  assert.equal(isExtractablePersonalFile('main.py', 'main.py'), false);                  // source code
  assert.equal(isExtractablePersonalFile('weights.onnx', 'weights.onnx'), false);        // model
});

test('a genuine personal document/photo at a normal location IS extractable', () => {
  assert.equal(isExtractablePersonalFile('my-invoice.pdf', 'my-invoice.pdf'), true);
  assert.equal(isExtractablePersonalFile('docs/tax-2024.docx', 'tax-2024.docx'), true);
  assert.equal(isExtractablePersonalFile('vacation.jpg', 'vacation.jpg'), true);
});

test('even a personal-looking file is NOT extractable if it sits in a program-internal dir', () => {
  assert.equal(isExtractablePersonalFile('cache/photo.jpg', 'photo.jpg'), false);
  assert.equal(isExtractablePersonalFile('assets/logo.png', 'logo.png'), false);
  assert.equal(isExtractablePersonalFile('node_modules/pkg/readme.pdf', 'readme.pdf'), false);
  assert.equal(isExtractablePersonalFile('data/report.pdf', 'report.pdf'), false);
});
