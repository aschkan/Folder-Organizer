'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseNvidiaSmi, parseWmicTemp, maybeCooldown, hottest } = require('../lib/thermal');

test('parseNvidiaSmi takes the hottest GPU and ignores junk', () => {
  assert.equal(parseNvidiaSmi('56\n61\n'), 61);
  assert.equal(parseNvidiaSmi('72'), 72);
  assert.equal(parseNvidiaSmi(''), null);
  assert.equal(parseNvidiaSmi('N/A'), null);
});

test('parseWmicTemp converts tenths-of-Kelvin to °C and skips the header', () => {
  const c = parseWmicTemp('CurrentTemperature\n3200\n3032\n');
  assert.ok(Math.abs(c - 46.85) < 0.1, `got ${c}`);
  assert.equal(parseWmicTemp('CurrentTemperature\n'), null);
});

test('hottest returns the max of whichever sensors are present', () => {
  assert.equal(hottest({ cpuC: 50, gpuC: 70 }), 70);
  assert.equal(hottest({ cpuC: 80, gpuC: null }), 80);
  assert.equal(hottest({ cpuC: null, gpuC: null }), -Infinity);
});

test('maybeCooldown does nothing when temps are unreadable', async () => {
  const res = await maybeCooldown({ maxTempC: 85 }, { read: async () => ({ cpuC: null, gpuC: null }), sleep: async () => {} });
  assert.equal(res.supported, false);
  assert.equal(res.paused, false);
});

test('maybeCooldown does not pause when below the threshold', async () => {
  const res = await maybeCooldown({ maxTempC: 85, resumeTempC: 75 }, { read: async () => ({ cpuC: 50, gpuC: 60 }), sleep: async () => {} });
  assert.equal(res.paused, false);
});

test('maybeCooldown pauses when hot and resumes once cooled (hysteresis)', async () => {
  const readings = [{ cpuC: null, gpuC: 90 }, { cpuC: null, gpuC: 80 }, { cpuC: null, gpuC: 70 }];
  let i = 0;
  const ticks = [];
  const res = await maybeCooldown(
    { maxTempC: 85, resumeTempC: 75, pollMs: 1, maxWaitMs: 10000 },
    { read: async () => readings[Math.min(i++, readings.length - 1)], sleep: async () => {}, onTick: (info) => ticks.push(info.peak) },
  );
  assert.equal(res.paused, true);
  assert.equal(res.cooled, true);        // last reading (70) < resume (75)
  assert.ok(ticks.length >= 1);          // it reported at least one cooling tick
});

test('maybeCooldown gives up (and resumes anyway) after maxWaitMs', async () => {
  const res = await maybeCooldown(
    { maxTempC: 85, resumeTempC: 75, pollMs: 1, maxWaitMs: 0 },
    { read: async () => ({ cpuC: null, gpuC: 95 }), sleep: async () => {} },
  );
  assert.equal(res.paused, true);
  assert.equal(res.cooled, false);
  assert.equal(res.reason, 'timeout');
});
