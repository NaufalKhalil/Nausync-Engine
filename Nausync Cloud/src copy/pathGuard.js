import fs from 'node:fs';
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

  if (isBlocked(resolved)) {
    throw new Error(`Path "${virtualPath}" adalah folder/file yang diblokir dan tidak boleh diakses.`);
  }

  // --- Pertahanan symlink-escape ---
  // Semua pengecekan di atas cuma memvalidasi STRING path-nya (mencegah
  // "../../" dsb). Tapi kalau di dalam salah satu ALLOWED_ROOTS ada
  // symlink (dibuat sengaja atau tidak sengaja oleh program lain) yang
  // menunjuk ke folder di LUAR root itu, string path-nya tetap kelihatan
  // "aman" walau lokasi FISIK sebenarnya di disk sudah keluar sandbox —
  // fs.readdir/fs.cp/fs.rename Node.js otomatis mengikuti symlink itu
  // tanpa peduli batas ALLOWED_ROOTS.
  //
  // fs.realpathSync() mengikuti SEMUA symlink di sepanjang path (termasuk
  // folder induknya, bukan cuma target akhir), jadi hasilnya adalah lokasi
  // fisik sebenarnya. Kalau itu ternyata sudah keluar dari root asli, tolak.
  //
  // Path yang BELUM ada di disk (mis. tujuan "copy"/"move" yang baru mau
  // dibuat) akan gagal realpath dengan ENOENT — itu normal & tidak masalah,
  // karena belum ada apa pun yang bisa "kabur" lewat symlink yang belum
  // exist. Biarkan lolos, nanti fs.mkdir/fs.rename yang benar-benar
  // membuatnya di lokasi `resolved` yang sudah tervalidasi.
  let realResolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    realResolved = null;
  }

  if (realResolved) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(rootAbsPath);
    } catch {
      realRoot = rootAbsPath;
    }
    const normalizedRealTarget = normalizeForCompare(realResolved);
    const normalizedRealRoot = normalizeForCompare(realRoot);
    const realRootWithSep = normalizedRealRoot.endsWith(path.sep) ? normalizedRealRoot : normalizedRealRoot + path.sep;

    if (normalizedRealTarget !== normalizedRealRoot && !normalizedRealTarget.startsWith(realRootWithSep)) {
      throw new Error(`Path "${virtualPath}" mengarah lewat symlink ke luar folder "${rootName}" yang diizinkan — akses ditolak.`);
    }
  }

  return resolved;
}

/**
 * True kalau absPath (path filesystem absolut, hasil resolve) sama dengan,
 * atau berada DI DALAM, salah satu folder/file yang didaftarkan di
 * BLOCKED_PATHS — dipakai untuk mengecualikan folder sensitif (mis. folder
 * project bot ini sendiri yang berisi .env) walaupun berada di dalam root
 * yang diizinkan (mis. root "D" yang mencakup seluruh drive D:).
 */
// Windows tidak peduli huruf besar/kecil pada nama folder ("D:\Project" dan
// "D:\PROJECT" adalah folder yang SAMA di disk), tapi perbandingan string
// biasa (startsWith) itu case-SENSITIVE. Tanpa normalisasi ini, path yang
// diketik beda kapitalisasi dari BLOCKED_PATHS/CONFIDENTIAL_PATHS bisa lolos
// dari pengecekan padahal menyasar folder fisik yang sama persis. Di
// Linux/Mac (di mana filesystem umumnya case-sensitive), perbandingan tetap
// apa adanya.
function normalizeForCompare(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

export function isBlocked(absPath) {
  const target = normalizeForCompare(absPath);
  return config.blockedPaths.some((blocked) => {
    const b = normalizeForCompare(blocked);
    if (target === b) return true;
    const normalizedBlocked = b.endsWith(path.sep) ? b : b + path.sep;
    return target.startsWith(normalizedBlocked);
  });
}

/**
 * True kalau absPath sama dengan, atau berada DI DALAM, salah satu folder
 * di CONFIDENTIAL_PATHS. Beda dengan isBlocked(): folder confidential masih
 * boleh muncul di "list" (namanya kelihatan), tapi command yang MEMBACA
 * ISINYA (preview/download) wajib PIN + trigger email alert — lihat
 * commands.js.
 */
export function isConfidential(absPath) {
  const target = normalizeForCompare(absPath);
  return config.confidentialPaths.some((confidential) => {
    const c = normalizeForCompare(confidential);
    if (target === c) return true;
    const normalized = c.endsWith(path.sep) ? c : c + path.sep;
    return target.startsWith(normalized);
  });
}

/**
 * Cari path confidential (dari CONFIDENTIAL_PATHS) yang menjadi LELUHUR
 * (atau sama persis dengan) absPath — kembalikan path confidential asli
 * (bukan absPath itu sendiri) kalau ketemu, atau null kalau absPath tidak
 * ada di dalam folder confidential mana pun.
 *
 * KENAPA INI PERLU: deletePath() di fsops.js memindahkan file ke ".trash"
 * di dalam ROOT (mis. "D:/.trash"), bukan di lokasi asli file itu berada.
 * Tanpa fungsi ini, menghapus file dari folder confidential (mis.
 * "D:/Project/Data Siswa/nilai.xlsx") akan membuat file itu "naik keluar"
 * dari perlindungan CONFIDENTIAL_PATHS begitu masuk ".trash" di root —
 * padahal isinya tetap sama sensitifnya, cuma lokasinya berubah. Dipakai
 * fsops.js untuk menaruh trash-nya TETAP di dalam folder confidential
 * asal (bukan di ".trash" milik root), supaya proteksi PIN-nya ikut
 * terbawa walau file sudah "dihapus" (dipindah ke trash).
 */
export function confidentialAncestorOf(absPath) {
  const target = normalizeForCompare(absPath);
  let best = null;
  for (const confidential of config.confidentialPaths) {
    const c = normalizeForCompare(confidential);
    const normalized = c.endsWith(path.sep) ? c : c + path.sep;
    if (target === c || target.startsWith(normalized)) {
      // Ambil yang paling SPESIFIK (path terpanjang) kalau ada beberapa
      // confidential path yang bersarang (mis. "D/Project" dan
      // "D/Project/Data Siswa" sama-sama terdaftar).
      if (!best || confidential.length > best.length) {
        best = confidential;
      }
    }
  }
  return best;
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
 * True kalau absPath adalah folder LELUHUR (ancestor) dari salah satu
 * BLOCKED_PATHS — arah kebalikan dari isBlocked(). isBlocked() menjawab
 * "apakah target ada DI DALAM sesuatu yang di-block?"; fungsi ini menjawab
 * "apakah target ADALAH folder yang MENGANDUNG sesuatu yang di-block, di
 * kedalaman berapa pun?"
 *
 * Ini WAJIB dicek sebelum operasi yang bersifat rekursif/menyapu seluruh isi
 * folder (delete/purge/move) — karena tanpa ini, menghapus folder induk yang
 * tidak masuk BLOCKED_PATHS (mis. "D/Project") tetap akan ikut menghapus isi
 * BLOCKED_PATHS yang ada di dalamnya (mis. "D/Project/Coding/Nausync
 * Engine"), sebab operasi filesystem (fs.rename/fs.rm) tidak tahu-menahu
 * soal daftar blokir — dia cuma diberi tahu "hapus folder ini dan semua
 * isinya".
 */
export function containsBlockedPath(absPath) {
  const target = normalizeForCompare(absPath);
  const normalizedTarget = target.endsWith(path.sep) ? target : target + path.sep;
  return config.blockedPaths.some((blocked) => normalizeForCompare(blocked).startsWith(normalizedTarget));
}

/**
 * Daftar nama-nama root yang diizinkan (urut alfabetis), dipakai untuk
 * menampilkan "folder virtual" tingkat atas saat "list"/"help" di root "/".
 *
 * Hanya root yang PATH-nya benar-benar ada di filesystem saat ini yang
 * ditampilkan — mis. root untuk SD card/drive eksternal yang belum dicolok
 * otomatis disembunyikan dari daftar, tanpa perlu restart bot. Begitu
 * drive-nya dicolok lagi, root itu otomatis muncul lagi di command
 * berikutnya (dicek ulang tiap kali fungsi ini dipanggil, bukan di-cache).
 */
export function listRootNames() {
  return Object.keys(config.allowedRoots)
    .filter((name) => fs.existsSync(config.allowedRoots[name]))
    .sort((a, b) => a.localeCompare(b, 'id', { sensitivity: 'base' }));
}
