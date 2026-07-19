'use strict';

const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const { createJob, getJob, deleteJob, jobs: jobsMap } = require('./lib/jobStore');
const { runScan } = require('./lib/scanner');
const { confirmJob, undoRun } = require('./lib/mover');
const { knownCategories } = require('./lib/categorize');
const { testConnection, DEFAULT_URL, DEFAULT_MODEL } = require('./lib/llm');
const { listDrives } = require('./lib/drives');
const { learnRule, getAllRules, deleteRule } = require('./lib/learnedRules');
const { sharpAvailable } = require('./lib/perceptualHash');
const persistence = require('./lib/persistence');
const { snapshotTreesToFile } = require('./lib/treeSnapshot');

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
  res.json({ perceptualHashing: sharpAvailable });
});

app.post('/api/llm/test', async (req, res) => {
  const { url, model } = req.body || {};
  const result = await testConnection(url || DEFAULT_URL, model || DEFAULT_MODEL);
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
  const list = [...jobsMap.values()]
    .filter((j) => j.status === 'done' || j.status === 'scanning')
    .map((j) => ({ id: j.id, status: j.status, sources: j.sources, destination: j.destination, fileCount: j.files.size, createdAt: j.createdAt }));
  res.json({ jobs: list });
});

app.post('/api/scan', async (req, res) => {
  const {
    sources, destination, useLLM, llmUrl, llmModel,
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
    llmUrl: llmUrl || DEFAULT_URL,
    llmModel: llmModel || DEFAULT_MODEL,
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
  res.json({ status: job.status, progress: job.progress, error: job.error });
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

app.post('/api/scan/:jobId/confirm', async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: 'Job is not ready to confirm yet' });

  job.status = 'moving';
  try {
    const runId = await persistence.createRun();

    // Full snapshot of every source folder exactly as it stands right before we
    // touch anything - this is the "no matter how big" record the rollback and
    // any manual recovery would rely on.
    job.progress.phase = 'snapshotting_before';
    const treeBeforeStats = await snapshotTreesToFile(job.sources, persistence.treeBeforePath(runId));

    const report = await confirmJob(job);
    job.report = report;
    job.status = 'completed';

    // Full snapshot of the resulting destination structure after the move.
    job.progress.phase = 'snapshotting_after';
    const treeAfterStats = await snapshotTreesToFile([job.destination], persistence.treeAfterPath(runId));

    const manifest = await persistence.saveManifest(runId, { job, report, treeBeforeStats, treeAfterStats });
    await persistence.deleteJobSnapshot(job.id);
    res.json({ ok: true, report, runId: manifest.id, treeBeforeStats, treeAfterStats });
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    res.status(500).json({ error: err.message });
  }
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

app.get('/api/runs/:runId/tree/before', (req, res) => {
  res.sendFile(persistence.treeBeforePath(req.params.runId), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Snapshot not found' });
  });
});

app.get('/api/runs/:runId/tree/after', (req, res) => {
  res.sendFile(persistence.treeAfterPath(req.params.runId), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Snapshot not found' });
  });
});

app.post('/api/runs/:runId/undo', async (req, res) => {
  try {
    const manifest = await persistence.getRun(req.params.runId);
    if (manifest.undoneAt) {
      return res.status(400).json({ error: 'This run was already undone.' });
    }
    const result = await undoRun(manifest);
    await persistence.markRunUndone(req.params.runId);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Startup: resume any jobs left mid-review from a previous server run ----------

async function bootstrap() {
  const savedJobs = await persistence.loadAllJobSnapshots();
  for (const job of savedJobs) {
    jobsMap.set(job.id, job);
  }
  if (savedJobs.length > 0) {
    console.log(`Resumed ${savedJobs.length} in-progress scan(s) from the last session.`);
  }

  const PORT = process.env.PORT || 4173;
  app.listen(PORT, () => {
    console.log(`Folder Organizer running at http://localhost:${PORT}`);
  });
}

bootstrap();
