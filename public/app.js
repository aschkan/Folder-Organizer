'use strict';

// ---------- State ----------
let sources = [];
let destination = null;
let jobId = null;
let jobData = null;
let categories = [];
let capabilities = { perceptualHashing: false };
let browseTarget = null;
let browsePath = null;
let drives = null;
let pollTimer = null;
let lastRunId = null;
let searchTerm = '';
const selectedFileIds = new Set();
const openCategoryBlocks = new Set();

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showToast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString();
}

function showView(name) {
  for (const v of ['setup', 'progress', 'results', 'report', 'history']) {
    $(`#view-${v}`).classList.toggle('hidden', v !== name);
  }
}

// ---------- Setup view: sources / destination ----------

function renderSetup() {
  const list = $('#source-list');
  list.innerHTML = '';
  sources.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.innerHTML = `<span class="path">${s}</span><button class="remove" title="Remove">&times;</button>`;
    row.querySelector('.remove').addEventListener('click', () => {
      sources.splice(idx, 1);
      renderSetup();
    });
    list.appendChild(row);
  });
  $('#source-count').textContent = sources.length;
  $('#source-empty').classList.toggle('hidden', sources.length > 0);

  const destList = $('#destination-list');
  destList.innerHTML = '';
  if (destination) {
    const row = document.createElement('div');
    row.className = 'folder-row';
    row.innerHTML = `<span class="path">${destination}</span><button class="remove" title="Remove">&times;</button>`;
    row.querySelector('.remove').addEventListener('click', () => {
      destination = null;
      renderSetup();
    });
    destList.appendChild(row);
  }
  $('#destination-empty').classList.toggle('hidden', !!destination);

  $('#btn-start-scan').disabled = !(sources.length > 0 && destination);
}

$('#btn-add-source').addEventListener('click', () => openBrowseModal('source'));
$('#btn-choose-destination').addEventListener('click', () => openBrowseModal('destination'));

$('#use-llm').addEventListener('change', (e) => {
  $('#llm-settings').classList.toggle('hidden', !e.target.checked);
});

$('#btn-test-llm').addEventListener('click', async () => {
  const url = $('#llm-url').value.trim();
  const model = $('#llm-model').value.trim();
  $('#llm-test-result').textContent = 'Testing...';
  try {
    const result = await api('POST', '/api/llm/test', { url, model });
    $('#llm-test-result').textContent = result.ok
      ? `Connected. Sample reply: "${(result.sample || '').slice(0, 60)}"`
      : `Failed: ${result.error}`;
  } catch (err) {
    $('#llm-test-result').textContent = `Failed: ${err.message}`;
  }
});

// ---------- Resume banner ----------

async function checkResumableJobs() {
  try {
    const { jobs } = await api('GET', '/api/scan');
    if (!jobs || jobs.length === 0) return;
    const j = jobs[jobs.length - 1];
    const statusLabel = j.status === 'moving' ? 'a move is in progress' :
      j.status === 'scanning' ? 'scanning' :
      j.status === 'completed' ? 'finished' : 'waiting for review';
    $('#resume-text').textContent =
      `A run over ${j.sources.length} source folder${j.sources.length === 1 ? '' : 's'} → ${j.destination} ` +
      `(${j.fileCount} files, ${statusLabel}) can be resumed.`;
    $('#resume-banner').classList.remove('hidden');
    $('#btn-resume').onclick = async () => {
      jobId = j.id;
      $('#resume-banner').classList.add('hidden');
      if (j.status === 'scanning' || j.status === 'moving' || j.status === 'pending') {
        renderLog([]);
        showView('progress');
        pollStatus();
      } else if (j.status === 'completed') {
        const status = await api('GET', `/api/scan/${jobId}/status`);
        lastRunId = status.runId;
        renderReport(status.report, status.runId, status.treeBeforeStats, status.treeAfterStats);
        showView('report');
      } else {
        await loadResults();
      }
    };
  } catch {
    // fine - resume is best-effort
  }
}

$('#btn-dismiss-resume').addEventListener('click', () => {
  $('#resume-banner').classList.add('hidden');
});

// ---------- Folder browser modal ----------

function openBrowseModal(target) {
  browseTarget = target;
  $('#browse-title').textContent = target === 'source' ? 'Choose a source folder' : 'Choose the destination folder';
  $('#browse-modal').classList.remove('hidden');
  (async () => {
    if (!drives) await loadDrives();
    renderDriveChips();
    loadBrowseDir(browsePath);
  })();
}

async function loadDrives() {
  try {
    const data = await api('GET', '/api/drives');
    drives = data.drives || [];
  } catch {
    drives = [];
  }
}

function renderDriveChips() {
  const row = $('#browse-drives');
  row.innerHTML = '';
  (drives || []).forEach((d) => {
    const chip = document.createElement('div');
    chip.className = 'drive-chip';
    chip.textContent = d.name;
    chip.title = d.path;
    chip.classList.toggle('active', browsePath && browsePath.toLowerCase().startsWith(d.path.toLowerCase().replace(/[\\/]+$/, '')));
    chip.addEventListener('click', () => loadBrowseDir(d.path));
    row.appendChild(chip);
  });
  if (!drives || drives.length === 0) {
    row.innerHTML = '<span class="empty-hint">No extra drives detected — use the path box below if you need one.</span>';
  }
}

$('#browse-manual-go').addEventListener('click', () => {
  const val = $('#browse-manual-path').value.trim();
  if (val) loadBrowseDir(val);
});
$('#browse-manual-path').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#browse-manual-go').click();
});

async function loadBrowseDir(dir) {
  try {
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : '';
    const data = await api('GET', `/api/browse${qs}`);
    browsePath = data.current;
    $('#browse-current').textContent = data.current;
    const list = $('#browse-list');
    list.innerHTML = '';
    if (data.entries.length === 0) {
      list.innerHTML = '<div class="dir-item empty-hint">No subfolders here.</div>';
    }
    data.entries.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'dir-item';
      item.innerHTML = `<span class="icon">&#128193;</span><span>${entry.name}</span>`;
      item.addEventListener('click', () => loadBrowseDir(entry.path));
      list.appendChild(item);
    });
    $('#browse-up').disabled = !data.parent;
    $('#browse-up').onclick = () => data.parent && loadBrowseDir(data.parent);
    $('#browse-manual-path').value = '';
    renderDriveChips();
  } catch (err) {
    showToast(err.message, true);
  }
}

$('#browse-cancel').addEventListener('click', () => {
  $('#browse-modal').classList.add('hidden');
});

$('#browse-select').addEventListener('click', () => {
  if (!browsePath) return;
  if (browseTarget === 'source') {
    if (!sources.includes(browsePath)) sources.push(browsePath);
  } else {
    destination = browsePath;
  }
  $('#browse-modal').classList.add('hidden');
  renderSetup();
});

// ---------- Scan lifecycle ----------

$('#btn-start-scan').addEventListener('click', async () => {
  try {
    const body = {
      sources,
      destination,
      useLLM: $('#use-llm').checked,
      llmUrl: $('#llm-url').value.trim(),
      llmModel: $('#llm-model').value.trim(),
      detectProjects: $('#detect-projects').checked,
      detectThemedFolders: $('#detect-themed-folders').checked,
      ignoreNodeModules: $('#ignore-node-modules').checked,
      ignoreJunkFolders: $('#ignore-junk-folders').checked,
      organizeByDate: $('#organize-by-date').checked,
      organizeByMusicTags: $('#organize-by-music-tags').checked,
      findSimilarImages: $('#find-similar-images').checked,
    };
    const { jobId: id } = await api('POST', '/api/scan', body);
    jobId = id;
    showView('progress');
    pollStatus();
  } catch (err) {
    showToast(err.message, true);
  }
});

const PHASE_LABELS = {
  pending: 'Getting ready…',
  listing: 'Listing files & detecting projects…',
  categorizing: 'Categorizing files…',
  metadata: 'Reading photo/music metadata…',
  polishing: 'Asking the LLM to review & polish every file…',
  hashing: 'Checking for duplicates…',
  similarity: 'Comparing photos for near-duplicates…',
  planning: 'Building the move plan…',
  snapshotting_before: 'Snapshotting your folders (for rollback)…',
  moving: 'Moving files…',
  finalizing: 'Recording the run…',
  snapshotting_after: 'Snapshotting the result…',
  done: 'Finishing up…',
};

function renderLog(entries) {
  const el = $('#progress-log');
  if (!el) return;
  const list = entries || [];
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = list.map((e) => {
    const time = new Date(e.t).toLocaleTimeString();
    const cls = e.level === 'error' ? 'log-error' : (e.level === 'warn' ? 'log-warn' : '');
    return `<div class="log-line ${cls}"><span class="log-time">${time}</span>${escapeHtml(e.msg)}</div>`;
  }).join('');
  $('#progress-log-count').textContent = list.length ? `${list.length} event(s)` : '';
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function pollStatus() {
  clearTimeout(pollTimer);
  try {
    const status = await api('GET', `/api/scan/${jobId}/status`);
    const phase = status.progress?.phase || status.status;
    const isMoving = status.status === 'moving' || ['planning', 'snapshotting_before', 'moving', 'finalizing', 'snapshotting_after'].includes(phase);

    $('#progress-phase').textContent = PHASE_LABELS[phase] || (isMoving ? 'Moving files…' : 'Working…');
    renderLog(status.log);

    if (isMoving) {
      const moved = status.progress?.moved || 0;
      const total = status.progress?.total || 0;
      const pct = total > 0 ? Math.min(100, Math.round((moved / total) * 100)) : 5;
      $('#progress-fill').style.width = `${pct}%`;
      $('#progress-text').textContent = total > 0 ? `${moved} / ${total} operations` : 'Preparing…';
    } else {
      const found = status.progress?.filesFound || 0;
      const processed = status.progress?.filesProcessed || 0;
      const pct = found > 0 ? Math.min(100, Math.round((processed / found) * 100)) : (phase === 'listing' ? 5 : 0);
      $('#progress-fill').style.width = `${pct}%`;
      $('#progress-text').textContent = `${found} file${found === 1 ? '' : 's'} found${processed ? `, ${processed} categorized` : ''}`;
    }

    if (status.status === 'completed') {
      // A move finished - the report came back with the poll.
      lastRunId = status.runId || lastRunId;
      renderReport(status.report, status.runId, status.treeBeforeStats, status.treeAfterStats);
      showView('report');
    } else if (status.status === 'done') {
      await loadResults();
    } else if (status.status === 'error') {
      showToast(`Failed: ${status.error}`, true);
      renderLog(status.log);
      showView('setup');
    } else {
      pollTimer = setTimeout(pollStatus, 700);
    }
  } catch (err) {
    showToast(err.message, true);
    showView('setup');
  }
}

async function loadResults() {
  jobData = await api('GET', `/api/scan/${jobId}`);
  const catRes = await api('GET', '/api/categories');
  categories = catRes.categories;
  selectedFileIds.clear();
  searchTerm = '';
  $('#file-search').value = '';
  renderResults();
  showView('results');
}

// ---------- Results view ----------

function renderResults() {
  renderSummary();
  renderProjects();
  renderThemedFolders();
  renderDuplicates();
  renderSimilar();
  renderJunkList();
  renderBulkCategoryOptions();
  renderCategories();
  renderDeletionWarning();
  updateBulkToolbar();
}

function renderSummary() {
  const grid = $('#summary-grid');
  grid.innerHTML = '';
  const counts = {};
  let total = 0;
  let excluded = 0;
  for (const f of jobData.files) {
    if (!f.excluded) {
      counts[f.category] = (counts[f.category] || 0) + 1;
      total += 1;
    } else {
      excluded += 1;
    }
  }
  const activeProjects = jobData.projects.filter((p) => !p.excluded).length;
  const cards = [
    { n: total, l: 'files to move' },
    { n: activeProjects, l: 'projects (kept intact)' },
    { n: jobData.duplicateGroups.length, l: 'duplicate groups' },
    { n: excluded, l: 'excluded' },
  ];
  const junkTotal = (jobData.ignoredNodeModulesDirs?.length || 0) + (jobData.ignoredJunkDirs?.length || 0) + (jobData.ignoredJunkFiles?.length || 0);
  if (junkTotal > 0) cards.push({ n: junkTotal, l: 'junk items to delete' });
  if (jobData.similarGroups?.length) cards.push({ n: jobData.similarGroups.length, l: 'similar photo groups' });
  cards.push(...Object.entries(counts).map(([cat, n]) => ({ n, l: cat.replace(/_/g, ' ') })));

  for (const c of cards) {
    const div = document.createElement('div');
    div.className = 'summary-card';
    div.innerHTML = `<div class="n">${c.n}</div><div class="l">${c.l}</div>`;
    grid.appendChild(div);
  }
}

function fileById(id) {
  return jobData.files.find((f) => f.id === id);
}

// ---------- Detected projects ----------

function renderProjects() {
  const panel = $('#projects-panel');
  const projects = jobData.projects || [];
  panel.classList.toggle('hidden', projects.length === 0);
  $('#proj-count').textContent = projects.length;
  const list = $('#projects-list');
  list.innerHTML = '';

  projects.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'project-card';
    const junkSummary = (p.junkDirsFound || []).map((j) => j.path.split('/').pop() || j.path.split('\\').pop()).join(', ');
    card.innerHTML = `
      <div class="p-head">
        <div><span class="p-name">${p.name}</span><span class="p-type">${p.type}</span></div>
        <label class="p-exclude"><input type="checkbox" class="proj-exclude" ${p.excluded ? 'checked' : ''}> Leave in source (don't move)</label>
      </div>
      <div class="p-meta">${p.relPath} &middot; ~${formatSize(p.sizeBytes)} &middot; marker: ${p.markerFile} &middot; &rarr; ${(p.destCategory || 'coded_programs').replace(/_/g, ' ')}/</div>
      ${junkSummary ? `<div class="p-junk">Will delete: ${junkSummary}</div>` : ''}
    `;
    card.querySelector('.proj-exclude').addEventListener('change', async (e) => {
      try {
        await api('PUT', `/api/scan/${jobId}/projects/${p.id}`, { excluded: e.target.checked });
        p.excluded = e.target.checked;
        renderSummary();
        renderDeletionWarning();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    list.appendChild(card);
  });
}

// ---------- Detected themed (human-organized) folders ----------

function renderThemedFolders() {
  const panel = $('#themed-panel');
  const folders = jobData.themedFolders || [];
  panel.classList.toggle('hidden', folders.length === 0);
  $('#themed-count').textContent = folders.length;
  const list = $('#themed-list');
  list.innerHTML = '';

  folders.forEach((tf) => {
    const strayFiles = (tf.minorityFileIds || []).map(fileById).filter(Boolean);
    const card = document.createElement('div');
    card.className = 'project-card';
    const strayList = strayFiles.map((f) => `${f.name} → ${f.category.replace(/_/g, ' ')}`).join(', ');
    card.innerHTML = `
      <div class="p-head">
        <div><span class="p-name">${tf.name}</span><span class="p-type">${tf.dominantCategory.replace(/_/g, ' ')}</span></div>
        <label class="p-exclude"><input type="checkbox" class="themed-exclude" ${tf.excluded ? 'checked' : ''}> Leave in source (don't move)</label>
      </div>
      <div class="p-meta">${tf.relPath} &middot; ${tf.dominantCount}/${tf.totalFiles} files are ${tf.dominantCategory.replace(/_/g, ' ')}</div>
      ${strayList ? `<div class="p-junk">Pulled out and re-sorted: ${strayList}</div>` : ''}
    `;
    card.querySelector('.themed-exclude').addEventListener('change', async (e) => {
      try {
        await api('PUT', `/api/scan/${jobId}/themed-folders/${tf.id}`, { excluded: e.target.checked });
        tf.excluded = e.target.checked;
        renderResults();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    list.appendChild(card);
  });
}

// ---------- Deletion warning (always visible, not just a confirm() popup) ----------

function renderDeletionWarning() {
  const panel = $('#deletion-warning');
  const list = $('#deletion-warning-list');

  let dupDeleteCount = 0;
  for (const g of jobData.duplicateGroups) {
    if ((g.resolution?.type || 'keep_all') === 'merge') {
      dupDeleteCount += g.fileIds.length - 1;
    }
  }
  const junkTotal = (jobData.ignoredNodeModulesDirs?.length || 0) + (jobData.ignoredJunkDirs?.length || 0) + (jobData.ignoredJunkFiles?.length || 0);
  const projectJunkTotal = (jobData.projects || []).filter((p) => !p.excluded).reduce((s, p) => s + (p.junkDirsFound?.length || 0), 0);

  const lines = [];
  if (dupDeleteCount > 0) lines.push(`${dupDeleteCount} duplicate file(s) will be deleted (you chose "merge" for one or more groups)`);
  if (junkTotal > 0) lines.push(`${junkTotal} junk folder/file(s) will be deleted (node_modules, build caches, OS junk files)`);
  if (projectJunkTotal > 0) lines.push(`${projectJunkTotal} junk folder(s) inside detected projects will be deleted`);

  if (lines.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  list.innerHTML = lines.map((l) => `<div>&bull; ${l}</div>`).join('');
}

function renderDuplicates() {
  const panel = $('#duplicates-panel');
  const groups = jobData.duplicateGroups;
  $('#dup-count').textContent = groups.length;
  panel.classList.toggle('hidden', groups.length === 0);
  const list = $('#duplicates-list');
  list.innerHTML = '';

  groups.forEach((group) => {
    const files = group.fileIds.map(fileById).filter(Boolean);
    const card = document.createElement('div');
    card.className = 'dup-group';

    const rows = files.map((f) => `
      <div class="dup-file-row">
        <span>${f.name}</span>
        <span style="color:var(--text-dim)">${f.relPath}</span>
        <span style="color:var(--text-dim)">(${formatSize(f.size)})</span>
      </div>`).join('');

    const resolutionType = group.resolution?.type || 'keep_all';
    const keepId = group.resolution?.keepId || files[0]?.id;

    const keepOptions = files.map((f) =>
      `<option value="${f.id}" ${f.id === keepId ? 'selected' : ''}>${f.name} (${f.relPath})</option>`
    ).join('');

    card.innerHTML = `
      <div class="dup-title">${files.length} identical copies &middot; ${formatSize(group.size)} each</div>
      ${rows}
      <div class="dup-resolution">
        <label><input type="radio" name="res-${group.id}" value="keep_all" ${resolutionType === 'keep_all' ? 'checked' : ''}> Keep all (renamed _1, _2, ...)</label>
        <label><input type="radio" name="res-${group.id}" value="merge" ${resolutionType === 'merge' ? 'checked' : ''}> Merge into one, remove the rest</label>
        <select class="cat-select dup-keep-select" ${resolutionType !== 'merge' ? 'disabled' : ''}>${keepOptions}</select>
      </div>
    `;

    const radios = card.querySelectorAll(`input[name="res-${group.id}"]`);
    const select = card.querySelector('.dup-keep-select');
    radios.forEach((r) => r.addEventListener('change', async () => {
      select.disabled = r.value !== 'merge';
      await resolveDuplicate(group.id, r.value, select.value);
    }));
    select.addEventListener('change', async () => {
      await resolveDuplicate(group.id, 'merge', select.value);
    });

    list.appendChild(card);
  });
}

async function resolveDuplicate(groupId, type, keepId) {
  try {
    await api('PUT', `/api/scan/${jobId}/duplicates/${groupId}`, { type, keepId });
    const group = jobData.duplicateGroups.find((g) => g.id === groupId);
    group.resolution = type === 'merge' ? { type, keepId } : { type };
    renderDeletionWarning();
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------- Near-duplicate (visually similar) photos ----------

function renderSimilar() {
  const panel = $('#similar-panel');
  const groups = jobData.similarGroups || [];
  panel.classList.toggle('hidden', groups.length === 0);
  $('#similar-count').textContent = groups.length;
  const list = $('#similar-list');
  list.innerHTML = '';

  groups.forEach((group) => {
    const files = group.fileIds.map(fileById).filter(Boolean);
    const card = document.createElement('div');
    card.className = 'similar-group';
    const items = files.map((f) => `
      <div class="s-item">
        <img class="thumb" style="width:64px;height:64px;" src="/api/scan/${jobId}/files/${f.id}/thumbnail" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="s-name" title="${f.name}">${f.name}</div>
      </div>
    `).join('');
    card.innerHTML = `<div class="s-title">${files.length} similar-looking photos</div><div class="similar-thumbs">${items}</div>`;
    list.appendChild(card);
  });
}

// ---------- Junk cleanup list ----------

function renderJunkList() {
  const panel = $('#junk-panel');
  const dirs = [...(jobData.ignoredNodeModulesDirs || []), ...(jobData.ignoredJunkDirs || [])];
  const files = jobData.ignoredJunkFiles || [];
  const total = dirs.length + files.length;
  panel.classList.toggle('hidden', total === 0);
  $('#junk-count').textContent = total;
  const list = $('#junk-list');
  list.innerHTML = [
    ...dirs.map((d) => `<div class="row">[folder] ${d}</div>`),
    ...files.map((f) => `<div class="row">[file] ${f}</div>`),
  ].join('');
}

// ---------- Bulk toolbar ----------

function renderBulkCategoryOptions() {
  const select = $('#bulk-category-select');
  select.innerHTML = categories.map((c) => `<option value="${c}">${c.replace(/_/g, ' ')}</option>`).join('');
}

function updateBulkToolbar() {
  const toolbar = $('#bulk-toolbar');
  toolbar.classList.toggle('hidden', selectedFileIds.size === 0);
  $('#bulk-count').textContent = `${selectedFileIds.size} selected`;
}

$('#btn-bulk-clear').addEventListener('click', () => {
  selectedFileIds.clear();
  renderCategories();
  updateBulkToolbar();
});

$('#btn-bulk-apply-category').addEventListener('click', async () => {
  if (selectedFileIds.size === 0) return;
  const category = $('#bulk-category-select').value;
  try {
    await api('POST', `/api/scan/${jobId}/files/bulk-category`, { fileIds: [...selectedFileIds], category });
    for (const id of selectedFileIds) {
      const f = fileById(id);
      if (f) f.category = category;
    }
    selectedFileIds.clear();
    renderResults();
  } catch (err) {
    showToast(err.message, true);
  }
});

async function bulkSetExcluded(excluded) {
  if (selectedFileIds.size === 0) return;
  try {
    await api('POST', `/api/scan/${jobId}/files/bulk-exclude`, { fileIds: [...selectedFileIds], excluded });
    for (const id of selectedFileIds) {
      const f = fileById(id);
      if (f) f.excluded = excluded;
    }
    selectedFileIds.clear();
    renderResults();
  } catch (err) {
    showToast(err.message, true);
  }
}
$('#btn-bulk-exclude').addEventListener('click', () => bulkSetExcluded(true));
$('#btn-bulk-include').addEventListener('click', () => bulkSetExcluded(false));

let searchDebounce;
$('#file-search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderCategories();
  }, 150);
});

// ---------- Files by category ----------

function renderCategories() {
  const container = $('#categories-list');
  container.innerHTML = '';

  const byCategory = new Map();
  for (const f of jobData.files) {
    if (searchTerm && !f.name.toLowerCase().includes(searchTerm) && !f.relPath.toLowerCase().includes(searchTerm)) continue;
    if (!byCategory.has(f.category)) byCategory.set(f.category, []);
    byCategory.get(f.category).push(f);
  }

  const sortedCats = [...byCategory.keys()].sort();

  if (sortedCats.length === 0) {
    container.innerHTML = '<div class="empty-hint">No files match your search.</div>';
    return;
  }

  for (const cat of sortedCats) {
    const files = byCategory.get(cat);
    const block = document.createElement('div');
    block.className = 'category-block';

    const activeCount = files.filter((f) => !f.excluded).length;
    const totalSize = files.reduce((s, f) => s + f.size, 0);

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
      <span class="name">${cat.replace(/_/g, ' ')}</span>
      <span class="meta">${activeCount}/${files.length} files &middot; ${formatSize(totalSize)}</span>
    `;

    const body = document.createElement('div');
    body.className = 'category-body' + (openCategoryBlocks.has(cat) || searchTerm ? ' open' : '');

    const table = document.createElement('table');
    table.className = 'file-table';
    table.innerHTML = `
      <thead><tr><th style="width:26px;"><input type="checkbox" class="select-all-cat"></th><th>File</th><th>Path</th><th>Size</th><th>Category</th><th>Exclude</th></tr></thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    const selectAllBox = table.querySelector('.select-all-cat');
    selectAllBox.checked = files.length > 0 && files.every((f) => selectedFileIds.has(f.id));
    selectAllBox.addEventListener('change', () => {
      for (const f of files) {
        if (selectAllBox.checked) selectedFileIds.add(f.id);
        else selectedFileIds.delete(f.id);
      }
      renderCategories();
      updateBulkToolbar();
    });

    files.forEach((f) => {
      const tr = document.createElement('tr');
      if (f.excluded) tr.classList.add('excluded');

      const catOptions = categories.map((c) =>
        `<option value="${c}" ${c === f.category ? 'selected' : ''}>${c.replace(/_/g, ' ')}</option>`
      ).join('');

      const thumbHtml = f.hasThumbnail
        ? `<img class="thumb" src="/api/scan/${jobId}/files/${f.id}/thumbnail" loading="lazy" onerror="this.style.display='none'">`
        : '';
      const dupBadge = f.duplicateGroupId ? '<span class="badge-dup">duplicate</span>' : '';
      const simBadge = f.similarGroupId ? '<span class="badge-dup" style="border-color:#2a4a5a;color:#7fc8e6;">similar</span>' : '';
      const pathDisplay = f.subPath ? `${f.relPath} <span style="color:var(--accent)">→ ${f.subPath}</span>` : f.relPath;

      tr.innerHTML = `
        <td><input type="checkbox" class="row-select" ${selectedFileIds.has(f.id) ? 'checked' : ''}></td>
        <td class="fname fname-cell">${thumbHtml}${f.name}${dupBadge}${simBadge}</td>
        <td class="fpath">${pathDisplay}</td>
        <td class="fsize">${formatSize(f.size)}</td>
        <td><select class="cat-select">${catOptions}<option value="__new__">+ New category…</option></select></td>
        <td><input type="checkbox" class="exclude-box" ${f.excluded ? 'checked' : ''}></td>
      `;

      tr.querySelector('.row-select').addEventListener('change', (e) => {
        if (e.target.checked) selectedFileIds.add(f.id);
        else selectedFileIds.delete(f.id);
        updateBulkToolbar();
      });

      const select = tr.querySelector('.cat-select');
      select.addEventListener('change', async () => {
        let newCat = select.value;
        if (newCat === '__new__') {
          newCat = prompt('New category name:');
          if (!newCat) { select.value = f.category; return; }
          newCat = newCat.trim().toLowerCase().replace(/\s+/g, '_');
          if (!categories.includes(newCat)) { categories.push(newCat); renderBulkCategoryOptions(); }
        }
        try {
          await api('PUT', `/api/scan/${jobId}/files/${f.id}`, { category: newCat });
          f.category = newCat;
          renderResults();
        } catch (err) {
          showToast(err.message, true);
        }
      });

      const excludeBox = tr.querySelector('.exclude-box');
      excludeBox.addEventListener('change', async () => {
        try {
          await api('PUT', `/api/scan/${jobId}/files/${f.id}`, { excluded: excludeBox.checked });
          f.excluded = excludeBox.checked;
          renderResults();
        } catch (err) {
          showToast(err.message, true);
        }
      });

      tbody.appendChild(tr);
    });

    body.appendChild(table);
    header.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      if (openCategoryBlocks.has(cat)) openCategoryBlocks.delete(cat);
      else openCategoryBlocks.add(cat);
      body.classList.toggle('open');
    });

    block.appendChild(header);
    block.appendChild(body);
    container.appendChild(block);
  }
}

$('#btn-cancel-results').addEventListener('click', () => {
  if (jobId) api('DELETE', `/api/scan/${jobId}`).catch(() => {});
  resetAll();
});

$('#btn-confirm-move').addEventListener('click', async () => {
  if (!confirm('This will move files out of your source folders into the destination. A full folder-structure snapshot is saved first so you can roll back afterward. Continue?')) return;
  try {
    $('#btn-confirm-move').disabled = true;
    const { runId } = await api('POST', `/api/scan/${jobId}/confirm`, {});
    lastRunId = runId;
    // The move runs in the background and is crash-resumable; watch it via the log + progress.
    $('#progress-phase').textContent = 'Moving files…';
    $('#progress-fill').style.width = '0%';
    $('#progress-text').textContent = 'Preparing…';
    renderLog([]);
    showView('progress');
    pollStatus();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    $('#btn-confirm-move').disabled = false;
  }
});

// ---------- Report view ----------

function renderReport(report, runId, treeBeforeStats, treeAfterStats) {
  const grid = $('#report-summary');
  grid.innerHTML = '';
  const junkTotal = report.deletedDirs.length + report.deletedFiles.length;
  const cards = [
    { n: report.moved.length, l: 'moved' },
    { n: report.projectsMoved.length, l: 'projects moved intact' },
    { n: report.themedFoldersMoved.length, l: 'organized folders moved intact' },
    { n: report.deleted.length, l: 'duplicates removed' },
    { n: junkTotal, l: 'junk items deleted' },
    { n: report.skippedExcluded, l: 'skipped (excluded)' },
    { n: report.errors.length, l: 'errors' },
  ];
  for (const c of cards) {
    const div = document.createElement('div');
    div.className = 'summary-card';
    div.innerHTML = `<div class="n">${c.n}</div><div class="l">${c.l}</div>`;
    grid.appendChild(div);
  }

  const permanentTotal = report.deleted.length + junkTotal;
  const warningEl = $('#report-permanent-warning');
  if (permanentTotal > 0) {
    warningEl.classList.remove('hidden');
    warningEl.textContent = `${permanentTotal} item(s) were permanently deleted (duplicates merged away and/or junk cleanup) and cannot be brought back by rolling back — everything else can be.`;
  } else {
    warningEl.classList.add('hidden');
  }

  if (runId) {
    $('#report-tree-before-link').href = `/api/runs/${runId}/tree/before`;
    $('#report-tree-after-link').href = `/api/runs/${runId}/tree/after`;
    const beforeLabel = treeBeforeStats ? ` (${treeBeforeStats.fileCount} files, ${treeBeforeStats.dirCount} folders)` : '';
    const afterLabel = treeAfterStats ? ` (${treeAfterStats.fileCount} files, ${treeAfterStats.dirCount} folders)` : '';
    $('#report-tree-before-link').textContent = `View folder structure before (JSON)${beforeLabel}`;
    $('#report-tree-after-link').textContent = `View folder structure after (JSON)${afterLabel}`;
  }

  $('#report-error-count').textContent = report.errors.length;
  $('#report-errors-panel').classList.toggle('hidden', report.errors.length === 0);
  $('#report-errors-list').innerHTML = report.errors.map((e) =>
    `<div class="row error-text">${e.file} &mdash; ${e.error}</div>`
  ).join('');

  $('#report-projects-panel').classList.toggle('hidden', report.projectsMoved.length === 0);
  $('#report-projects-list').innerHTML = report.projectsMoved.map((p) =>
    `<div class="row">[${p.type}] ${p.from}<span class="arrow">&rarr;</span>${p.to}</div>`
  ).join('');

  $('#report-themed-panel').classList.toggle('hidden', report.themedFoldersMoved.length === 0);
  $('#report-themed-list').innerHTML = report.themedFoldersMoved.map((f) =>
    `<div class="row">[${f.category.replace(/_/g, ' ')}, ${f.strayCount} stray file(s) pulled out] ${f.from}<span class="arrow">&rarr;</span>${f.to}</div>`
  ).join('');

  $('#report-moved-list').innerHTML = report.moved.map((m) =>
    `<div class="row">${m.category}<span class="arrow">&rarr;</span>${m.to}</div>`
  ).join('') || '<div class="row">No files moved.</div>';
}

$('#btn-new-run').addEventListener('click', resetAll);

$('#btn-undo-this-run').addEventListener('click', async () => {
  if (!lastRunId) return;
  if (!confirm('Roll back this run? Moved files/folders go back to where they came from. Permanently deleted items (merged duplicates, junk cleanup) cannot be restored.')) return;
  try {
    const { result } = await api('POST', `/api/runs/${lastRunId}/undo`, {});
    showToast(`Restored ${result.restored.length} item(s).${result.permanentlyLostCount ? ` ${result.permanentlyLostCount} deleted item(s) could not be restored.` : ''}`);
  } catch (err) {
    showToast(err.message, true);
  }
});

function resetAll() {
  sources = [];
  destination = null;
  jobId = null;
  jobData = null;
  lastRunId = null;
  selectedFileIds.clear();
  openCategoryBlocks.clear();
  renderSetup();
  showView('setup');
  checkResumableJobs();
}

// ---------- History & undo view ----------

$('#btn-open-history').addEventListener('click', async () => {
  await loadHistory();
  showView('history');
});
$('#btn-close-history').addEventListener('click', () => showView('setup'));

async function loadHistory() {
  try {
    const { runs } = await api('GET', '/api/runs');
    const list = $('#history-list');
    if (runs.length === 0) {
      list.innerHTML = '<div class="empty-hint">No runs yet.</div>';
      return;
    }
    list.innerHTML = '';
    runs.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'run-card';
      const extra = [];
      if (r.projectsMoved) extra.push(`${r.projectsMoved} project(s)`);
      if (r.themedFoldersMoved) extra.push(`${r.themedFoldersMoved} organized folder(s)`);
      const beforeN = r.treeBeforeStats ? `${r.treeBeforeStats.fileCount} files, ${r.treeBeforeStats.dirCount} folders` : '';
      const afterN = r.treeAfterStats ? `${r.treeAfterStats.fileCount} files, ${r.treeAfterStats.dirCount} folders` : '';
      card.innerHTML = `
        <div class="r-head">
          <span class="r-time">${formatDate(r.timestamp)}</span>
          ${r.undoneAt ? '<span class="r-undone">Rolled back</span>' : `<button class="btn btn-small btn-danger" data-run="${r.id}">Roll back</button>`}
        </div>
        <div class="r-meta">${r.sources.length} source(s) &rarr; ${r.destination}<br>
          ${r.movedCount} moved${extra.length ? ', ' + extra.join(', ') : ''}, ${r.deletedCount} permanently deleted</div>
        <div class="actions-row" style="margin-top:6px;">
          <a class="btn btn-small" href="/api/runs/${r.id}/tree/before" target="_blank">Structure before${beforeN ? ` (${beforeN})` : ''}</a>
          <a class="btn btn-small" href="/api/runs/${r.id}/tree/after" target="_blank">Structure after${afterN ? ` (${afterN})` : ''}</a>
        </div>
      `;
      if (!r.undoneAt) {
        card.querySelector('button[data-run]').addEventListener('click', async () => {
          if (!confirm('Roll back this run? Moved files/folders go back to where they came from. Permanently deleted items (merged duplicates, junk cleanup) cannot be restored.')) return;
          try {
            const { result } = await api('POST', `/api/runs/${r.id}/undo`, {});
            showToast(`Restored ${result.restored.length} item(s).${result.permanentlyLostCount ? ` ${result.permanentlyLostCount} deleted item(s) could not be restored.` : ''}`);
            loadHistory();
          } catch (err) {
            showToast(err.message, true);
          }
        });
      }
      list.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, true);
  }
}

// ---------- Init ----------
async function init() {
  try {
    capabilities = await api('GET', '/api/capabilities');
  } catch {
    capabilities = { perceptualHashing: false };
  }
  $('#similar-images-row').classList.toggle('hidden', !capabilities.perceptualHashing);
  renderSetup();
  showView('setup');
  checkResumableJobs();
}

init();
