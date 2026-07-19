'use strict';

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null; // optional feature - degrade gracefully if unavailable
}

const HASHABLE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif']);

function isPerceptuallyHashable(ext) {
  return !!sharp && HASHABLE_EXT.has(ext);
}

/** Computes a 64-bit difference hash (dHash) for an image, returned as a hex string. */
async function computeDHash(filePath) {
  if (!sharp) return null;
  try {
    const { data } = await sharp(filePath)
      .resize(9, 8, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let bits = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = data[row * 9 + col];
        const right = data[row * 9 + col + 1];
        bits += left < right ? '1' : '0';
      }
    }
    // pack the 64-bit binary string into hex
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return null;
  }
}

function hammingDistanceHex(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

/**
 * Groups files by visual similarity (Hamming distance <= threshold on their dHash).
 * Input: array of { id, hash } where hash is the dHash hex string (nulls are ignored).
 * Returns array of groups, each an array of ids, only for groups with 2+ members.
 */
function groupBySimilarity(items, threshold = 6) {
  const valid = items.filter((it) => it.hash);
  const groups = [];
  const assigned = new Set();

  for (let i = 0; i < valid.length; i++) {
    if (assigned.has(valid[i].id)) continue;
    const group = [valid[i].id];
    for (let j = i + 1; j < valid.length; j++) {
      if (assigned.has(valid[j].id)) continue;
      if (hammingDistanceHex(valid[i].hash, valid[j].hash) <= threshold) {
        group.push(valid[j].id);
        assigned.add(valid[j].id);
      }
    }
    if (group.length > 1) {
      assigned.add(valid[i].id);
      groups.push(group);
    }
  }
  return groups;
}

module.exports = { isPerceptuallyHashable, computeDHash, groupBySimilarity, sharpAvailable: !!sharp };
