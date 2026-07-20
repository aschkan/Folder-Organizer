<div align="center">

# 📁 Folder Organizer (Organisateur de dossiers)

**Un outil local, privé et assisté par IA qui range en toute sécurité vos dossiers les plus chaotiques par catégories — sans jamais casser vos applications, projets de code ou bases de données — avec une annulation complète en un clic.**

Tout s'exécute sur votre machine. Rien n'est envoyé en ligne. Rien ne bouge tant que vous n'avez pas vérifié et confirmé.

[English](README.md) ·
[فارسی](README.fa.md) ·
[العربية](README.ar.md) ·
[Español](README.es.md) ·
[中文](README.zh.md) ·
[हिन्दी](README.hi.md) ·
[Русский](README.ru.md) ·
🌐 **Français** ·
[Deutsch](README.de.md) ·
[Português](README.pt.md) ·
[日本語](README.ja.md) ·
[Türkçe](README.tr.md)

</div>

---

## ✨ Ce qui le rend différent

La plupart des « organisateurs de fichiers » aplatissent tout dans des dossiers par extension, et ce faisant **cassent** ce qui ne fonctionne qu'en un seul bloc : un projet de code, une application portable, une base de données, une page web enregistrée. Cette application comprend la structure :

- 🛡️ **Garde les unités intactes.** Projets de code (`package.json`, `.git`, …), applications et programmes (apps portables, navigateurs, émulateurs, jeux — même les binaires Linux/macOS sans extension), bases de données (SQLite, LevelDB/RocksDB) et pages web enregistrées (dossiers `..._files`) sont déplacés **d'un seul tenant**, jamais éparpillés.
- 🤖 **Piloté par l'IA, pas une liste figée.** Les catégories ne sont pas codées en dur. Un **LLM local (optionnel)** classe les types inconnus en tenant compte du chemin complet et peut inventer de nouvelles catégories — et à la fin de chaque analyse, il **réexamine tout le plan pour corriger ses propres erreurs**.
- ⏪ **Entièrement réversible.** Chaque exécution est capturée en instantané ; un clic remet tout exactement à sa place.
- 💾 **Résistant aux pannes.** Si votre PC ou l'application s'éteint en cours de route, tout reprend exactement là où il s'était arrêté.
- 🔒 **100 % local et privé.** Pas de cloud, pas de télémétrie, pas de compte.

---

## 🚀 Démarrage rapide

```bash
npm install
npm start
```

Ouvrez ensuite **http://localhost:4173** dans votre navigateur.
(Changer le port : `PORT=5000 npm start`.)

---

## 🧩 Fonctionnalités

- 🗂️ **Catégorisation intelligente** — images, vidéos, musique, documents, code, **modèles** (poids ML), **bases de données**, archives, **raccourcis**, **config** et plus — plus toute catégorie créée par vous ou l'IA.
- 🛡️ **Garde intacts** projets, applications, bases de données et pages web enregistrées.
- 🤖 **LLM local (optionnel)** — classe les types inconnus et fait une **revue finale de tous les fichiers**.
- 🔁 **Détection des doublons** — exacts (par hachage de contenu) et photos visuellement similaires.
- 🧹 **Nettoyage** de `node_modules`, caches de build et fichiers indésirables du système.
- 📸 **Sous-dossiers intelligents** — photos par date EXIF, musique par artiste/album.
- 👀 **Vérifier avant de déplacer** — voir tout le plan, l'éditer, exclure ce que vous voulez.
- ⏪ **Annulation + instantanés** de la structure des dossiers pour chaque exécution.
- 💾 **Reprise automatique** après une coupure.
- 📊 **Progression en direct et journal en temps réel.**

---

## 🔒 Confidentialité

C'est un utilitaire de bureau personnel : sans connexion, sans multi-utilisateur, sans cloud, sans télémétrie. Toutes les données (règles de catégories apprises, instantanés, historique pour annuler) résident dans un dossier local `data/` à côté de l'application. Si vous activez le LLM optionnel, les requêtes ne vont qu'au point d'accès local que **vous** configurez.
