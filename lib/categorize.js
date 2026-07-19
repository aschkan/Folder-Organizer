'use strict';

// Extension -> category map. Keys are lowercase extensions WITHOUT the dot.
const CATEGORY_MAP = {
  music: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus', 'aiff', 'aif', 'alac', 'mid', 'midi'],
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'vob', 'ogv', 'insv', 'lrv', '360', 'mts', 'm2ts', 'mxf', 'braw', 'r3d'],
  images: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'tif', 'heic', 'heif', 'raw', 'cr2', 'nef', 'ico', 'psd', 'ai', 'eps'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'csv', 'md', 'pages', 'numbers', 'key', 'eml', 'msg', 'tex', 'one'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'z', 'cab', 'zst', 'lz', 'lzma', 'arj'],
  disk_images: ['iso', 'img', 'dmg', 'bin', 'nrg'],
  virtual_machines: ['vmdk', 'vdi', 'vhd', 'vhdx', 'ova', 'ovf', 'qcow2', 'vbox', 'vmx', 'vmsn', 'vmsd'],
  executables: ['exe', 'msi', 'apk', 'pkg', 'deb', 'rpm', 'appimage', 'app', 'jar', 'msix', 'appx', 'flatpak', 'snap'],
  code: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rb', 'php', 'html', 'htm', 'css', 'scss', 'json', 'xml', 'yaml', 'yml', 'sh', 'bat', 'ps1', 'sql', 'ipynb', 'vue', 'swift', 'kt', 'rs', 'ino', 'prototxt', 'lua', 'pl', 'dart', 'r', 'scala', 'ttl', 'rdf'],
  fonts: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
  ebooks: ['epub', 'mobi', 'azw', 'azw3', 'fb2'],
  // AI / machine-learning model weights and checkpoints
  models: ['pt', 'pth', 'onnx', 'h5', 'hdf5', 'caffemodel', 'pb', 'tflite', 'gguf', 'ggml', 'safetensors', 'ckpt', 'pkl', 'joblib', 'npz', 'npy', 'mlmodel', 'pmml', 'weights'],
  // installable software packages (not archives you'd browse)
  packages: ['whl', 'egg', 'gem', 'nupkg', 'crate', 'vsix', 'xpi', 'crx'],
  // databases and their backing files
  databases: ['db', 'sqlite', 'sqlite3', 'sst', 'ldb', 'mdb', 'accdb', 'dbf', 'myd', 'wal', 'realm'],
  // structured data blobs
  data: ['dat', 'parquet', 'avro', 'nt', 'ndjson', 'tsv', 'pickle', 'arrow', 'feather', 'orc'],
  // desktop / web shortcuts
  shortcuts: ['lnk', 'url', 'webloc'],
  // config / profile files
  config: ['conf', 'cfg', 'ini', 'toml', 'properties', 'plist', 'mobileconfig', 'ovpn', 'service', 'ehi', 'reg'],
};

// Reverse lookup map built once: extension -> category
const EXT_TO_CATEGORY = new Map();
for (const [category, exts] of Object.entries(CATEGORY_MAP)) {
  for (const ext of exts) EXT_TO_CATEGORY.set(ext, category);
}

const OTHERS = 'others';

// Categories that aren't driven by a file extension but are still valid destinations
// (e.g. whole application/program folders preserved intact). Kept in the known set so
// the LLM may pick them and the UI lists them.
const EXTRA_CATEGORIES = ['applications', 'web_pages'];

function getExtension(filename) {
  const idx = filename.lastIndexOf('.');
  if (idx === -1 || idx === filename.length - 1 || idx === 0) return '';
  return filename.slice(idx + 1).toLowerCase();
}

/**
 * Returns a category for a filename using the static extension map only.
 * Returns null if unknown (caller may then try the LLM or fall back to "others").
 */
function categorizeByExtension(filename) {
  const ext = getExtension(filename);
  if (!ext) return null;
  return EXT_TO_CATEGORY.get(ext) || null;
}

function knownCategories() {
  return [...Object.keys(CATEGORY_MAP), ...EXTRA_CATEGORIES, OTHERS];
}

module.exports = { categorizeByExtension, knownCategories, getExtension, OTHERS, CATEGORY_MAP, EXTRA_CATEGORIES };
