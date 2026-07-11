import path from 'node:path';
import { config } from './config.js';

/**
 * Pisahkan virtual path (mis. "Documents/Skripsi/bab1.docx") jadi
 * { rootName: "Documents", rest: ["Skripsi", "bab1.docx"] }.
 */
function splitVirtualPath(virtualPath) {
  const normalized = virtualPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  return { rootName: segments[0], rest: segments.slice(1) };
}

/**
 * Resolve virtual path jadi path absolut di filesystem, dan pastikan
 * hasilnya tidak keluar dari root yang bersangkutan (mencegah "../../"
 * traversal, path absolut liar, atau lompat ke drive/folder lain yang
 * tidak di-whitelist).
 *
 * Segment pertama dari path WAJIB nama salah satu root di ALLOWED_ROOTS
 * (mis. "Documents", "D", "Pictures") — ini menggantikan konsep BASE_DIR
 * tunggal yang lama, sekarang bisa banyak folder root sekaligus.
 *
 * Contoh virtual path yang valid:
 *   "Documents"              -> root Documents itu sendiri
 *   "Documents/Skripsi"      -> subfolder di dalam root Documents
 *   "D/Project/app.js"       -> file di dalam root D
 */
export function safeResolve(virtualPath) {
  if (!virtualPath || typeof virtualPath !== 'string') {
    throw new Error('Path kosong atau tidak valid.');
  }

  const { rootName, rest } = splitVirtualPath(virtualPath);

  if (!rootName) {
    throw new Error('Path harus diawali nama folder yang diizinkan. Ketik "list" di root untuk lihat daftarnya.');
  }

  const rootAbsPath = config.allowedRoots[rootName];
  if (!rootAbsPath) {
    const available = listRootNames().join(', ');
    throw new Error(`"${rootName}" bukan folder yang diizinkan. Folder yang tersedia: ${available}`);
  }

  // Bersihkan drive-letter/path absolut liar yang mungkin diselipkan di
  // tengah-tengah segmen (mis. "Documents/C:\Windows") biar tidak bisa
  // "kabur" lewat trik semacam itu.
  const cleanedRest = rest
    .map((seg) => seg.replace(/^[a-zA-Z]:\\?/, ''))
    .join('/');

  const resolved = path.resolve(rootAbsPath, cleanedRest);

  const normalizedRoot = rootAbsPath.endsWith(path.sep) ? rootAbsPath : rootAbsPath + path.sep;

  if (resolved !== rootAbsPath && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Path "${virtualPath}" berada di luar folder "${rootName}" yang diizinkan.`);
  }

  return resolved;
}

/**
 * True kalau virtualPath merujuk PERSIS ke root itu sendiri (bukan isi di
 * dalamnya) — dipakai untuk mencegah delete/move folder root secara utuh
 * (yang bisa menghapus/memindah seluruh folder Documents/Music/dst).
 */
export function isRootItself(virtualPath) {
  const { rootName, rest } = splitVirtualPath(virtualPath);
  return Boolean(rootName) && rest.length === 0 && Boolean(config.allowedRoots[rootName]);
}

/**
 * Daftar nama-nama root yang diizinkan (urut alfabetis), dipakai untuk
 * menampilkan "folder virtual" tingkat atas saat "list"/"help" di root "/".
 */
export function listRootNames() {
  return Object.keys(config.allowedRoots).sort((a, b) => a.localeCompare(b, 'id', { sensitivity: 'base' }));
}
