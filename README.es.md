<div align="center">

# 📁 Folder Organizer (Organizador de Carpetas)

**Una herramienta local, privada y asistida por IA que ordena de forma segura tus carpetas más caóticas en categorías — sin romper nunca tus aplicaciones, proyectos de código o bases de datos — con reversión total en un clic.**

Todo se ejecuta en tu propia máquina. Nada se sube. Nada se mueve hasta que revisas y confirmas.

[English](README.md) ·
[فارسی](README.fa.md) ·
[العربية](README.ar.md) ·
🌐 **Español** ·
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

## ✨ Qué lo hace diferente

La mayoría de los "organizadores de archivos" lo aplanan todo en carpetas por extensión, y al hacerlo **rompen** lo que solo funciona como un todo: un proyecto de código, una app portable, una base de datos, una página web guardada. Esta app entiende la estructura:

- 🛡️ **Mantiene las unidades intactas.** Proyectos de código (`package.json`, `.git`, …), aplicaciones y programas (apps portables, navegadores, emuladores, juegos — incluso binarios de Linux/macOS sin extensión), bases de datos (SQLite, LevelDB/RocksDB) y páginas web guardadas (carpetas `..._files`) se mueven como **una sola pieza**, nunca dispersas.
- 🤖 **Impulsado por IA, no una lista fija.** Las categorías no están predefinidas. Un **LLM local (opcional)** clasifica tipos desconocidos con el contexto de la ruta completa y puede inventar categorías nuevas — y al final de cada análisis **revisa todo el plan para corregir sus propios errores**.
- ⏪ **Totalmente reversible.** Cada ejecución se guarda como instantánea; un clic devuelve todo exactamente a su lugar.
- 💾 **A prueba de fallos.** Si tu PC o la app se apagan a mitad de camino, se reanuda justo donde lo dejó.
- 🔒 **100 % local y privado.** Sin nube, sin telemetría, sin cuenta.

---

## 🚀 Inicio rápido

```bash
npm install
npm start
```

Luego abre **http://localhost:4173** en tu navegador.
(Cambia el puerto con `PORT=5000 npm start`.)

---

## 🧩 Qué hace

- 🗂️ **Categorización inteligente** — imágenes, vídeo, música, documentos, código, **modelos** (pesos de ML), **bases de datos**, archivos comprimidos, **accesos directos**, **configuración** y más — además de cualquier categoría que crees tú o la IA.
- 🛡️ **Mantiene intactos** proyectos, aplicaciones, bases de datos y páginas web guardadas.
- 🤖 **LLM local (opcional)** — clasifica tipos desconocidos y hace una **revisión final de todos los archivos**.
- 🔁 **Detección de duplicados** — exactos (por hash de contenido) y fotos visualmente similares.
- 🧹 **Limpieza** de `node_modules`, cachés de compilación y basura del sistema operativo.
- 📸 **Subcarpetas inteligentes** — fotos por fecha EXIF, música por artista/álbum.
- 👀 **Revisa antes de mover** — ve el plan completo, edítalo, excluye lo que quieras.
- ⏪ **Reversión + instantáneas** de la estructura de carpetas de cada ejecución.
- 💾 **Reanudación automática** tras un corte.
- 📊 **Progreso en vivo y registro en tiempo real.**

---

## 🔒 Privacidad

Es una utilidad personal de escritorio: sin inicio de sesión, sin multiusuario, sin nube, sin telemetría. Todo el estado (reglas de categorías aprendidas, instantáneas, historial para deshacer) vive en una carpeta local `data/` junto a la app. Si activas el LLM opcional, las solicitudes van solo al punto de conexión local que **tú** configures.
