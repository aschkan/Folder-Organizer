'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const RULES_FILE = path.join(DATA_DIR, 'learned-rules.json');

let cache = null;

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function loadRules() {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(RULES_FILE, 'utf8');
    cache = JSON.parse(raw);
  } catch {
    cache = {};
  }
  return cache;
}

async function getRuleForExt(ext) {
  if (!ext) return null;
  const rules = await loadRules();
  return rules[ext.toLowerCase()] || null;
}

/** Called whenever a user manually recategorizes a file - remembers ext -> category for future scans. */
async function learnRule(ext, category) {
  if (!ext || !category) return;
  await ensureDataDir();
  const rules = await loadRules();
  rules[ext.toLowerCase()] = category;
  cache = rules;
  try {
    await fsp.writeFile(RULES_FILE, JSON.stringify(rules, null, 2));
  } catch {
    // best-effort persistence - not fatal if it fails
  }
}

async function getAllRules() {
  return loadRules();
}

async function deleteRule(ext) {
  await ensureDataDir();
  const rules = await loadRules();
  delete rules[ext.toLowerCase()];
  cache = rules;
  try {
    await fsp.writeFile(RULES_FILE, JSON.stringify(rules, null, 2));
  } catch {
    // ignore
  }
}

module.exports = { getRuleForExt, learnRule, getAllRules, deleteRule };
