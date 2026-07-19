'use strict';

const exifr = require('exifr');
const mm = require('music-metadata');
const { sanitizeName } = require('./projectDetect');

/** Returns "YYYY/MM" subpath for a photo using EXIF capture date, or null if unavailable. */
async function getPhotoDateSubpath(filePath) {
  try {
    const data = await exifr.parse(filePath, ['DateTimeOriginal', 'CreateDate']);
    const date = data?.DateTimeOriginal || data?.CreateDate;
    if (!date) return null;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    const yyyy = d.getFullYear();
    const mmStr = String(d.getMonth() + 1).padStart(2, '0');
    return `${yyyy}/${mmStr}`;
  } catch {
    return null;
  }
}

/** Returns "Artist/Album" subpath for a music file using ID3/Vorbis/etc tags, or null. */
async function getMusicTagSubpath(filePath) {
  try {
    const metadata = await mm.parseFile(filePath, { duration: false, skipCovers: true });
    const artist = metadata?.common?.albumartist || metadata?.common?.artist;
    const album = metadata?.common?.album;
    if (!artist && !album) return null;
    const parts = [];
    if (artist) parts.push(sanitizeName(artist.trim()));
    if (album) parts.push(sanitizeName(album.trim()));
    return parts.join('/');
  } catch {
    return null;
  }
}

module.exports = { getPhotoDateSubpath, getMusicTagSubpath };
