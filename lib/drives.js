'use strict';

const os = require('os');
const fsp = require('fs').promises;

/**
 * Detects available "drives" / mount points so the folder browser can offer
 * quick access to them, not just whatever is reachable from the home folder.
 */
async function listDrives() {
  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const results = await Promise.all(
      letters.map(async (letter) => {
        const drivePath = `${letter}:\\`;
        try {
          await fsp.stat(drivePath);
          return { name: `${letter}:`, path: drivePath };
        } catch {
          return null;
        }
      })
    );
    return results.filter(Boolean);
  }

  if (process.platform === 'darwin') {
    try {
      const entries = await fsp.readdir('/Volumes', { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, path: `/Volumes/${e.name}` }));
    } catch {
      return [];
    }
  }

  // Linux and others: common mount locations for external/extra drives.
  const drives = [];
  const user = os.homedir().split('/').pop();
  const bases = [`/media/${user}`, '/media', '/mnt', '/run/media/' + user];
  const seen = new Set();
  for (const base of bases) {
    try {
      const entries = await fsp.readdir(base, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          const p = `${base}/${e.name}`;
          if (!seen.has(p)) {
            seen.add(p);
            drives.push({ name: e.name, path: p });
          }
        }
      }
    } catch {
      // base doesn't exist - fine, skip it
    }
  }
  return drives;
}

module.exports = { listDrives };
