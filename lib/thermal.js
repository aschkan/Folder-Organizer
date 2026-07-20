'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

// Reads CPU/GPU temperatures cross-platform, best-effort, WITHOUT native modules:
//   - GPU:  nvidia-smi (Windows/Linux, if an NVIDIA GPU + driver is present); AMD via sysfs on Linux.
//   - CPU:  Linux /sys thermal zones; Windows WMI (wmic) thermal zone; macOS is usually unavailable.
// Anything unreadable comes back as null, and the cooldown logic simply treats "no sensor"
// as "never pause" - so this feature can never block a scan on a machine it can't measure.

function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        finish(err ? null : String(stdout || ''));
      });
      child.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

/** nvidia-smi prints one temperature (°C) per GPU; take the hottest. */
function parseNvidiaSmi(stdout) {
  if (!stdout) return null;
  const nums = stdout.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n < 150);
  return nums.length ? Math.max(...nums) : null;
}

/** WMI MSAcpi_ThermalZoneTemperature is in tenths of a Kelvin; convert to °C, take the hottest plausible zone. */
function parseWmicTemp(stdout) {
  if (!stdout) return null;
  const temps = [];
  for (const tok of stdout.split(/\s+/)) {
    const v = Number(tok);
    if (Number.isFinite(v) && v > 2000) {
      const c = v / 10 - 273.15;
      if (c > 0 && c < 130) temps.push(c);
    }
  }
  return temps.length ? Math.max(...temps) : null;
}

async function readNvidiaGpu() {
  const out = await run('nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits']);
  return parseNvidiaSmi(out);
}

const CPU_ZONE_HINTS = ['x86_pkg_temp', 'coretemp', 'k10temp', 'zenpower', 'cpu', 'soc', 'acpitz'];

async function readLinuxCpu() {
  try {
    const base = '/sys/class/thermal';
    const zones = (await fsp.readdir(base)).filter((z) => z.startsWith('thermal_zone'));
    let best = null;
    let bestHinted = null;
    for (const z of zones) {
      try {
        const type = (await fsp.readFile(path.join(base, z, 'type'), 'utf8')).trim().toLowerCase();
        const raw = Number((await fsp.readFile(path.join(base, z, 'temp'), 'utf8')).trim());
        if (!Number.isFinite(raw)) continue;
        const c = raw > 1000 ? raw / 1000 : raw; // millidegrees -> °C
        if (c <= 0 || c > 130) continue;
        best = best == null ? c : Math.max(best, c);
        if (CPU_ZONE_HINTS.some((h) => type.includes(h))) bestHinted = bestHinted == null ? c : Math.max(bestHinted, c);
      } catch { /* skip zone */ }
    }
    return bestHinted != null ? bestHinted : best;
  } catch {
    return null;
  }
}

async function readLinuxAmdGpu() {
  try {
    const drm = '/sys/class/drm';
    const cards = (await fsp.readdir(drm)).filter((c) => /^card\d+$/.test(c));
    let best = null;
    for (const card of cards) {
      const hwmonDir = path.join(drm, card, 'device', 'hwmon');
      let hwmons;
      try { hwmons = await fsp.readdir(hwmonDir); } catch { continue; }
      for (const h of hwmons) {
        try {
          const name = (await fsp.readFile(path.join(hwmonDir, h, 'name'), 'utf8')).trim();
          if (!/amdgpu|radeon/i.test(name)) continue;
          for (const f of await fsp.readdir(path.join(hwmonDir, h))) {
            if (!/^temp\d+_input$/.test(f)) continue;
            const raw = Number((await fsp.readFile(path.join(hwmonDir, h, f), 'utf8')).trim());
            const c = raw > 1000 ? raw / 1000 : raw;
            if (c > 0 && c < 130) best = best == null ? c : Math.max(best, c);
          }
        } catch { /* skip */ }
      }
    }
    return best;
  } catch {
    return null;
  }
}

async function readWindowsCpu() {
  const out = await run('wmic', ['/namespace:\\\\root\\wmi', 'PATH', 'MSAcpi_ThermalZoneTemperature', 'get', 'CurrentTemperature']);
  return parseWmicTemp(out);
}

let cache = null;
let cacheAt = 0;

/** Returns { cpuC, gpuC, available, details } in °C. Cached briefly so polling is cheap. */
async function readTemps({ cacheMs = 2000 } = {}) {
  const now = Date.now();
  if (cache && now - cacheAt < cacheMs) return cache;

  let cpuC = null;
  let gpuC = null;
  const details = {};

  gpuC = await readNvidiaGpu();
  if (gpuC != null) details.gpu = 'nvidia-smi';

  if (process.platform === 'linux') {
    cpuC = await readLinuxCpu();
    if (cpuC != null) details.cpu = 'sysfs';
    if (gpuC == null) {
      gpuC = await readLinuxAmdGpu();
      if (gpuC != null) details.gpu = 'amdgpu';
    }
  } else if (process.platform === 'win32') {
    cpuC = await readWindowsCpu();
    if (cpuC != null) details.cpu = 'wmic';
  }
  // macOS: no reliable no-dependency source; leave null.

  cache = {
    cpuC: cpuC != null ? Math.round(cpuC) : null,
    gpuC: gpuC != null ? Math.round(gpuC) : null,
    available: cpuC != null || gpuC != null,
    details,
    at: now,
  };
  cacheAt = now;
  return cache;
}

function hottest(t) {
  return Math.max(t.cpuC == null ? -Infinity : t.cpuC, t.gpuC == null ? -Infinity : t.gpuC);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * If the system is at/above `maxTempC`, pauses (polling live temps) until it drops back
 * below `resumeTempC` (hysteresis so it doesn't flap), or until `maxWaitMs` elapses.
 * Returns { supported, paused, cooled, temps, waitedMs }. `read`/`sleep` are injectable for tests.
 */
async function maybeCooldown(cfg = {}, deps = {}) {
  const read = deps.read || readTemps;
  const nap = deps.sleep || sleep;
  const onTick = deps.onTick;
  const maxTempC = cfg.maxTempC ?? 85;
  const resumeTempC = cfg.resumeTempC ?? Math.max(0, maxTempC - 10);
  const pollMs = cfg.pollMs ?? 5000;
  const maxWaitMs = cfg.maxWaitMs ?? 5 * 60 * 1000;

  let t = await read();
  let peak = hottest(t);
  if (peak === -Infinity) return { supported: false, paused: false, temps: t };
  if (peak < maxTempC) return { supported: true, paused: false, temps: t };

  const start = Date.now();
  let waitedMs = 0;
  let first = true;
  while (peak >= resumeTempC) {
    if (onTick) onTick({ temps: t, peak, resumeTempC, waitedMs, first });
    first = false;
    if (Date.now() - start >= maxWaitMs) {
      return { supported: true, paused: true, cooled: false, reason: 'timeout', temps: t, waitedMs };
    }
    await nap(pollMs);
    waitedMs = Date.now() - start;
    t = await read();
    peak = hottest(t);
    if (peak === -Infinity) break; // sensors vanished mid-wait - stop blocking
  }
  return { supported: true, paused: true, cooled: peak < resumeTempC, temps: t, waitedMs };
}

module.exports = { readTemps, maybeCooldown, hottest, parseNvidiaSmi, parseWmicTemp };
