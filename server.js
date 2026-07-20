'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const { createJob, getJob, deleteJob, jobs: jobsMap } = require('./lib/jobStore');
const { runScan } = require('./lib/scanner');
const { buildPlan, executePlan, undoRun } = require('./lib/mover');
const { knownCategories } = require('./lib/categorize');
const { testConnection, DEFAULT_URL, DEFAULT_MODEL, DEFAULT_PROVIDER, PROVIDERS } = require('./lib/llm');
const { listDrives } = require('./lib/drives');
const { learnRule, getAllRules, deleteRule } = require('./lib/learnedRules');
const { sharpAvailable } = require('./lib/perceptualHash');
const persistence = require('./lib/persistence');
const { snapshotTreesToFile, streamSnapshot } = require('./lib/treeSnapshot');
const { logJob } = require('./lib/jobLog');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const THUMBNAIL_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);

// ---------- Folder browsing ----------

app.get('/api/browse', async (req, res) => {
  const dir = req.query.dir || os.homedir();
  try {
    const resolved = path.resolve(dir);
    const stat = await fsp.stat(resolved);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(resolved);

    res.json({
      current: resolved,
      parent: parent === resolved ? null : parent,
      entries: dirs,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/drives', async (req, res) => {
  try {
    const drives = await listDrives();
    res.json({ drives, homeDir: os.homedir() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Capabilities / LLM test ----------

app.get('/api/capabilities', (req, res) => {
  res.json({
    perceptualHashing: sharpAvailable,
    // Local LLM backends the user can choose from, with their default URLs.
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, defaultUrl: p.defaultUrl })),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
});

app.post('/api/llm/test', async (req, res) => {
  const { provider, url, model } = req.body || {};
  const result = await testConnection({ provider: provider || DEFAULT_PROVIDER, url: url || DEFAULT_URL, model: model || DEFAULT_MODEL });
  res.json(result);
});

// ---------- Categories & learned rules ----------

app.get('/api/categories', (req, res) => {
  res.json({ categories: knownCategories() });
});

app.get('/api/rules', async (req, res) => {
  res.json({ rules: await getAllRules() });
});

app.delete('/api/rules/:ext', async (req, res) => {
  await deleteRule(req.params.ext);
  res.json({ ok: true });
});

// ---------- Scan lifecycle ----------

app.get('/api/scan', (req, res) => {
  const RESUMABLE = new Set(['done', 'scanning', 'moving', 'pending']);
  const list = [...jobsMap.values()]
    .filter((j) => RESUMABLE.has(j.status))
    .map((j) => ({ id: j.id, status: j.status, sources: j.sources, destination: j.destination, fileCount: j.files.size, createdAt: j.createdAt }));
  res.json({ jobs: list });
});

app.post('/api/scan', async (req, res) => {
  const {
    sources, destination, useLLM, llmProvider, llmUrl, llmModel, aiExtractStrays,
    ignoreNodeModules, ignoreJunkFolders, detectProjects, detectThemedFolders,
    organizeByDate, organizeByMusicTags, findSimilarImages,
  } = req.body || {};

  if (!Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: 'At least one source folder is required.' });
  }
  if (!destination) {
    return res.status(400).json({ error: 'A destination folder is required.' });
  }

  const resolvedSources = sources.map((s) => path.resolve(s));
  const resolvedDest = path.resolve(destination);

  for (const src of resolvedSources) {
    if (resolvedDest === src || resolvedDest.startsWith(src + path.sep)) {
      return res.status(400).json({ error: `Destination cannot be inside source folder: ${src}` });
    }
  }

  for (const p of [...resolvedSources, resolvedDest]) {
    try {
      await fsp.access(p);
    } catch {
      return res.status(400).json({ error: `Folder does not exist or is not accessible: ${p}` });
    }
  }

  const job = createJob({
    id: crypto.randomUUID(),
    status: 'pending',
    sources: resolvedSources,
    destination: resolvedDest,
    useLLM: !!useLLM,
    llmProvider: llmProvider || DEFAULT_PROVIDER,
    llmUrl: llmUrl || DEFAULT_URL,
    llmModel: llmModel || DEFAULT_MODEL,
    aiExtractStrays: aiExtractStrays !== false, // default ON when the LLM is enabled

    ignoreNodeModules: !!ignoreNodeModules,
    ignoreJunkFolders: !!ignoreJunkFolders,
    detectProjects: detectProjects !== false, // default ON - this is the safety-critical one
    detectThemedFolders: detectThemedFolders !== false, // default ON - keeps human-organized folders together
    organizeByDate: !!organizeByDate,
    organizeByMusicTags: !!organizeByMusicTags,
    findSimilarImages: !!findSimilarImages && sharpAvailable,
    progress: { phase: 'pending', filesFound: 0, filesProcessed: 0 },
    files: new Map(),
    duplicateGroups: new Map(),
    similarGroups: [],
    projects: [],
    themedFolders: [],
    error: null,
    createdAt: Date.now(),
    report: null,
  });

  runScan(job).then(() => persistence.saveJobSnapshot(job));

  res.json({ jobId: job.id });
});

app.get('/api/scan/:jobId/status', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,
    progress: job.progress,
    error: job.error,
    log: (job.log || []).slice(-200),
    runId: job.runId || null,
    // Once a move finishes, hand the report straight back through the poll so the
    // frontend can render the report view without a second round-trip.
    report: job.status === 'completed' ? job.report : null,
    treeBeforeStats: job.treeBeforeStats || null,
    treeAfterStats: job.treeAfterStats || null,
  });
});

function serializeJob(job) {
  const files = [...job.files.values()].map((f) => ({
    id: f.id,
    name: f.name,
    ext: f.ext,
    absPath: f.absPath,
    sourceRoot: f.sourceRoot,
    relPath: f.relPath,
    size: f.size,
    mtime: f.mtime,
    category: f.category,
    subPath: f.subPath,
    excluded: f.excluded,
    duplicateGroupId: f.duplicateGroupId,
    similarGroupId: f.similarGroupId,
    themedFolderId: f.themedFolderId || null,
    hasThumbnail: THUMBNAIL_EXTS.has(f.ext),
  }));

  const duplicateGroups = [...job.duplicateGroups.values()].map((g) => ({
    id: g.id,
    size: g.size,
    fileIds: g.fileIds,
    resolution: g.resolution,
  }));

  return {
    id: job.id,
    status: job.status,
    sources: job.sources,
    destination: job.destination,
    progress: job.progress,
    files,
    duplicateGroups,
    similarGroups: job.similarGroups || [],
    projects: job.projects || [],
    themedFolders: job.themedFolders || [],
    ignoreNodeModules: job.ignoreNodeModules,
    ignoreJunkFolders: job.ignoreJunkFolders,
    detectProjects: job.detectProjects,
    detectThemedFolders: job.detectThemedFolders,
    organizeByDate: job.organizeByDate,
    organizeByMusicTags: job.organizeByMusicTags,
    findSimilarImages: job.findSimilarImages,
    ignoredNodeModulesDirs: job.ignoredNodeModulesDirs || [],
    ignoredJunkDirs: job.ignoredJunkDirs || [],
    ignoredJunkFiles: job.ignoredJunkFiles || [],
    report: job.report,
  };
}

app.get('/api/scan/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(serializeJob(job));
});

// ---------- Thumbnails ----------

app.get('/api/scan/:jobId/files/:fileId/thumbnail', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).end();
  const file = job.files.get(req.params.fileId);
  if (!file || !THUMBNAIL_EXTS.has(file.ext)) return res.status(404).end();
  res.sendFile(file.absPath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------- CRUD on scanned files ----------

app.put('/api/scan/:jobId/files/:fileId', async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const file = job.files.get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const { category, excluded } = req.body || {};
  if (typeof category === 'string' && category.trim()) {
    file.category = category.trim().toLowerCase().replace(/\s+/g, '_');
    if (file.ext) await learnRule(file.ext, file.category); // remember this choice for next time
  }
  if (typeof excluded === 'boolean') {
    file.excluded = excluded;
  }
  persistence.saveJobSnapshot(job);
  res.json({ ok: true, file });
});

app.delete('/api/scan/:jobId/files/:fileId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const file = job.files.get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  file.excluded = true;
  persistence.saveJobSnapshot(job);
  res.json({ ok: true });
});

app.post('/api/scan/:jobId/files/bulk-category', async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { fileIds, category } = req.body || {};
  if (!Array.isArray(fileIds) || !category) return res.status(400).json({ error: 'fileIds and category required' });
  const normalized = category.trim().toLowerCase().replace(/\s+/g, '_');
  let updated = 0;
  for (const id of fileIds) {
    const file = job.files.get(id);
    if (file) {
      file.category = normalized;
      if (file.ext) await learnRule(file.ext, normalized);
      updated += 1;
    }
  }
  persistence.saveJobSnapshot(job);
  res.json({ ok: true, updated });
});

app.post('/api/scan/:jobId/files/bulk-exclude', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { fileIds, excluded } = req.body || {};
  if (!Array.isArray(fileIds)) return res.status(400).json({ error: 'fileIds required' });
  let updated = 0;
  for (const id of fileIds) {
    const file = job.files.get(id);
    if (file) {
      file.excluded = !!excluded;
      updated += 1;
    }
  }
  persistence.saveJobSnapshot(job);
  res.json({ ok: true, updated });
});

// ---------- Detected project folders ----------

app.put('/api/scan/:jobId/projects/:projectId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const project = (job.projects || []).find((p) => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { excluded } = req.body || {};
  if (typeof excluded === 'boolean') project.excluded = excluded;
  persistence.saveJobSnapshot(job);
  res.json({ ok: true, project });
});

// ---------- Detected themed folders (e.g. "2026 Birthday Photos") ----------

app.put('/api/scan/:jobId/themed-folders/:folderId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const folder = (job.themedFolders || []).find((f) => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'Themed folder not found' });
  const { excluded } = req.body || {};
  if (typeof excluded === 'boolean') folder.excluded = excluded;
  persistence.saveJobSnapshot(job);
  res.json({ ok: true, folder });
});

// ---------- Duplicate resolution ----------

app.put('/api/scan/:jobId/duplicates/:groupId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const group = job.duplicateGroups.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Duplicate group not found' });

  const { type, keepId } = req.body || {};
  if (type === 'merge') {
    if (!group.fileIds.includes(keepId)) {
      return res.status(400).json({ error: 'keepId must be one of this group\'s files' });
    }
    group.resolution = { type: 'merge', keepId };
  } else if (type === 'keep_all') {
    group.resolution = { type: 'keep_all' };
  } else {
    return res.status(400).json({ error: 'type must be "merge" or "keep_all"' });
  }
  persistence.saveJobSnapshot(job);
  res.json({ ok: true, group });
});

// ---------- Confirm & execute ----------

/**
 * Runs the actual move in the background so the frontend can poll for live
 * progress and a log. Fully journaled and crash-resumable: the resolved plan is
 * written before any file is touched, each op's outcome is journaled as it
 * completes, and the undo manifest is written the moment the moves finish.
 */
async function runMove(job, runId) {
  try {
    job.progress = { phase: 'planning', moved: 0, total: 0 };
    logJob(job, 'Building the move plan…');
    const plan = await buildPlan(job);
    await persistence.savePlan(runId, {
      ...plan, jobId: job.id, sources: job.sources, destination: job.destination, createdAt: Date.now(),
    });
    job.progress = { phase: 'snapshotting_before', moved: 0, total: plan.ops.length };
    logJob(job, `Plan ready: ${plan.ops.length} operation(s). Snapshotting source structure…`);
    persistence.saveJobSnapshot(job);

    let treeBeforeStats = null;
    try {
      treeBeforeStats = await snapshotTreesToFile(job.sources, persistence.treeBeforePath(runId));
    } catch (snapErr) {
      logJob(job, `Before-snapshot failed (continuing): ${snapErr.message}`, 'warn');
    }

    job.progress.phase = 'moving';
    logJob(job, 'Moving files…');
    const report = await executePlan(plan, {
      appendJournal: (entry) => persistence.appendJournalEntry(runId, entry),
      onProgress: (processed, total) => {
        job.progress.moved = processed;
        job.progress.total = total;
        if (processed === total || processed % 25 === 0) {
          logJob(job, `${processed}/${total} operation(s) done…`);
          persistence.saveJobSnapshot(job);
        }
      },
    });
    job.report = report;

    // Persist the undo manifest IMMEDIATELY (rollback depends only on this).
    job.progress.phase = 'finalizing';
    let manifest = await persistence.saveManifest(runId, { job, report, treeBeforeStats, treeAfterStats: null });
    await persistence.deleteJobSnapshot(job.id);

    // After-snapshot is inspection-only and therefore best-effort.
    let treeAfterStats = null;
    try {
      job.progress.phase = 'snapshotting_after';
      treeAfterStats = await snapshotTreesToFile([job.destination], persistence.treeAfterPath(runId));
      manifest = await persistence.saveManifest(runId, { job, report, treeBeforeStats, treeAfterStats });
    } catch (snapErr) {
      logJob(job, `After-snapshot failed (run still recorded and reversible): ${snapErr.message}`, 'warn');
    }

    job.treeBeforeStats = treeBeforeStats;
    job.treeAfterStats = treeAfterStats;
    job.runId = manifest.id;
    job.status = 'completed';
    job.progress.phase = 'done';
    const deletedTotal = report.deleted.length + report.deletedDirs.length + report.deletedFiles.length;
    logJob(job, `Done. Moved ${report.moved.length}, deleted ${deletedTotal}, errors ${report.errors.length}.`);
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    logJob(job, `Move failed: ${err.message}`, 'error');
    persistence.saveJobSnapshot(job);
  }
}

app.post('/api/scan/:jobId/confirm', async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'Job is not ready to confirm yet' });

  job.status = 'moving';
  job.progress = { phase: 'planning', moved: 0, total: 0 };
  const runId = await persistence.createRun();
  job.runId = runId;
  logJob(job, 'Confirm received.');
  persistence.saveJobSnapshot(job);

  // Respond immediately; the client polls /status for progress + log and the final report.
  res.json({ ok: true, runId, started: true });

  runMove(job, runId);
});

app.delete('/api/scan/:jobId', async (req, res) => {
  deleteJob(req.params.jobId);
  await persistence.deleteJobSnapshot(req.params.jobId);
  res.json({ ok: true });
});

// ---------- Run history & undo ----------

app.get('/api/runs', async (req, res) => {
  try {
    res.json({ runs: await persistence.listRuns() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:runId', async (req, res) => {
  try {
    res.json(await persistence.getRun(req.params.runId));
  } catch (err) {
    res.status(404).json({ error: 'Run not found' });
  }
});

async function serveSnapshot(indexFile, res) {
  try {
    const served = await streamSnapshot(indexFile, res);
    if (!served && !res.headersSent) res.status(404).json({ error: 'Snapshot not found' });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
}

// Reconstructs the (possibly chunked) snapshot into one logical JSON tree, streamed
// chunk-by-chunk so the server never buffers a giant file in memory.
app.get('/api/runs/:runId/tree/before', (req, res) => {
  serveSnapshot(persistence.treeBeforePath(req.params.runId), res);
});

app.get('/api/runs/:runId/tree/after', (req, res) => {
  serveSnapshot(persistence.treeAfterPath(req.params.runId), res);
});

app.post('/api/runs/:runId/undo', async (req, res) => {
  try {
    const manifest = await persistence.getRun(req.params.runId);
    if (manifest.undoneAt) {
      return res.status(400).json({ error: 'This run was already undone.' });
    }
    const result = await undoRun(manifest);
    // A run only counts as fully undone when every recorded move was reversed.
    // Otherwise we leave it retryable (undoneAt stays null) and report the truth.
    const fullyUndone = result.errors.length === 0 && result.notRestorable.length === 0;
    await persistence.markRunUndone(req.params.runId, result, fullyUndone);
    res.json({ ok: true, result, fullyUndone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Startup: resume anything left unfinished by a crash/power loss ----------

/**
 * Finishes any move that was interrupted mid-flight. A run with a plan but no
 * manifest is incomplete: we replay only the ops the journal hasn't marked done
 * (execution is idempotent for the rest), then write the manifest so the run
 * becomes fully recorded and reversible - exactly as if it had never stopped.
 */
async function resumeIncompleteRuns() {
  let incomplete = [];
  try {
    incomplete = await persistence.listIncompleteRuns();
  } catch {
    return;
  }
  for (const runId of incomplete) {
    const plan = await persistence.loadPlan(runId);
    if (!plan || !Array.isArray(plan.ops)) continue;
    try {
      const journal = await persistence.loadJournal(runId);
      const done = new Set([...journal.entries()].filter(([, s]) => s === 'done').map(([i]) => i));
      console.log(`Resuming interrupted move ${runId}: ${done.size}/${plan.ops.length} op(s) already applied.`);

      const job = jobsMap.get(plan.jobId);
      if (job) { job.status = 'moving'; job.runId = runId; job.progress = { phase: 'moving', moved: done.size, total: plan.ops.length }; logJob(job, 'Resuming interrupted move after restart…', 'warn'); }

      const report = await executePlan(plan, {
        journalCompleted: done,
        appendJournal: (entry) => persistence.appendJournalEntry(runId, entry),
        onProgress: (processed, total) => {
          if (job) { job.progress.moved = processed; job.progress.total = total; }
        },
      });

      const pseudoJob = { id: plan.jobId, sources: plan.sources || [], destination: plan.destination };
      let treeAfterStats = null;
      await persistence.saveManifest(runId, { job: pseudoJob, report, treeBeforeStats: null, treeAfterStats: null });
      try {
        treeAfterStats = await snapshotTreesToFile([plan.destination], persistence.treeAfterPath(runId));
        await persistence.saveManifest(runId, { job: pseudoJob, report, treeBeforeStats: null, treeAfterStats });
      } catch { /* inspection-only */ }

      if (job) {
        job.report = report;
        job.treeAfterStats = treeAfterStats;
        job.status = 'completed';
        job.progress.phase = 'done';
        logJob(job, `Resumed move finished. Moved ${report.moved.length}, errors ${report.errors.length}.`);
        await persistence.deleteJobSnapshot(job.id);
      }
      console.log(`Resumed move ${runId} completed: moved ${report.moved.length}, errors ${report.errors.length}.`);
    } catch (err) {
      console.error(`Failed to resume move ${runId}:`, err.message);
    }
  }
}

async function bootstrap() {
  const savedJobs = await persistence.loadAllJobSnapshots();
  for (const job of savedJobs) {
    jobsMap.set(job.id, job);
  }

  for (const job of savedJobs) {
    if (job.status === 'scanning' || job.status === 'pending') {
      // A scan is read-only, so re-running it from scratch is always safe.
      logJob(job, 'Resuming interrupted scan after restart.', 'warn');
      job.status = 'scanning';
      runScan(job).then(() => persistence.saveJobSnapshot(job)).catch(() => {});
    } else if (job.status === 'moving') {
      // If no plan hit disk, nothing was moved yet - make it re-confirmable.
      if (!job.runId || !(await persistence.planExists(job.runId))) {
        job.status = 'done';
        logJob(job, 'Interrupted before any file moved - ready to confirm again.', 'warn');
        persistence.saveJobSnapshot(job);
      }
      // Otherwise resumeIncompleteRuns() below finishes it.
    }
  }
  if (savedJobs.length > 0) {
    console.log(`Loaded ${savedJobs.length} in-progress job(s) from the last session.`);
  }

  const PORT = process.env.PORT || 4173;
  app.listen(PORT, () => {
    console.log(`Folder Organizer running at http://localhost:${PORT}`);
    resumeIncompleteRuns().catch((err) => console.error('Resume sweep failed:', err.message));
  });
}

bootstrap();
