'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const RUNS_DIR = path.join(DATA_DIR, 'runs');

async function ensureDirs() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.mkdir(RUNS_DIR, { recursive: true });
}

// ---------- Job snapshots (so an in-progress review survives a server restart) ----------

function serializeJobForDisk(job) {
  return {
    ...job,
    files: [...job.files.entries()],
    duplicateGroups: [...job.duplicateGroups.entries()],
    similarGroups: job.similarGroups || [],
    projects: job.projects || [],
    themedFolders: job.themedFolders || [],
  };
}

function deserializeJobFromDisk(data) {
  return {
    ...data,
    files: new Map(data.files || []),
    duplicateGroups: new Map(data.duplicateGroups || []),
  };
}

let saveQueue = Promise.resolve();

/** Debounced-ish snapshot write - callers just fire-and-forget this after mutations. */
function saveJobSnapshot(job) {
  saveQueue = saveQueue.then(async () => {
    try {
      await ensureDirs();
      const file = path.join(JOBS_DIR, `${job.id}.json`);
      await fsp.writeFile(file, JSON.stringify(serializeJobForDisk(job)));
    } catch (err) {
      console.error('Failed to save job snapshot:', err.message);
    }
  });
  return saveQueue;
}

async function deleteJobSnapshot(jobId) {
  try {
    await fsp.unlink(path.join(JOBS_DIR, `${jobId}.json`));
  } catch {
    // fine if it never existed
  }
}

async function loadAllJobSnapshots() {
  try {
    await ensureDirs();
    const files = await fsp.readdir(JOBS_DIR);
    const jobs = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(JOBS_DIR, f), 'utf8');
        jobs.push(deserializeJobFromDisk(JSON.parse(raw)));
      } catch {
        // skip corrupted snapshot
      }
    }
    return jobs;
  } catch {
    return [];
  }
}

// ---------- Runs: each run gets its own folder holding manifest.json,
// source-tree-before.json (full folder structure right before the move),
// and destination-tree-after.json (full resulting folder structure).
// This is what powers Rollback, and what the user can inspect/download
// even outside the app if they want extra assurance. ----------

function runDir(runId) {
  return path.join(RUNS_DIR, runId);
}

async function createRun() {
  const runId = crypto.randomUUID();
  await fsp.mkdir(runDir(runId), { recursive: true });
  return runId;
}

function treeBeforePath(runId) {
  return path.join(runDir(runId), 'source-tree-before.json');
}

function treeAfterPath(runId) {
  return path.join(runDir(runId), 'destination-tree-after.json');
}

// ---------- Move plan + write-ahead journal (crash durability) ----------
// The full, resolved move plan is written before any file is touched; each op's
// outcome is appended to an NDJSON journal as it completes. A run that has a plan
// but no manifest.json is an interrupted move that must be resumed on startup.

function planPath(runId) {
  return path.join(runDir(runId), 'plan.json');
}

function journalPath(runId) {
  return path.join(runDir(runId), 'journal.ndjson');
}

async function savePlan(runId, plan) {
  await fsp.mkdir(runDir(runId), { recursive: true });
  await fsp.writeFile(planPath(runId), JSON.stringify(plan));
}

async function loadPlan(runId) {
  try {
    return JSON.parse(await fsp.readFile(planPath(runId), 'utf8'));
  } catch {
    return null;
  }
}

async function planExists(runId) {
  try {
    await fsp.access(planPath(runId));
    return true;
  } catch {
    return false;
  }
}

async function manifestExists(runId) {
  try {
    await fsp.access(path.join(runDir(runId), 'manifest.json'));
    return true;
  } catch {
    return false;
  }
}

/** Appends one op-outcome to the journal. appendFile closes the fd each call, so
 *  the entry is flushed to the OS immediately - it survives an app/process crash. */
async function appendJournalEntry(runId, entry) {
  await fsp.mkdir(runDir(runId), { recursive: true });
  await fsp.appendFile(journalPath(runId), JSON.stringify(entry) + '\n');
}

/** Returns a Map of opIndex -> last-known status ('done' | 'error') from the journal. */
async function loadJournal(runId) {
  const map = new Map();
  let raw;
  try {
    raw = await fsp.readFile(journalPath(runId), 'utf8');
  } catch {
    return map;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      map.set(e.i, e.status);
    } catch {
      // ignore a torn last line (e.g. crash mid-write)
    }
  }
  return map;
}

/** Runs that were planned but never finished (plan.json present, manifest.json absent). */
async function listIncompleteRuns() {
  await ensureDirs();
  let ids;
  try {
    ids = await fsp.readdir(RUNS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    if ((await planExists(id)) && !(await manifestExists(id))) out.push(id);
  }
  return out;
}

async function saveManifest(runId, { job, report, treeBeforeStats, treeAfterStats }) {
  await fsp.mkdir(runDir(runId), { recursive: true });
  const manifest = {
    id: runId,
    jobId: job.id,
    timestamp: Date.now(),
    sources: job.sources,
    destination: job.destination,
    report,
    treeBeforeStats: treeBeforeStats || null,
    treeAfterStats: treeAfterStats || null,
    undoneAt: null,
  };
  await fsp.writeFile(path.join(runDir(runId), 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function listRuns() {
  await ensureDirs();
  const runIds = await fsp.readdir(RUNS_DIR);
  const runs = [];
  for (const id of runIds) {
    try {
      const raw = await fsp.readFile(path.join(runDir(id), 'manifest.json'), 'utf8');
      const m = JSON.parse(raw);
      runs.push({
        id: m.id,
        timestamp: m.timestamp,
        sources: m.sources,
        destination: m.destination,
        movedCount: m.report?.moved?.length || 0,
        deletedCount: (m.report?.deleted?.length || 0) + (m.report?.deletedDirs?.length || 0) + (m.report?.deletedFiles?.length || 0),
        projectsMoved: m.report?.projectsMoved?.length || 0,
        themedFoldersMoved: m.report?.themedFoldersMoved?.length || 0,
        treeBeforeStats: m.treeBeforeStats,
        treeAfterStats: m.treeAfterStats,
        undoneAt: m.undoneAt,
        undoResult: m.undoResult || null,
      });
    } catch {
      // skip runs without a readable manifest
    }
  }
  runs.sort((a, b) => b.timestamp - a.timestamp);
  return runs;
}

async function getRun(runId) {
  const raw = await fsp.readFile(path.join(runDir(runId), 'manifest.json'), 'utf8');
  return JSON.parse(raw);
}

/**
 * Records the outcome of an undo attempt. Only stamps `undoneAt` (which blocks any
 * retry) when the reversal was COMPLETE - a partial undo stays retryable and its
 * real outcome is recorded in `undoResult` so the history can never show a
 * half-restored run as if it were fully undone.
 */
async function markRunUndone(runId, undoResult, fullyUndone) {
  const file = path.join(runDir(runId), 'manifest.json');
  const manifest = await getRun(runId);
  manifest.undoResult = {
    restored: undoResult.restored?.length || 0,
    notRestorable: undoResult.notRestorable?.length || 0,
    errors: undoResult.errors?.length || 0,
    permanentlyLostCount: undoResult.permanentlyLostCount || 0,
    at: Date.now(),
  };
  if (fullyUndone) manifest.undoneAt = Date.now();
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2));
}

module.exports = {
  saveJobSnapshot,
  deleteJobSnapshot,
  loadAllJobSnapshots,
  createRun,
  treeBeforePath,
  treeAfterPath,
  saveManifest,
  listRuns,
  getRun,
  markRunUndone,
  planPath,
  journalPath,
  savePlan,
  loadPlan,
  planExists,
  manifestExists,
  appendJournalEntry,
  loadJournal,
  listIncompleteRuns,
};
