# Folder Organizer — Project Brief

*This document is written for an AI coding assistant (Claude Fable 5, via Claude Code) picking up this repository. It explains what the app is, exactly what it does, and how it's built, then asks for improvement proposals at the end.*

---

## 1. What this is

**Folder Organizer** is a local, single-user Node.js web app. It runs a small Express server on your own machine, opens a dark-themed dashboard in your browser, and lets you point it at one or more messy source folders plus a single destination folder. It then scans everything — no matter how nested — sorts files into categories (music, video, images, documents, etc.), and, critically, is smart about *not* destroying things that shouldn't be flattened: code projects and folders you've already organized yourself stay intact. Nothing touches disk until you explicitly review and confirm the plan, and every confirmed run can be rolled back.

It has no auth, no multi-user support, no cloud component, and no telemetry — it's a personal desktop utility, not a hosted product. All state lives in a local `data/` folder next to the app.

---

## 2. What it does — the user-facing flow

1. **Pick sources & destination.** Add as many source folders as you like via a built-in filesystem browser (which also surfaces other drives — Windows drive letters, macOS `/Volumes`, Linux `/mnt`/`/media`), or type a path directly. Pick exactly one destination folder.
2. **Set options** (all toggleable, described in detail below): project detection, "themed folder" detection, node_modules/junk cleanup, EXIF/ID3-based subfoldering, near-duplicate photo detection, and an optional local-LLM fallback for unrecognized file types.
3. **Scan.** The server walks the whole tree in the background; the browser polls for progress through several phases (listing → categorizing → metadata → hashing → similarity).
4. **Review.** Everything is shown before any file moves: files grouped by category (with thumbnails, search, and bulk select/recategorize/exclude), detected code projects, detected "themed" folders, exact-duplicate groups needing a keep/merge decision, near-duplicate photo groups, and a list of junk that will be deleted. An always-visible warning panel calls out anything that will be **permanently deleted** (not just moved) before you can confirm.
5. **Confirm.** The plan executes: junk gets deleted, projects and themed folders move as intact units, duplicates get resolved, everything else gets moved into `destination/<category>/`. A full JSON snapshot of the folder structure is taken immediately before and immediately after.
6. **Roll back (optional).** From "History & Rollback," any past run can be reversed — moved files/folders go back to where they came from. Permanently deleted items obviously can't be brought back, and the UI is explicit about that at every step (before confirming, in the report, and in the rollback result).

---

## 3. Exact feature list

### 3.1 Source/destination selection
- Multi-source, single-destination.
- Server-side filesystem browser (`GET /api/browse`) with a "drives" quick-picker (`GET /api/drives`) and a manual path box for anything auto-detection misses (e.g. network drives).
- Destination is rejected if it's inside (or equal to) any source folder.

### 3.2 Code project detection (atomic preservation)
- Recognizes a folder as a software project if it directly contains one of these markers: `package.json` (Node.js), `requirements.txt`/`pyproject.toml`/`setup.py`/`Pipfile` (Python), `Cargo.toml` (Rust), `go.mod` (Go), `pom.xml` (Java/Maven), `build.gradle`/`build.gradle.kts` (Java/Kotlin Gradle), `composer.json` (PHP), `Gemfile` (Ruby), `*.csproj`/`*.sln` (.NET), `CMakeLists.txt` (C/C++), or a `.git` directory as a fallback signal.
- A detected project is **never** decomposed file-by-file. Its `node_modules` and other build/cache junk are found recursively and deleted first (governed by the cleanup toggles below), then the whole folder — internal structure untouched — is moved as one unit into `destination/coded_programs/<name>`.
- Toggleable per-scan; each detected project can also be individually excluded (left untouched) in the review screen.

### 3.3 "Themed folder" detection (human-organized collections)
- Recognizes folders you've already organized yourself — e.g. "2026 Birthday Photos", "Home Rent Documents" — where one category clearly dominates (default: ≥60% of files, minimum 3 files in the folder, recursively).
- Files that *don't* match the dominant category (a stray PDF in a photo folder, say) are individually extracted and routed through the normal categorization/duplicate/move pipeline into their own correct category.
- The folder itself, now containing only the dominant-category files, moves as one intact unit into `destination/<dominant category>/<folder name>` — so the destination ends up with your own folder names and structure preserved inside each category, not a flat dump of every file.
- Self-disqualifies if a code project is found nested anywhere inside it (that subfolder is left for normal project detection instead, avoiding misclassification).
- Toggleable; individual detected folders can be excluded from the review screen (left completely untouched, strays included).

### 3.4 Cleanup (never copied, only deleted from source)
- `node_modules` folders (standalone or inside a detected project).
- Other build/cache junk: `__pycache__`, `.venv`, `venv`, `env`, `dist`, `build`, `.next`, `target`, `.gradle`, `.pytest_cache`, `.mypy_cache`, `.tox`, `.cache`, `out`.
- OS junk files: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.directory`.
- Both are independent toggles.

### 3.5 Categorization engine
- Built-in extension → category map covering: `music`, `video`, `images`, `documents`, `archives`, `disk_images`, `virtual_machines`, `executables`, `code`, `fonts`, `ebooks`, plus `others` as the catch-all.
- **Learned rules:** any category you manually set for a file is persisted (keyed by extension) to `data/learned-rules.json` and takes priority over the built-in map on every future scan — no LLM needed once you've corrected something once.
- **Optional local LLM fallback** for extensions the built-in map and learned rules don't recognize. Talks to a configurable endpoint (default `http://localhost:1234/api/v1/chat`, default model `gemma-3-4b-it`, matching an LM-Studio-style `{ model, system_prompt, input }` payload) with tolerant response parsing since the local server's exact response shape isn't guaranteed. Unknown extensions are **batched into one request** rather than one call per file; only genuinely extensionless files fall back to a per-file call.

### 3.6 Duplicate detection
- **Exact duplicates:** two-phase — group by file size (cheap), then MD5-hash only files sharing a size, so it scales reasonably. For each duplicate group, the user chooses "keep all" (every copy kept, renamed `name_1.ext`, `name_2.ext`, …) or "merge" (keep one chosen copy, permanently delete the rest).
- **Near-duplicates:** perceptual hashing (dHash via `sharp`, 9×8 grayscale resize, 64-bit hash, Hamming distance ≤ 6 by default) flags visually similar-but-not-identical photos (e.g. re-compressed or resized copies) within the `images` category, excluding anything already an exact duplicate. This is purely informational — nothing is auto-deleted, the user reviews and decides manually. `sharp` is an optional dependency; the feature silently disables itself if it's unavailable on the host platform.

### 3.7 Metadata-based subfolders
- Photos: EXIF `DateTimeOriginal`/`CreateDate` → `images/YYYY/MM/` (via `exifr`, pure JS, no native deps).
- Music: ID3/Vorbis tags (album artist or artist, plus album) → `music/Artist/Album/` (via `music-metadata`, pure JS).
- Files without usable metadata just fall back to their plain category folder.

### 3.8 Review UI
- Files grouped by category, collapsible, with per-file thumbnails (images only, streamed from the original file, sized down via CSS), inline category editing (dropdown + "new category" option), and per-file exclude.
- Search box filtering by filename/path across all categories.
- Bulk selection (per-row checkboxes + "select all in category") with bulk recategorize and bulk include/exclude.
- Separate review panels for: detected projects, detected themed folders, exact-duplicate groups, near-duplicate photo groups, and the junk that will be deleted.
- An always-visible deletion warning (not just a JS `confirm()` popup) summarizing exactly how many items will be permanently, non-recoverably deleted, shown before the Confirm button.

### 3.9 Confirm & execution
- Order of operations matters and is deliberate: (1) delete standalone junk dirs/files → (2) clean and move detected projects → (3) resolve duplicate groups (this also moves/deletes any files that happen to be "themed folder" strays) → (4) move all remaining loose files (including any leftover themed-folder strays) → (5) move themed folders last, once every stray file has already been pulled out of them, so the folder-level move is always safe.
- Moves are true "cut" operations: `fs.rename` first, falling back to copy+delete automatically if source and destination are on different filesystems/drives (handled for both files and whole directories).
- Filename/foldername collisions at the destination are auto-numbered (`_1`, `_2`, …) — nothing is ever silently overwritten.

### 3.10 Full folder-structure snapshot + rollback
- Immediately before a confirmed run touches anything, the **entire** structure of every source folder is streamed to a JSON file (`data/runs/<runId>/source-tree-before.json`) — implemented with a writable stream and backpressure handling so it never holds the whole tree in memory, regardless of size.
- Immediately after the run, the same is done for the destination (`destination-tree-after.json`).
- A manifest (`manifest.json`) records every individual move (`from`/`to`/`category`), every project/themed-folder move, and every deletion.
- **Rollback** (`POST /api/runs/:runId/undo`) reverses every recorded move (files and whole directories) in reverse order, and explicitly reports anything it *couldn't* restore (destination no longer exists, or the original location is occupied again) plus a count of permanently-deleted items that were never move-able in the first place.
- "History & Rollback" (in the header) lists every past run with its stats and a rollback button; both raw JSON snapshots are downloadable from there and from the immediate post-confirm report.

### 3.11 Resilience
- If the server restarts mid-review (before confirming), the in-progress scan job is snapshotted to `data/jobs/<jobId>.json` after every mutation and reloaded on startup — the browser shows a "resume previous session" banner instead of losing the review state.

---

## 4. How it's built

**Stack:** Node.js + Express backend, no ORM/DB (in-memory job store + flat JSON files on disk for persistence). Frontend is plain HTML/CSS/vanilla JS — no framework, no bundler, no build step. Dark, developer-tool-styled UI using CSS custom properties.

**Dependencies:** `express` (server), `exifr` and `music-metadata` (pure-JS metadata extraction), `sharp` (optional, for perceptual image hashing only — everything else works without it).

**File layout:**
```
server.js                  Express app; all HTTP routes
lib/
  categorize.js            Extension -> category map, getExtension()
  drives.js                Drive/mount-point detection (win32/darwin/linux)
  jobStore.js               In-memory Map of active scan jobs
  learnedRules.js           Persisted ext -> category overrides (data/learned-rules.json)
  llm.js                    Local LLM client: single + batched classification, connection test
  metadata.js               EXIF photo date + ID3 music tag extraction
  mover.js                  Executes the confirmed plan; builds the report; undoRun()
  perceptualHash.js         dHash computation + similarity grouping (sharp-based, optional)
  persistence.js            Job snapshot save/load; per-run manifest + tree-snapshot paths
  projectDetect.js          Project marker list, junk-dir lists, name sanitizing
  scanner.js                The core walk/categorize/hash/similarity pipeline (runScan)
  treeSnapshot.js           Streams a full recursive folder snapshot to a JSON file
public/
  index.html                Single-page shell (view-switching divs, no router)
  app.js                    All frontend logic (fetch-based API calls, DOM rendering)
  style.css                 Dark theme, CSS variables
data/                       Generated at runtime, gitignored (jobs/, runs/, learned-rules.json)
```

**Scan pipeline (`lib/scanner.js`, `runScan(job)`):**
1. *Listing* — recursively walks each source root. At every directory, checks (in order): is this a project root? → handle atomically. Is `detectThemedFolders` on and this isn't a source root itself? → evaluate as a themed folder (a synchronous-ish prescan categorizes every file inside by extension/learned-rule only, computes the dominant category and ratio, disqualifies itself if a nested project is found). Otherwise recurse normally, diverting `node_modules`/junk-dir names and OS junk filenames into their own tracked lists instead of yielding them as regular files.
2. *Categorizing* — learned rule → built-in extension map → (if still unknown and LLM enabled) batched LLM call for unique unrecognized extensions, then per-file LLM call only for the rare extensionless case. Anything still unresolved becomes `others`.
3. *Metadata* — if enabled, EXIF date for `images` files / ID3 tags for `music` files, producing a `subPath` used later to nest the destination path.
4. *Hashing* — exact-duplicate detection: bucket by size, MD5-hash only same-size files, group by hash.
5. *Similarity* — if enabled and `sharp` is available, dHash every non-duplicate image, group by Hamming distance.

**Confirm pipeline (`lib/mover.js`, `confirmJob(job)`):** described in §3.9 above — the ordering there is load-bearing, not incidental (themed-folder strays must be physically moved out before the folder-level move happens, otherwise the stray's original path would vanish out from under it).

**API surface (all under `/api`):** `browse`, `drives`, `capabilities`, `llm/test`, `categories`, `rules` (GET/DELETE), `scan` (GET list / POST create), `scan/:id` (GET), `scan/:id/status`, `scan/:id/files/:fileId` (PUT/DELETE), `scan/:id/files/bulk-category`, `scan/:id/files/bulk-exclude`, `scan/:id/projects/:projectId` (PUT), `scan/:id/themed-folders/:folderId` (PUT), `scan/:id/duplicates/:groupId` (PUT), `scan/:id/confirm` (POST), `scan/:id` (DELETE), `runs` (GET), `runs/:id` (GET), `runs/:id/tree/before` and `/tree/after` (GET raw JSON), `runs/:id/undo` (POST).

---

## 5. Known limitations (be aware of these; they're not necessarily bugs)

- Symbolic links are skipped entirely (never followed, never moved) — deliberate, to avoid loops, but means symlinked content is left behind untouched.
- Near-duplicate comparison is O(n²) within the `images` category per scan — fine for typical personal photo libraries, could get slow on very large ones (tens of thousands of images in one scan).
- Themed-folder detection uses a single flat threshold (60% dominant, minimum 3 files) with no weighting by file size, recency, or nesting depth — a large folder that's borderline 55/45 between two categories won't be detected as themed at all, even if that's clearly what a human would call it.
- The confirm request is currently synchronous from the frontend's point of view (blocks on a single HTTP request) — for enormous trees this could be a long wait with no incremental progress feedback, unlike the scan phase which polls.
- No automated test suite — verification so far has been manual/scripted end-to-end runs against real temp directories.
- Only tested on Linux in this environment; Windows-specific paths (drive letters, `\` separators) are handled in code but not verified on an actual Windows machine.
- No content-level verification after a move (e.g. hash-compare source vs. destination) — a move is trusted if `fs.rename`/`fs.cp` didn't throw.

---

## 6. For Fable 5

You have the full repository. Please read through the actual code (not just this brief) and propose concrete improvements to the *logic* — detection accuracy, correctness under edge cases, and robustness — beyond what's listed in §5. Some dimensions worth considering, though don't limit yourself to these:

- Are there realistic folder/file scenarios where project detection, themed-folder detection, or duplicate/near-duplicate detection would misfire — and how would you tune or restructure the heuristics to handle them?
- Is the confirm-pipeline ordering (§3.9) actually airtight, or are there sequences of user edits in the review screen that could produce an inconsistent or unsafe move plan?
- Where would you add automated tests first, and what's the highest-leverage refactor to make this codebase safer to extend?
- Anything about the rollback/snapshot system that could fail silently or produce a misleading "restored" result?

Treat this as an open brief, not a checklist — the goal is to make the app's decisions more accurate and its edge-case handling more trustworthy, not just to add more toggles.
