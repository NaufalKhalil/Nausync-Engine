import 'dotenv/config';
import path from 'node:path';

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

export const config = {
  ownerNumber: required('OWNER_NUMBER'),
  allowedRoots: parseAllowedRoots(required('ALLOWED_ROOTS')),
  rcloneRemote: required('RCLONE_REMOTE'),
  rcloneStagingFolder: process.env.RCLONE_STAGING_FOLDER || 'nausync-staging',
};
