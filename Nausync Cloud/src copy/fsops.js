import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { safeResolve, isRootItself, isBlocked, containsBlockedPath, listRootNames, confidentialAncestorOf } from './pathGuard.js';
import { config } from './config.js';

// NOTE: fitur "archive" (compress ke .zip) butuh package "archiver" —
// kalau belum terinstall, jalankan `npm install archiver` di folder project.
//
// "archiver" itu package CommonJS, jadi tetap di-load lewat createRequire
// (bukan `import` ES Module) supaya tidak kena masalah interop CJS/ESM
// yang beda-beda antar versi Node.
const require = createRequire(import.meta.url);

// PERUBAHAN PENTING (archiver v8+): package "archiver" versi lama dulu
// dipanggil sebagai FUNGSI langsung — `archiver('zip', options)`. Mulai
// versi 8, API-nya diubah total jadi BERBASIS CLASS: `new ZipArchive(options)`
// (nama export-nya "ZipArchive", bukan lagi default function). Ini BUKAN
// masalah instalasi — memang breaking change resmi dari package-nya
// sendiri (lihat contoh resmi di npm/GitHub archiverjs/node-archiver).
// Ambil class ZipArchive-nya di sini.
const archiverModule = require('archiver');
const ZipArchive = archiverModule.ZipArchive;


// Nama folder trash tersembunyi, dibuat langsung di dalam masing-masing root
// (bukan satu lokasi global) supaya "move ke trash" selalu di drive yang
// sama dengan file aslinya (menghindari error EXDEV kalau root-root ada di
// drive fisik yang berbeda-beda).
const TRASH_DIRNAME = '.trash';

// Nama-nama file "sampah" bawaan OS yang otomatis dibuat Windows/Mac di
// folder mana pun (bukan file yang sengaja dibuat/diisi user), jadi tidak
// perlu ikut ditampilkan di "list" — cuma bikin bingung ("kok ada file
// asing ini?") padahal ini normal dan bukan tanda ada yang aneh:
//
// - desktop.ini  : dibuat Windows otomatis di folder yang pernah di-custom
//                  (ganti icon folder, folder yang di-sync OneDrive, dst).
//                  Ditandai atribut Hidden+System oleh Windows, TAPI atribut
//                  itu murni konsep Windows Explorer — fs.readdir() Node.js
//                  tidak peduli atribut itu sama sekali, jadi tetap kebaca
//                  "on-hidden" oleh bot walau disembunyikan di Explorer.
// - Thumbs.db    : cache thumbnail gambar/video, dibuat Windows Explorer
//                  otomatis di folder yang isinya media.
// - .DS_Store    : versi Mac dari desktop.ini (metadata tampilan folder),
//                  bisa nongol kalau foldernya pernah dibuka di macOS.
//
// Perlakuannya SAMA seperti ".trash": disembunyikan dari hasil "list" di
// SEMUA folder secara otomatis, tapi tetap ada fisik di disk (tidak
// dihapus) — cuma tidak ikut ditampilkan biar listing lebih bersih.
const OS_JUNK_FILENAMES = new Set(['desktop.ini', 'Thumbs.db', '.DS_Store']);

// Cari root absolute path dari sebuah virtual path (mis. "Documents/Skripsi"
// -> path absolut folder "Documents" di ALLOWED_ROOTS). Dipakai buat nentuin
// di mana folder ".trash" masing-masing root berada.
function rootAbsPathFor(virtualPath) {
  const normalized = virtualPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const rootName = normalized.split('/')[0];
  const rootAbsPath = config.allowedRoots[rootName];
  if (!rootAbsPath) {
    throw new Error(`"${rootName}" bukan folder yang diizinkan.`);
  }
  return rootAbsPath;
}

// Tentukan folder ".trash" mana yang harus dipakai untuk sebuah file/folder
// yang mau dihapus (srcAbsPath = path absolut aslinya, virtualPath = path
// virtual yang diketik user, dipakai buat cari root-nya).
//
// BUG LAMA yang diperbaiki di sini: sebelumnya deletePath() SELALU memakai
// ".trash" di root paling atas (mis. "D:/.trash"), walau file yang dihapus
// aslinya berada di dalam folder CONFIDENTIAL (mis.
// "D:/Project/Data Siswa/nilai.xlsx"). Karena "D:/.trash" tidak terdaftar
// di CONFIDENTIAL_PATHS, begitu file itu masuk trash, dia jadi bisa
// di-preview/download TANPA PIN lewat "list" biasa di root "D" — proteksi
// confidential-nya lolos begitu saja gara-gara lokasi trash yang salah.
//
// PERBAIKAN: kalau source path ada di dalam folder confidential, trash-nya
// ditaruh TETAP di dalam folder confidential ASAL itu (subfolder ".trash"
// di dalamnya), bukan di ".trash" milik root. Jadi proteksi PIN-nya ikut
// terbawa ke lokasi barunya. Kalau source BUKAN confidential, perilaku
// lama (trash di root) tetap dipakai seperti biasa.
function trashDirFor(srcAbsPath, virtualPath) {
  const confidentialAncestor = confidentialAncestorOf(srcAbsPath);
  if (confidentialAncestor) {
    return path.join(confidentialAncestor, TRASH_DIRNAME);
  }
  return path.join(rootAbsPathFor(virtualPath), TRASH_DIRNAME);
}

export async function listDir(relPath = '.') {
  // "." = root virtual gabungan semua folder yang diizinkan -> tampilkan
  // nama-nama root itu sendiri sebagai "folder", bukan baca filesystem asli
  // (tidak ada satu folder fisik tunggal yang mewakili gabungan semuanya).
  if (relPath === '.' || relPath === '') {
    return listRootNames().map((name) => `${name}/`);
  }

  const target = safeResolve(relPath);
  const entries = await fs.readdir(target, { withFileTypes: true });
  // Sembunyikan entry yang termasuk BLOCKED_PATHS dari hasil listing folder
  // induknya juga (bukan cuma ditolak saat dibuka langsung), supaya
  // keberadaannya pun tidak terekspos ke user lewat command "list".
  return entries
    .filter((e) => e.name !== TRASH_DIRNAME)
    .filter((e) => !OS_JUNK_FILENAMES.has(e.name))
    .filter((e) => !isBlocked(path.join(target, e.name)))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

export async function copyPath(srcRel, dstRel) {
  const src = safeResolve(srcRel);
  const dst = safeResolve(dstRel);

  // Cegah copy folder yang MENGANDUNG sebuah BLOCKED_PATH di dalamnya (mis.
  // copy "D/Project" yang di dalamnya ada "D/Project/Coding/Nausync Engine"
  // yang di-block) — kalau dibiarkan, isinya akan terduplikat ke lokasi
  // TUJUAN yang boleh jadi TIDAK di-block, sehingga konten sensitif jadi
  // "bocor" ke folder yang bisa diakses bebas walau sumber aslinya aman.
  if (containsBlockedPath(src)) {
    throw new Error(`"${srcRel}" tidak bisa di-copy karena mengandung folder/file yang diblokir (BLOCKED_PATHS) di dalamnya. Copy isi per-item saja, lewati yang diblokir.`);
  }

  // Proteksi overwrite senyap: tanpa ini, fs.copyFile/fs.cp akan MENIMPA
  // file/folder tujuan yang sudah ada tanpa peringatan apa pun — risiko
  // kehilangan data tanpa sadar (mis. typo nama tujuan yang kebetulan sama
  // dengan file penting yang sudah ada). Kalau memang mau timpa, user harus
  // hapus/rename dulu tujuannya secara eksplisit.
  if (fsSync.existsSync(dst)) {
    throw new Error(`"${dstRel}" sudah ada. Copy dibatalkan supaya tidak menimpa data yang sudah ada tanpa sadar — hapus/rename dulu tujuannya kalau memang mau ditimpa.`);
  }

  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.cp(src, dst, { recursive: true });
  } else {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
  }
  return dst;
}

export async function movePath(srcRel, dstRel) {
  if (isRootItself(srcRel)) {
    throw new Error(`"${srcRel}" adalah folder root yang diizinkan itu sendiri, tidak boleh dipindah/di-rename. Pindahkan isinya saja.`);
  }
  const src = safeResolve(srcRel);

  // Sama seperti copyPath: cegah memindah folder INDUK yang di dalamnya ada
  // BLOCKED_PATH — kalau lolos, folder yang di-block ikut pindah ke lokasi
  // baru (yang mungkin tidak di-block), dan lokasi lama yang tadinya
  // dilindungi jadi hilang begitu saja.
  if (containsBlockedPath(src)) {
    throw new Error(`"${srcRel}" tidak bisa dipindah karena mengandung folder/file yang diblokir (BLOCKED_PATHS) di dalamnya. Pindahkan isinya per-item saja, lewati yang diblokir.`);
  }

  const dst = safeResolve(dstRel);

  // Sama seperti copyPath: cegah fs.rename menimpa tujuan yang sudah ada
  // tanpa peringatan (fs.rename di Node akan diam-diam mengganti file
  // tujuan kalau sudah ada, dan untuk folder bisa gagal aneh/menimpa
  // sebagian tergantung OS). Kalau memang mau timpa/rename ke nama yang
  // sudah dipakai, user harus hapus/rename dulu tujuannya secara eksplisit.
  if (fsSync.existsSync(dst)) {
    throw new Error(`"${dstRel}" sudah ada. Move dibatalkan supaya tidak menimpa data yang sudah ada tanpa sadar — hapus/rename dulu tujuannya kalau memang mau ditimpa.`);
  }

  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
  return dst;
}

// "delete" SEKARANG TIDAK PERMANEN — file/folder cuma dipindah ke folder
// ".trash" tersembunyi di dalam root yang sama (bukan langsung dihapus dari
// disk). Nama file di dalam trash ditambah timestamp biar tidak tertukar
// kalau ada nama yang sama dihapus berkali-kali. Buat hapus permanen,
// pakai purgePath() (dipanggil lewat command "purge").
export async function deletePath(relPath) {
  if (isRootItself(relPath)) {
    throw new Error(`"${relPath}" adalah folder root yang diizinkan itu sendiri, tidak boleh dihapus. Hapus isinya saja.`);
  }
  const src = safeResolve(relPath);

  // Cegah menghapus folder INDUK yang di dalamnya ada BLOCKED_PATH — tanpa
  // ini, "delete D/Project" tetap akan memindahkan isi
  // "D/Project/Coding/Nausync Engine" (folder yang di-block) ke trash,
  // walau "D/Project" sendiri lolos dari isBlocked() karena bukan target
  // yang persis di-block.
  if (containsBlockedPath(src)) {
    throw new Error(`"${relPath}" tidak bisa dihapus karena mengandung folder/file yang diblokir (BLOCKED_PATHS) di dalamnya. Hapus isinya per-item saja, lewati yang diblokir.`);
  }

  const trashDir = trashDirFor(src, relPath);
  await fs.mkdir(trashDir, { recursive: true });

  const baseName = path.basename(src);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let trashTarget = path.join(trashDir, `${stamp}__${baseName}`);
  // Jaga-jaga kalau ada nama yang sama persis kebetulan dihapus di detik
  // yang sama (harusnya jarang banget, tapi tetap dijaga biar tidak
  // ketimpa/hilang diam-diam).
  let attempt = 1;
  while (fsSync.existsSync(trashTarget)) {
    trashTarget = path.join(trashDir, `${stamp}-${attempt}__${baseName}`);
    attempt++;
  }

  await fs.rename(src, trashTarget);
  return trashTarget;
}

// Hapus permanen — TIDAK lewat trash, langsung dari disk. Ini logic lama
// yang sebelumnya dipakai deletePath(), sekarang dipisah jadi command
// "purge" sendiri (dengan konfirmasi yes/no di level command.js) supaya
// user tidak kepencet hapus permanen tanpa sadar.
export async function purgePath(relPath) {
  if (isRootItself(relPath)) {
    throw new Error(`"${relPath}" adalah folder root yang diizinkan itu sendiri, tidak boleh dihapus permanen. Hapus isinya saja.`);
  }
  const target = safeResolve(relPath);

  // Sama seperti deletePath, tapi lebih kritis lagi karena purge = hapus
  // PERMANEN tanpa lewat trash — kalau sampai lolos, isi BLOCKED_PATH di
  // dalamnya langsung musnah dari disk tanpa bisa dikembalikan sama sekali.
  if (containsBlockedPath(target)) {
    throw new Error(`"${relPath}" tidak bisa di-purge karena mengandung folder/file yang diblokir (BLOCKED_PATHS) di dalamnya. Purge isinya per-item saja, lewati yang diblokir.`);
  }

  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
  } else {
    await fs.unlink(target);
  }
  return target;
}

export function resolveForRclone(relPath) {
  return safeResolve(relPath);
}

// --- Auto-purge trash setelah retensi habis (config.trashRetentionDays) ---
//
// KENAPA INI PERLU: "delete" cuma memindah ke ".trash" (tidak permanen),
// dan sebelumnya tidak ada mekanisme apa pun yang membersihkannya lagi
// kecuali user manual jalanin "purge" satu-satu. Kalau dibiarkan, trash
// menumpuk selamanya dan diam-diam menghabiskan storage — padahal user
// mungkin sudah lama lupa isinya (dan tidak butuh lagi).
//
// Dikumpulkan dari SEMUA lokasi trash yang mungkin dipakai bot: ".trash"
// di tiap root (root-level, lihat trashDirFor di atas), DITAMBAH ".trash"
// di dalam tiap CONFIDENTIAL_PATHS (karena file dari folder rahasia
// sengaja ditrash ke situ, bukan ke ".trash" root, biar proteksi PIN-nya
// ikut terbawa — lihat komentar trashDirFor()).
function allTrashDirs() {
  const dirs = new Set();
  for (const rootAbsPath of Object.values(config.allowedRoots)) {
    dirs.add(path.join(rootAbsPath, TRASH_DIRNAME));
  }
  for (const confidentialPath of config.confidentialPaths) {
    dirs.add(path.join(confidentialPath, TRASH_DIRNAME));
  }
  return [...dirs];
}

// Sapu semua folder trash, hapus PERMANEN item yang sudah lebih tua dari
// config.trashRetentionDays (dihitung dari mtime item itu di dalam trash —
// yaitu waktu dia DIPINDAH ke trash, karena deletePath melakukan fs.rename
// yang set ulang mtime). Dipanggil rutin (harian) dari index.js, bukan
// sesuatu yang dipicu command user.
//
// Return array path yang berhasil dihapus permanen, buat dilaporkan lewat
// email/log oleh pemanggilnya.
export async function purgeExpiredTrash() {
  const cutoffMs = config.trashRetentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const purged = [];

  for (const trashDir of allTrashDirs()) {
    let entries;
    try {
      entries = await fs.readdir(trashDir, { withFileTypes: true });
    } catch {
      // Trash dir belum pernah dibuat, atau root-nya lagi tidak ke-mount
      // (mis. drive eksternal dicabut) -> lewati, bukan error fatal.
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(trashDir, entry.name);
      let stat;
      try {
        stat = await fs.stat(entryPath);
      } catch {
        continue;
      }

      const ageMs = now - stat.mtimeMs;
      if (ageMs < cutoffMs) continue;

      try {
        await fs.rm(entryPath, { recursive: true, force: true });
        purged.push(entryPath);
      } catch (err) {
        console.warn(`⚠️ Gagal auto-purge trash "${entryPath}": ${err.message}`);
      }
    }
  }

  return purged;
}

// Compress srcAbsPath (file ATAU folder) jadi satu file .zip di
// destZipAbsPath. Dipakai command "archive" — tujuannya bikin transfer ke
// Google Drive lebih hemat bandwidth/waktu buat folder isinya banyak file
// kecil (1 koneksi upload, bukan ratusan file kecil satu-satu).
//
// Sengaja return Promise manual (bukan async/await polos) karena stream
// `archiver` berbasis event ('close'/'error'), bukan sesuatu yang bisa
// di-await langsung.
export function createZip(srcAbsPath, destZipAbsPath) {
  return new Promise((resolve, reject) => {
    // Cek di sini (BUKAN di top-level file) supaya kalau package "archiver"
    // bermasalah, cuma command "archive" ini yang gagal dengan pesan jelas —
    // command lain (list/copy/preview/dll) tetap jalan normal, bot tidak
    // ikut mati total.
    if (typeof ZipArchive !== 'function') {
      reject(new Error(
        'Package "archiver" tidak menyediakan class "ZipArchive" (kemungkinan ' +
        'versi package-nya belum sesuai/terlalu lama, atau instalasinya rusak). ' +
        'Coba jalankan "npm ls archiver" di folder project (lewat Command Prompt/' +
        'PowerShell, BUKAN lewat Discord) untuk cek versinya — kode ini butuh ' +
        'archiver versi 8 ke atas yang API-nya berbasis "ZipArchive" class.'
      ));
      return;
    }

    let stat;
    try {
      stat = fsSync.statSync(srcAbsPath);
    } catch (err) {
      reject(err);
      return;
    }

    const output = fsSync.createWriteStream(destZipAbsPath);
    // API BARU (archiver v8+): instantiate class-nya, bukan panggil sebagai
    // fungsi seperti versi lama (`archiver('zip', options)`).
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on('close', () => resolve(destZipAbsPath));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    if (stat.isDirectory()) {
      archive.directory(srcAbsPath, path.basename(srcAbsPath));
    } else {
      archive.file(srcAbsPath, { name: path.basename(srcAbsPath) });
    }

    archive.finalize();
  });
}
