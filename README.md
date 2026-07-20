<div align="center">

# 📁 Folder Organizer

**A local, private, AI-assisted tool that safely sorts your messiest folders into categories — without ever breaking your apps, code projects, or databases — with full one-click rollback.**

Everything runs on your own machine. Nothing is ever uploaded. Nothing touches disk until you review and confirm.

🌐 **English** ·
[فارسی](README.fa.md) ·
[العربية](README.ar.md) ·
[Español](README.es.md) ·
[中文](README.zh.md) ·
[हिन्दी](README.hi.md) ·
[Русский](README.ru.md) ·
[Français](README.fr.md) ·
[Deutsch](README.de.md) ·
[Português](README.pt.md) ·
[日本語](README.ja.md) ·
[Türkçe](README.tr.md)

</div>

---

## ✨ Why it's different

Most "file organizers" flatten everything into folders by extension — and in doing so they **break** the things that only work as a whole: a code project, a portable app, a database, a saved web page. Folder Organizer understands structure:

- 🛡️ **Keeps whole units intact.** Code projects (`package.json`, `.git`, `requirements.txt`, …), applications and programs (portable apps, browsers, emulators, games — even Linux/macOS binaries with no file extension), on-disk databases (SQLite, LevelDB/RocksDB), and saved web pages (`..._files` folders) are moved as **one piece**, never scattered.
- 🤖 **AI-driven, not a fixed list.** Categories aren't hard-coded. An optional **local LLM** classifies unknown file types with full path context and can invent new categories — and at the end of every scan it **re-reviews the entire plan to correct its own mistakes**.
- ⏪ **Fully reversible.** Every run is snapshotted; one click puts everything back exactly where it came from.
- 💾 **Crash-safe.** If your PC or the app shuts down mid-move, it resumes exactly where it left off.
- 🔒 **100% local & private.** No cloud, no telemetry, no account. Your files never leave your machine.

---

## 🚀 Quick start

```bash
npm install
npm start
```

Then open **http://localhost:4173** in your browser.
(Change the port with `PORT=5000 npm start`.)

---

## 🧩 What it does

| | |
|---|---|
| 🗂️ **Smart categorization** | Sorts files into images, video, music, documents, code, **models** (ML weights), **databases**, archives, **shortcuts**, **config**, and more — plus any category you or the AI create. |
| 🛡️ **Keeps units intact** | Code projects, applications/programs, databases, and saved web pages move as one unit instead of being shredded across categories. |
| 🤖 **Local LLM (optional)** | Classifies unknown types and does a **final review pass over every file** to fix mistakes. Point it at any local endpoint (e.g. LM Studio). |
| 🔁 **Duplicate detection** | Exact duplicates by content hash (renamed copies still caught) + visually-similar photos by perceptual hash. |
| 🧹 **Cleanup** | Optionally removes `node_modules`, build caches (`__pycache__`, `.venv`, `dist`, …), and OS junk (`Thumbs.db`, `.DS_Store`). |
| 📸 **Metadata subfolders** | Photos into `images/YYYY/MM` by EXIF date; music into `music/Artist/Album` by tags. |
| 👀 **Review first** | See the full plan grouped by category, with thumbnails, search, and bulk edit. Nothing moves until you confirm. |
| ⏪ **Rollback + snapshots** | A full before/after folder-structure snapshot is written for every run; undo any run from **History & Rollback**. |
| 💾 **Crash-safe resume** | Journaled, resumable moves — a power loss mid-run is picked up automatically on restart. |
| 📊 **Live progress + log** | Watch every phase (scan → categorize → LLM review → move) with a real-time activity log. |

---

## 🔒 Privacy

Folder Organizer is a personal desktop utility: no auth, no multi-user, no cloud, no telemetry. All state (learned category rules, scan snapshots, run history for undo) lives in a local `data/` folder next to the app. If you enable the optional LLM, requests go only to the local endpoint **you** configure.

---

## ⚙️ How it works

1. **Pick** one or more messy source folders and a single destination.
2. **Scan** — the app walks every folder, detects intact units (projects/apps/databases/web pages), categorizes files, (optionally) has the LLM review everything, then finds duplicates.
3. **Review** — edit categories, exclude anything, resolve duplicates. Nothing has touched disk yet.
4. **Confirm** — files move; a full snapshot + undo manifest is written first.
5. **Roll back** any time from History & Rollback.

**Stack:** Node.js + Express backend, plain HTML/CSS/JS frontend (no build step). Optional dependency `sharp` for near-duplicate photo detection.

---

## 🏷️ Topics

`file-organizer` · `folder-organizer` · `file-management` · `declutter` · `duplicate-finder` · `deduplication` · `organize-files` · `disk-cleanup` · `local-first` · `privacy` · `ai` · `llm` · `self-hosted` · `nodejs` · `automation` · `file-sorter` · `desktop-tool` · `exif` · `rollback` · `productivity`

---

<div align="center">
Made for people with a chaotic Desktop. Runs entirely on your machine. 💙
</div>
