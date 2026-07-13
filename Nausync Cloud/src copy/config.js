import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Environment variable ${name} belum diset. Cek file .env`);
  }
  return val;
}

// Parse ALLOWED_ROOTS jadi map { namaFolder: absolutePath }.
//
// Format di .env: "Nama1=Path1;Nama2=Path2;..."
// - Nama dipakai sebagai "folder virtual" tingkat atas di bot (mis. "Documents").
// - Path boleh pakai "/" atau "\" (Node otomatis normalize di Windows), dan
//   boleh mengandung spasi tanpa perlu tanda kutip.
//
// Contoh:
//   ALLOWED_ROOTS=D=D:/;Documents=C:/Users/Naufal Khalil/Documents;Music=C:/Users/Naufal Khalil/Music
function parseAllowedRoots(raw) {
  const roots = {};
  const entries = raw.split(';').map((e) => e.trim()).filter(Boolean);

  if (entries.length === 0) {
    throw new Error('ALLOWED_ROOTS kosong. Cek file .env, format: Nama1=Path1;Nama2=Path2');
  }

  for (const entry of entries) {
    const idx = entry.indexOf('=');
    if (idx === -1) {
      throw new Error(`Format ALLOWED_ROOTS salah pada entry "${entry}". Gunakan Nama=Path`);
    }

    const name = entry.slice(0, idx).trim();
    const dir = entry.slice(idx + 1).trim();

    if (!name || !dir) {
      throw new Error(`Format ALLOWED_ROOTS salah pada entry "${entry}". Nama & path tidak boleh kosong.`);
    }

    // Nama root dipakai sebagai "folder virtual" tingkat atas (mis. "Documents"),
    // jadi tidak boleh mengandung "/" atau "\" biar tidak ambigu dengan path asli.
    if (/[\\/]/.test(name)) {
      throw new Error(`Nama root "${name}" tidak boleh mengandung "/" atau "\\".`);
    }
    if (roots[name]) {
      throw new Error(`Nama root "${name}" dipakai dua kali di ALLOWED_ROOTS. Nama harus unik.`);
    }

    roots[name] = path.resolve(dir);
  }

  return roots;
}

// Parse BLOCKED_PATHS jadi array path absolut yang DILARANG diakses bot,
// walaupun path itu ada di dalam salah satu ALLOWED_ROOTS.
//
// Format di .env: "Path1;Path2;..." (path absolut, boleh pakai "/" atau "\").
// Berguna untuk mengecualikan folder sensitif seperti folder project bot ini
// sendiri (yang berisi file .env dengan token/kredensial), padahal folder
// itu ada di dalam root "D" yang diizinkan.
//
// Contoh:
//   BLOCKED_PATHS=D:/Project/Coding/Nausync Engine;D:/Project/Rahasia
function parseBlockedPaths(raw) {
  if (!raw) return [];
  return raw
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

// Parse CONFIDENTIAL_PATHS jadi array path absolut yang BOLEH diakses lewat
// "list" (masih kelihatan namanya), tapi WAJIB PIN + kirim alert email kalau
// mau di-preview/download isinya. Beda dengan BLOCKED_PATHS yang benar-benar
// disembunyikan total — folder "rahasia" di sini memang kamu tahu isinya
// ada, cuma kontennya dianggap sensitif (mis. scan KTP, dokumen keuangan).
//
// Format di .env sama seperti BLOCKED_PATHS: "Path1;Path2;..."
function parseConfidentialPaths(raw) {
  if (!raw) return [];
  return raw
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

// --- Kredensial rahasia (SMTP + email alert PIN) DIPISAH dari .env utama ---
//
// Alasannya: .env utama biasanya lebih "banyak disentuh" (dibuka pas
// setup ulang, di-share ke tempat lain, dsb), jadi risiko bocornya lebih
// tinggi (ke-commit ke git, ke-screenshot, dsb). Kalau kredensial SMTP dan
// email alert PIN ikut nyampur di file yang sama, satu kebocoran .env
// utama otomatis membongkar JALUR notifikasi keamanan PIN itu juga —
// yang justru harusnya jadi "kanal cadangan" independen kalau .env utama
// (atau Discord) kena hack.
//
// Solusinya: .env utama cuma nyimpen LOKASI file kedua ini
// (SECURE_ENV_PATH), bukan isi kredensialnya. File kedua ini:
// - taruh di folder LAIN (idealnya di luar folder project bot ini sama
//   sekali, mis. "D:/Rahasia/nausync-secure.env"), supaya kalau folder
//   project ke-zip/ke-share/ke-backup, file ini tidak ikut kebawa.
// - sebaiknya juga didaftarkan ke BLOCKED_PATHS di .env utama, supaya
//   bot sendiri (lewat command list/copy/download) tidak akan pernah
//   bisa membaca/mengekspos isi file ini walau folder induknya ada di
//   dalam salah satu ALLOWED_ROOTS.
// - di Windows, batasi permission file-nya (klik kanan > Properties >
//   Security) supaya cuma akun Windows-mu sendiri yang bisa baca.
//
// Format isi file SECURE_ENV_PATH sama seperti .env biasa:
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=465
//   SMTP_USER=emailkuyangkirim@gmail.com
//   SMTP_PASS=app_password_16_digit
//   PIN_ALERT_EMAIL=emailrahasiaku_beda@gmail.com
function loadSecureEnv() {
  const securePath = path.resolve(required('SECURE_ENV_PATH'));

  if (!fs.existsSync(securePath)) {
    throw new Error(`File SECURE_ENV_PATH ("${securePath}") tidak ditemukan. Buat file itu dulu (lihat komentar di config.js untuk formatnya).`);
  }

  // Sengaja pakai dotenv.parse() manual (bukan dotenv.config({path})), biar
  // nilai-nilainya TIDAK ikut nimbun ke process.env global — cukup lewat
  // sebagai object lokal ke config di bawah, jadi kalau ada bagian lain
  // dari kode (atau dependency pihak ketiga) yang somehow dump seluruh
  // process.env buat debug, kredensial ini tidak ikut kebongkar di situ.
  const parsed = dotenv.parse(fs.readFileSync(securePath, 'utf-8'));

  function needSecure(key) {
    if (!parsed[key]) {
      throw new Error(`"${key}" belum diset di file secure env (${securePath}).`);
    }
    return parsed[key];
  }

  return {
    smtpHost: needSecure('SMTP_HOST'),
    smtpPort: parseInt(needSecure('SMTP_PORT'), 10),
    smtpUser: needSecure('SMTP_USER'),
    smtpPass: needSecure('SMTP_PASS'),
    pinAlertEmail: needSecure('PIN_ALERT_EMAIL'),
  };
}

// Berapa hari item di dalam ".trash" (hasil "delete") dibiarkan sebelum
// otomatis dihapus PERMANEN oleh sweep harian (lihat purgeExpiredTrash() di
// fsops.js & pemanggilnya di index.js). Default 30 hari kalau tidak diset
// di .env (TRASH_RETENTION_DAYS=45, misalnya). Ini bukan pengganti "purge"
// manual — cuma jaring pengaman supaya trash tidak menumpuk selamanya dan
// makan storage tanpa disadari.
function parseTrashRetentionDays(raw) {
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export const config = {
  allowedRoots: parseAllowedRoots(required('ALLOWED_ROOTS')),
  blockedPaths: parseBlockedPaths(process.env.BLOCKED_PATHS),
  confidentialPaths: parseConfidentialPaths(process.env.CONFIDENTIAL_PATHS),
  rcloneRemote: required('RCLONE_REMOTE'),
  rcloneStagingFolder: process.env.RCLONE_STAGING_FOLDER || 'nausync-staging',
  trashRetentionDays: parseTrashRetentionDays(process.env.TRASH_RETENTION_DAYS),

  // --- Konfigurasi PIN keamanan (lihat pinStore.js) ---
  // Kredensialnya sendiri dimuat dari file TERPISAH (loadSecureEnv di
  // atas), bukan dari .env utama ini — lihat SECURE_ENV_PATH.
  ...loadSecureEnv(),
};
