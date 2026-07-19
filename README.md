# Folder Organizer

A local web panel that scans multiple source folders, sorts files into categories,
keeps code projects intact, cleans up junk, spots duplicates (exact and near),
and lets you review everything before anything moves.

## Setup

```bash
npm install
npm start
```

Then open **http://localhost:4173**. Everything runs locally — nothing leaves your
machine. (Optional: change the port with `PORT=5000 npm start`.)

## What it does

**1. Sources / Destination** — Add as many source folders as you want (via a
built-in filesystem browser that also lists your other drives, not just the one
your home folder is on), and pick one destination.

**2. Code projects stay intact** — Before anything else, the scanner looks for
folders that are actually software projects (`package.json`, `requirements.txt`,
`pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `.git`, `.csproj`, and more).
Those folders are **never** split apart into music/images/code/etc. — they're
copied whole, structure intact, into `destination/coded_programs/<name>`. Their
`node_modules`, `__pycache__`, `.venv`, `dist`, `build`, etc. are deleted first
(if you've enabled that cleanup) so you're not copying gigabytes of installable
junk. You can uncheck any individual detected project in the review screen if
you'd rather leave it untouched.

**2b. Your own organized folders stay intact too** — Say you've already got a
folder named "2026 Birthday Photos" that's mostly photos, but someone in a
hurry also dropped a PDF in there. The scanner detects folders like this
(mostly one file type, human-named, not a code project) and keeps them as a
folder — the stray PDF gets pulled out and sorted into `documents/` like
normal, and "2026 Birthday Photos" itself moves in as one clean unit into
`images/2026 Birthday Photos/`. So opening the destination's `images/` folder
later shows your own organization preserved, just cleaned up — not a flat dump
of every photo ever found. Toggle this off if you'd rather have everything
fully flattened by category instead.

**3. Cleanup options**
- Delete `node_modules` folders (standalone or inside a project) instead of copying them.
- Delete other build/cache junk: `__pycache__`, `.venv`, `dist`, `build`, `.next`,
  `target`, `.pytest_cache`, `.mypy_cache`, plus OS junk files like `.DS_Store`,
  `Thumbs.db`, `desktop.ini`.

**4. Smart organization**
- Photos can be sorted into `images/YYYY/MM` by their EXIF capture date.
- Music can be sorted into `music/Artist/Album` by ID3/Vorbis tags.
- Files without usable metadata just fall back to their plain category folder.

**5. Categorization** — extension-based, covering music/video/images/documents/
archives/virtual machines/executables/code/fonts/ebooks, `others` as a catch-all.
Unknown extensions can optionally be sent to a local LLM (batched into a single
request, not one call per file) — point it at
`http://localhost:1234/api/v1/chat`, model `gemma-3-4b-it`, or whatever you run.
**Any category you manually set for a file is remembered** — next time that
extension shows up, it's categorized correctly without needing the LLM at all.

**6. Duplicate detection**
- Exact duplicates: found by content hash (MD5), not filename, so renamed
  copies are still caught and different files sharing a name aren't falsely
  flagged. For each group, choose "keep all" (renamed `_1`, `_2`, ...) or
  "merge" (keep one, delete the rest).
- Near-duplicates: visually similar photos (e.g. resized/re-compressed copies)
  are flagged separately using perceptual hashing, for you to review manually —
  nothing is auto-deleted here.

**7. Review screen** — grouped by category, with thumbnails for images, a
search box, and bulk select (recategorize or exclude many files at once)
alongside the regular per-file edit/exclude controls. Nothing touches disk
until you click Confirm.

**8. Confirm & move** — creates the category folders (and project folder) in
the destination and moves everything there. Filename collisions are
auto-numbered so nothing is silently overwritten.

**9. Rollback, backed by a full folder-structure snapshot** — Right before any
files move, the app writes a complete JSON snapshot of every source folder's
structure to disk (streamed, so it handles arbitrarily large trees without
choking), and another of the resulting destination structure right after.
Every run is logged with these two snapshots plus the exact list of what moved
where. Open **History & Rollback** from the header to reverse any run: moved
files and folders go back exactly where they came from. You can also open
either snapshot as raw JSON straight from the report or history screen.
**Warning shown up front, not just after the fact:** anything that gets
permanently deleted during a run — duplicates removed via "merge", and
node_modules/junk cleanup — is called out in an always-visible warning panel
before you confirm, and again in the report and rollback result. Those items
cannot be brought back by rolling back, since their content is gone, not just
relocated; only their record remains in the snapshot.

**10. Resilience** — if you restart the server mid-review, it picks the scan
back up automatically (you'll see a "Resume previous session" banner) instead
of losing your work.

## Notes

- Moves are true "cut" operations: rename when possible, falling back to
  copy+delete automatically across drives/filesystems.
- The destination folder cannot be inside one of the source folders.
- The near-duplicate photo feature needs `sharp`, which is an optional
  dependency — if it fails to install on your platform, everything else still
  works, that one feature just won't be offered.
- All app state (learned category rules, in-progress scan snapshots, run
  history for undo) lives in a local `data/` folder next to the app — nothing
  is sent anywhere.
