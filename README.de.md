<div align="center">

# 📁 Folder Organizer (Ordner-Organisierer)

**Ein lokales, privates, KI-gestütztes Tool, das deine chaotischsten Ordner sicher in Kategorien einsortiert — ohne jemals deine Apps, Code-Projekte oder Datenbanken zu zerstören — mit vollständigem Rückgängigmachen per Klick.**

Alles läuft auf deinem eigenen Rechner. Nichts wird hochgeladen. Nichts wird verschoben, bis du geprüft und bestätigt hast.

[English](README.md) ·
[فارسی](README.fa.md) ·
[العربية](README.ar.md) ·
[Español](README.es.md) ·
[中文](README.zh.md) ·
[हिन्दी](README.hi.md) ·
[Русский](README.ru.md) ·
[Français](README.fr.md) ·
🌐 **Deutsch** ·
[Português](README.pt.md) ·
[日本語](README.ja.md) ·
[Türkçe](README.tr.md)

</div>

---

## ✨ Was es anders macht

Die meisten „Datei-Organisierer" kippen alles nur nach Endung in Ordner — und zerstören dabei das, was nur als Ganzes funktioniert: ein Code-Projekt, eine portable App, eine Datenbank, eine gespeicherte Webseite. Diese App versteht Struktur:

- 🛡️ **Hält ganze Einheiten intakt.** Code-Projekte (`package.json`, `.git`, …), Anwendungen und Programme (portable Apps, Browser, Emulatoren, Spiele — sogar Linux/macOS-Binärdateien ohne Endung), Datenbanken (SQLite, LevelDB/RocksDB) und gespeicherte Webseiten (`..._files`-Ordner) werden **als Ganzes** verschoben, nie zerstreut.
- 🤖 **KI-gesteuert, keine feste Liste.** Kategorien sind nicht fest verdrahtet. Ein optionales **lokales LLM** klassifiziert unbekannte Typen mit dem vollständigen Pfad-Kontext und kann neue Kategorien erfinden — und am Ende jedes Scans **prüft es den gesamten Plan erneut, um eigene Fehler zu korrigieren**.
- ⏪ **Vollständig umkehrbar.** Jeder Lauf wird als Snapshot gesichert; ein Klick bringt alles exakt an seinen Ursprungsort zurück.
- 💾 **Absturzsicher.** Wenn dein PC oder die App mittendrin ausgeht, wird beim Neustart genau dort weitergemacht, wo es aufgehört hat.
- 🔒 **100 % lokal & privat.** Keine Cloud, keine Telemetrie, kein Konto.

---

## 🚀 Schnellstart

```bash
npm install
npm start
```

Dann **http://localhost:4173** im Browser öffnen.
(Port ändern: `PORT=5000 npm start`.)

---

## 🧩 Funktionen

- 🗂️ **Intelligente Kategorisierung** — Bilder, Video, Musik, Dokumente, Code, **Modelle** (ML-Gewichte), **Datenbanken**, Archive, **Verknüpfungen**, **Konfig** und mehr — plus jede Kategorie, die du oder die KI erstellt.
- 🛡️ **Hält intakt**: Projekte, Anwendungen, Datenbanken und gespeicherte Webseiten.
- 🤖 **Lokales LLM (optional)** — klassifiziert unbekannte Typen und macht eine **finale Prüfung aller Dateien**.
- 🔁 **Duplikaterkennung** — exakt (per Inhalts-Hash) und visuell ähnliche Fotos.
- 🧹 **Bereinigung** von `node_modules`, Build-Caches und OS-Müll.
- 📸 **Intelligente Unterordner** — Fotos nach EXIF-Datum, Musik nach Künstler/Album.
- 👀 **Vor dem Verschieben prüfen** — kompletten Plan sehen, bearbeiten, ausschließen.
- ⏪ **Rückgängig + Snapshots** der Ordnerstruktur für jeden Lauf.
- 💾 **Automatische Fortsetzung** nach einer Unterbrechung.
- 📊 **Live-Fortschritt und Echtzeit-Protokoll.**

---

## 🔒 Datenschutz

Dies ist ein persönliches Desktop-Tool: kein Login, kein Mehrbenutzer, keine Cloud, keine Telemetrie. Der gesamte Zustand (gelernte Kategorieregeln, Scan-Snapshots, Lauf-Historie zum Rückgängigmachen) liegt in einem lokalen `data/`-Ordner neben der App. Wenn du das optionale LLM aktivierst, gehen Anfragen nur an den lokalen Endpunkt, den **du** konfigurierst.
