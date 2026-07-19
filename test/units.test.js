'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { getExtension, categorizeByExtension, OTHERS } = require('../lib/categorize');
const { groupBySimilarity } = require('../lib/perceptualHash');

test('getExtension handles dotfiles, multi-dot names, and no-extension files', () => {
  assert.equal(getExtension('photo.JPG'), 'jpg');           // lowercased
  assert.equal(getExtension('archive.tar.gz'), 'gz');       // last segment only
  assert.equal(getExtension('.env'), '');                   // dotfile => no extension
  assert.equal(getExtension('.gitignore'), '');
  assert.equal(getExtension('Makefile'), '');               // extensionless
  assert.equal(getExtension('weird.'), '');                 // trailing dot
});

test('categorizeByExtension maps known types and returns null for unknown', () => {
  assert.equal(categorizeByExtension('a.mp3'), 'music');
  assert.equal(categorizeByExtension('a.mkv'), 'video');
  assert.equal(categorizeByExtension('a.pdf'), 'documents');
  assert.equal(categorizeByExtension('a.zip'), 'archives');
  assert.equal(categorizeByExtension('a.qzx'), null);       // unknown -> caller decides (LLM/others)
  assert.notEqual(categorizeByExtension('a.pdf'), OTHERS);
});

test('groupBySimilarity groups near-identical hashes and ignores unique/invalid ones', () => {
  const items = [
    { id: 'a', hash: '0000000000000000' },
    { id: 'b', hash: '0000000000000001' }, // 1 bit from a -> same group
    { id: 'c', hash: 'ffffffffffffffff' }, // far from everything -> no group
    { id: 'd', hash: null },               // no hash -> ignored
  ];
  const groups = groupBySimilarity(items, 6);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sort(), ['a', 'b']);
});
