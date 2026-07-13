import { listDir, copyPath, movePath, deletePath, purgePath, resolveForRclone, createZip } from './fsops.js';
import { listRootNames, isConfidential, containsBlockedPath, safeResolve } from './pathGuard.js';
import { uploadToDrive } from './rclone.js';
import { config } from './config.js';
import fs from 'fs';
import path from 'node:path';
import os from 'node:os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { verifyPin, changePin, verifyAndRotatePin, sendAlertEmail } from './pinStore.js';

const execAsync = promisify(exec);

// --- Batas ukuran yang wajib PIN (copy/download/archive) ---
// Bukan cuma soal keamanan (cegah hacker yang berhasil masuk Discord asal
// copy/download berulang-ulang), tapi juga proteksi teknis: transfer file
// gede tanpa PIN gate bisa bikin bot ke-flood command yang sama berkali2
// (RAM/CPU numpuk dari beberapa proses rclone/compress paralel) dan bikin
// storage lokal + Google Drive penuh tak terkendali kalau di-spam.
const PIN_SIZE_THRESHOLD = 50 * 1024 * 1024; // 50MB

// Dipakai di command berbahaya (shutdown/restart/purge/dll): ambil argumen
// TERAKHIR sebagai PIN, verifikasi, dan return sisa argumen sebelumnya
// (argumen "asli" command itu, tanpa PIN-nya). Lempar Error kalau PIN
// salah/kosong/lockout — otomatis ke-catch oleh try/catch di handleCommand
// dan tampil sebagai balasan "Gagal: ...".
// `reason` dipakai buat 2 hal: (1) label di email rotasi PIN otomatis
// (lihat verifyAndRotatePin di pinStore.js), (2) label di email alert
// "command berhasil dieksekusi" yang dikirim SETELAH aksi command-nya
// benar-benar selesai (lihat pemanggilan sendAlertEmail di tiap case).
async function requirePin(args, reason) {
  if (args.length === 0) {
    throw new Error('Command ini butuh PIN keamanan di argumen terakhir. Contoh: `shutdown Ab3xQ9kZ`.');
  }
  const pin = args[args.length - 1];
  await verifyAndRotatePin(pin, reason);
  return args.slice(0, -1);
}

// Penanda versi kode yang sedang berjalan — tampil di log startup (index.js)
// dan di "help", supaya gampang mastiin apakah bot beneran udah pakai file
// commands.js terbaru atau masih versi lama (mis. abis edit tapi restart-nya
// gagal reload / salah file yang ditimpa). Naikkan angkanya tiap kali bikin
// perubahan besar ke command handling.
export const BUILD_TAG = 'cmds-v12-network-status';

// --- FITUR: "current directory" per sesi bot, biar user tidak perlu ketik ---
// path panjang berulang-ulang tiap mau list/copy/move/delete/download.
// Konsepnya mirip `cd` di terminal: sekali pindah folder dengan "cd <folder>",
// command lain (list, copy, move, delete, download) otomatis dianggap relatif
// terhadap folder itu, kecuali user awali dengan "/" (artinya relatif ke root
// BASE_DIR) atau pakai "..".
// State ini disimpan di memory proses (bukan per-user), cukup karena bot ini
// memang cuma dipakai 1 owner.
let currentDir = '.'; // relatif terhadap BASE_DIR, pakai format "/"

// Menyimpan hasil "list" TERAKHIR (array virtual path lengkap, urut sesuai
// nomor yang ditampilkan ke user), supaya user bisa merujuk item lewat
// nomornya pakai ":<angka>" alih-alih ngetik ulang nama folder/file yang
// panjang. Contoh: abis "list Documents" nampilin "2. 📁 Skripsi/", user
// bisa langsung "cd :2" tanpa ngetik "cd Skripsi".
//
// Sengaja pakai prefix ":" (bukan angka polos) karena ":" adalah salah satu
// karakter yang TIDAK VALID di nama file/folder Windows — jadi ":3" pasti
// tidak akan pernah tertukar/bentrok dengan nama file/folder asli yang
// kebetulan berupa angka. State ini di-reset tiap kali "list" baru
// dijalankan (bukan per-user, cukup karena bot ini cuma dipakai 1 owner).
let lastListing = [];

// Deteksi argumen berformat ":<angka>" (persis titik dua diikuti digit,
// tanpa apa pun lagi) dan terjemahkan jadi virtual path lengkap dari hasil
// "list" terakhir. Return null kalau inputPath bukan format index (berarti
// harus diproses sebagai path biasa oleh resolvePathArg).
function resolveIndexRef(inputPath) {
  const match = /^:(\d+)$/.exec(inputPath);
  if (!match) return null;

  if (lastListing.length === 0) {
    throw new Error('Belum ada hasil "list" yang bisa dirujuk pakai nomor. Jalankan "list" dulu.');
  }

  const idx = parseInt(match[1], 10) - 1;
  if (idx < 0 || idx >= lastListing.length) {
    throw new Error(`Nomor ":${match[1]}" tidak ada di hasil "list" terakhir (cuma ada 1-${lastListing.length}). Jalankan "list" lagi kalau perlu.`);
  }

  return lastListing[idx];
}

// Nyimpen ID pesan hasil "preview" yang masih "aktif" (belum di-clear), supaya
// command "clear" cuma hapus pesan-pesan itu — bukan seluruh riwayat chat.
//
// PENTING: array ini di-PERSIST ke file (bukan cuma di memory) — soalnya
// kalau bot di-restart, PC restart, atau mati listrik SEBELUM sempat
// "clear", array in-memory bakal ke-reset kosong padahal pesan preview-nya
// (termasuk yang berasal dari folder RAHASIA) MASIH kelihatan di riwayat
// chat Discord. Tanpa persist, bot jadi "lupa" ID pesan itu selamanya dan
// "clear" tidak akan pernah bisa menghapusnya lagi walau bot sudah nyala
// ulang. Dengan disimpan ke file, begitu bot start lagi, daftar ID lama
// otomatis ke-load kembali dan "clear" tetap bisa menghapusnya normal.
const PREVIEW_STORE_FILE = path.resolve('./previewMessages.store.json');

function loadPreviewMessages() {
  try {
    if (!fs.existsSync(PREVIEW_STORE_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(PREVIEW_STORE_FILE, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    // File corrupt/rusak -> jangan sampai bikin bot gagal start gara-gara
    // ini, cukup anggap kosong (skenario terburuknya cuma balik ke masalah
    // lama: preview lama harus dihapus manual).
    return [];
  }
}

function savePreviewMessages() {
  try {
    fs.writeFileSync(PREVIEW_STORE_FILE, JSON.stringify(previewMessages, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`⚠️ Gagal simpan previewMessages.store.json: ${err.message}`);
  }
}

const previewMessages = loadPreviewMessages();

function displayDir() {
  return currentDir === '.' ? '/' : `/${currentDir}`;
}

// Sama seperti displayDir(), tapi buat virtual path arbitrer (bukan cuma
// currentDir) — dipakai di hasil copy/move/delete supaya yang ditampilkan
// ke user path VIRTUAL yang rapi ("/Documents/CV.pdf"), bukan path disk asli
// yang panjang ("D:\Users\Naufal Khalil\Documents\CV.pdf").
function toDisplayPath(virtualPath) {
  return virtualPath === '.' ? '/' : `/${virtualPath}`;
}

// Gabungkan sebuah argumen path yang diketik user dengan currentDir yang aktif.
// - "" atau "." -> currentDir apa adanya
// - diawali "/" -> dianggap relatif terhadap root BASE_DIR (bukan currentDir)
// - selain itu -> digabung dengan currentDir (mendukung "..", "../..", dst)
function resolvePathArg(inputPath) {
  if (!inputPath || inputPath === '.') return currentDir;

  // ":<angka>" -> rujuk langsung ke item bernomor itu dari hasil "list"
  // terakhir (virtual path lengkap, sudah relatif terhadap root sandbox,
  // BUKAN relatif terhadap currentDir) — jadi bisa langsung dipakai sebagai
  // hasil akhir, lewati logic gabung-dengan-currentDir di bawah.
  const indexTarget = resolveIndexRef(inputPath);
  if (indexTarget !== null) return indexTarget;

  const normalizedInput = inputPath.replace(/\\/g, '/');

  let combined;
  if (normalizedInput.startsWith('/')) {
    const stripped = normalizedInput.replace(/^\/+/, '');
    combined = stripped === '' ? '.' : path.posix.normalize(stripped);
  } else {
    const base = currentDir === '.' ? '' : currentDir;
    combined = path.posix.normalize(path.posix.join(base, normalizedInput));
  }

  if (combined === '' || combined === '.') return '.';

  // BUG FIX: kalau hasil gabungan path masih diawali "..", artinya user
  // mencoba naik lebih tinggi dari root sandbox (mis. "cd .." diulang
  // sampai lebih tinggi dari BASE_DIR, atau path absolut kayak "/../../etc").
  // Sebelumnya string ".." / "../.." ini lolos dan currentDir jadi rusak,
  // bikin navigasi berikutnya ("cd Project") ikut nyasar ke luar sandbox
  // (kadang sampai ke root drive Windows kalau safeResolve kebetulan tidak
  // menahannya). Clamp ke root ('.') di sini, jangan biarkan lolos sama sekali.
  if (combined === '..' || combined.startsWith('../')) return '.';

  return combined;
}

function buildHelpText() {
  const rootsList = listRootNames().map((name) => `• \`${name}\``).join('\n');

  return `**📦 Nausync Cloud** \`(${BUILD_TAG})\`

**Navigasi**
• \`cd <folder>\`
• \`cd ..\`
• \`root\`
• \`pwd\`
• \`list [folder]\`

**File**
• \`copy <src> <dst>\` 🔐*
• \`move <src> <dst>\` 🔐*
• \`delete <path>\` 🔐*
• \`purge <path> <pin>\` 🔐
• \`info <path>\`
• \`preview <path>\` 🔐*
• \`download <path>\` 🔐*
• \`archive <path>\` 🔐*
• \`clear\`

**Laptop**
• \`baterai\`
• \`disk\`
• \`network\` 🔐*
• \`mode server\`
• \`mode hemat\`
• \`shutdown <pin>\` 🔐
• \`restart <pin>\` 🔐
• \`cancel\`

**Keamanan**
• \`chgpin <pin_lama>\` 🔐

🔐 = selalu butuh PIN keamanan.
🔐* = butuh PIN CUMA kalau kondisi tertentu terpenuhi (cek \`?copy\`/\`?move\`/\`?preview\`/\`?download\`/\`?archive\`/\`?network\`).
PIN dikirim ke email, cek \`?chgpin\`.

Ketik \`?<command>\` buat penjelasan detail tiap command, mis. \`?root\`.

**Folder root:**
${rootsList}`;
}

// Penjelasan detail per-command, sengaja TIDAK dimasukkan ke "help" utama
// (biar "help" tetap ringkas) — cuma bisa diakses lewat command tersembunyi
// "?<nama>", mis. "?pwd" atau "?download". Prefix "?" dipilih dengan alasan
// sama seperti ":" di lastListing: karakter ini TIDAK VALID di nama file
// Windows, jadi "?pwd" nggak akan pernah tertukar dengan path/nama asli.
const DETAILED_HELP = {
  help: '**help** — daftar command\nNampilin daftar semua command yang ada (ringkas). Buat penjelasan detail cara pakai command tertentu, ketik `?<command>`, mis. `?cd` atau `?download`. Dua aturan umum yang berlaku ke hampir semua command: (1) path yang kamu ketik itu relatif ke folder aktif (`pwd`), awali dengan `/` kalau mau langsung dari root, mis. `list /Documents/Kerja`; (2) abis `list`, tiap item dapat nomor yang bisa dirujuk pakai `:<nomor>` di command berikutnya, mis. `cd :2`.',

  pwd: '**pwd** — lihat folder aktif\nNunjukin folder mana yang lagi "aktif" sekarang (hasil `cd` terakhir), biar nggak perlu inget-inget sendiri lagi di mana. Semua command lain (list/copy/move/delete/download/preview) yang argumennya bukan path lengkap otomatis dianggap relatif ke folder aktif ini.',

  cd: '**cd** — pindah folder aktif (atau preview kalau target file)\n`cd <folder>` pindah ke folder itu (relatif ke folder aktif sekarang). `cd ..` naik satu tingkat, nggak bisa naik lebih tinggi dari root sandbox. Awali path dengan `/` buat langsung loncat dari root virtual, mis. `cd /Documents/Kerja`. Bisa juga pakai nomor dari `list` terakhir: `cd :2`. 🆕 Kalau targetnya ternyata FILE (bukan folder), `cd` otomatis jadi shortcut buat lihat file itu (attachment apa adanya, sama kayak preview versi lama) — cocok kalau cuma mau intip cepat. Tetap butuh PIN kalau file-nya di folder RAHASIA atau ukurannya ≥50MB: `cd <file> <pin>`.',

  root: '**root** — langsung balik ke root sandbox\nDipakai kalau folder aktif sekarang udah jauh nyasar ke dalam (mis. `/Documents/Kerja/2024/Laporan`) dan mau langsung balik ke root virtual tanpa `cd ..` berkali-kali atau ngetik `cd /`. Sama persis efeknya kayak `cd /`, cuma lebih singkat.',

  list: '**list** — lihat isi folder\n`list` tanpa argumen nampilin isi folder aktif; `list <folder>` nampilin folder lain tanpa perlu pindah ke situ dulu. Tiap item dapat nomor urut yang bisa dirujuk pakai `:<nomor>` di command berikutnya (cd/copy/move/delete/download/preview/archive). Kalau isinya kepanjangan buat 1 pesan Discord, otomatis dipecah jadi beberapa halaman pakai tombol ◀️▶️.',

  copy: '**copy** — copy file/folder\n`copy <src> <dst>` — src & dst boleh nama folder/file biasa, path lengkap (`/Documents/x`), atau nomor dari `list` terakhir (`:3`). Folder di-copy beserta isinya (recursive). File asal tidak terhapus. 🔒 Wajib tambah PIN di argumen terakhir (`copy <src> <dst> <pin>`) kalau src ada di folder RAHASIA (CONFIDENTIAL_PATHS) dan/atau ukurannya ≥50MB — mencegah bot crash/storage penuh, mencegah copy berulang-ulang kalau Discord-mu kena hack, dan mencegah data rahasia diduplikat diam-diam ke lokasi bebas.',

  archive: '**archive** — compress ke .zip lalu upload\n`archive <path>` mengompres file/folder itu jadi satu file `.zip`, upload ke Google Drive (folder staging), lalu file `.zip` LOKAL langsung dihapus permanen begitu upload selesai (sukses ATAU gagal — nggak dibiarkan numpuk). Cocok buat folder isinya banyak file kecil, biar upload-nya 1 koneksi aja (lebih hemat bandwidth & waktu dibanding `download` biasa file satu-satu). 🔒 Kalau ukuran ASLI (sebelum di-zip) ≥50MB, atau file-nya ada di folder RAHASIA, wajib PIN: `archive <path> <pin>`.',

  move: '**move** — pindah/rename file/folder\n`move <src> <dst>` — sama aturan path-nya kayak `copy`, tapi file asal berpindah (bukan diduplikat), jadi juga dipakai buat rename (`move CV.pdf "CV Baru.pdf"`). Folder root yang diizinkan sendiri (mis. seluruh "Documents") nggak bisa dipindah/di-rename, cuma isinya. 🔒 Wajib PIN (`move <src> <dst> <pin>`) kalau src ada di folder RAHASIA dan/atau ukurannya ≥50MB — sama gatenya kayak `copy`.',

  delete: '**delete** — hapus file/folder (TIDAK permanen)\n`delete <path>` mindahin file/folder itu ke folder ".trash" tersembunyi di root yang sama — bukan dihapus dari disk. Folder ".trash" ini sengaja disembunyikan dari `list`, tapi tetap bisa diakses manual lewat path kalau perlu ambil balik isinya (mis. `list Documents/.trash`). Item di trash otomatis dihapus PERMANEN setelah beberapa hari (lihat `?purge`) kalau tidak dipulihkan manual duluan. Folder root yang diizinkan sendiri nggak bisa dihapus, cuma isinya. 🔒 Wajib PIN (`delete <path> <pin>`) kalau path-nya ada di folder RAHASIA (CONFIDENTIAL_PATHS) — sama gatenya kayak `copy`/`move`, dan tiap penghapusan folder rahasia dikirim alert ke email. Buat hapus beneran permanen SEKARANG JUGA (bukan nunggu retensi), pakai `purge`.',

  purge: '**purge** — hapus PERMANEN (butuh PIN + konfirmasi)\n`purge <path> <pin>` beda sama `delete` — ini langsung hapus dari disk, TIDAK masuk ".trash", TIDAK BISA dibatalkan. Sekarang butuh PIN keamanan di argumen terakhir (lihat `?chgpin`), baru setelah itu bot nanya konfirmasi tombol "Ya, Hapus Permanen" / "Batal". Dua lapis ini sengaja dipasang karena `purge` paling merusak & tidak bisa diundo.\n\nCatatan: item yang sudah masuk ".trash" lewat `delete` juga otomatis kena "purge" versi OTOMATIS setelah beberapa hari (default 30 hari, atur lewat `TRASH_RETENTION_DAYS` di .env) — sweep ini jalan sekali sehari, dan owner selalu dapat email ringkasan kalau ada yang benar-benar terhapus permanen lewat jalur ini.',

  cancel: '**cancel** — batalkan shutdown/restart yang masih pending\n`cancel` menghentikan proses shutdown/restart yang lagi dalam masa tunggu 15 detik (mis. abis ketik `shutdown <pin>` tapi berubah pikiran). TIDAK butuh PIN, karena ini aksi yang MENGURANGI risiko, bukan menambah. Kalau tidak ada shutdown/restart yang pending, bot bakal bilang gagal — itu wajar.',

  info: '**info** — lihat detail file/folder\n`info <path>` nampilin tipe (file/folder), ukuran total (folder dihitung rekursif termasuk semua isinya), jumlah item di dalam (kalau folder), dan tanggal terakhir diubah. Berguna buat ngecek ukuran sebelum `download`/`copy`, tanpa perlu buka/list dulu.',

  preview: '**preview** — lihat file langsung di chat\n`preview <path>` nampilin file itu LANGSUNG di Discord: gambar dikirim sebagai attachment (Discord otomatis render inline, kebuka tanpa perlu diklik), file TEKS (.txt/.md/.json/.js/.log/dst, sampai ~512KB) isinya dibaca & ditampilkan langsung sebagai embed (nggak perlu download buat baca), tipe lain (PDF/docx/zip/dst) tetap dikirim sebagai attachment biasa. Cuma buat FILE (bukan folder — pakai `list` buat lihat isi folder), dan ukurannya dibatasi ~8MB (limit attachment Discord) — file lebih besar pakai `download` atau `archive`. 🔒 Wajib PIN (`preview <path> <pin>`) kalau file-nya ada di folder RAHASIA (CONFIDENTIAL_PATHS di .env) — tiap akses (berhasil/gagal) otomatis dikirim alert ke email. Shortcut cepat: `cd <file>` juga bisa dipakai buat preview versi attachment-apa-adanya.',

  download: '**download** — upload ke Google Drive\n`download <path>` ngirim file/folder ke folder staging Google Drive lewat rclone, sambil nampilin progress bar yang di-update tiap beberapa detik. Sebelum mulai, bot ngecek dulu sisa kapasitas Drive kamu — kalau kurang, upload ditolak duluan (nggak ada percobaan yang gagal setengah jalan). 🔒 Wajib tambah PIN di argumen terakhir (`download <path> <pin>`) kalau target ada di folder RAHASIA (CONFIDENTIAL_PATHS) dan/atau ukurannya ≥50MB — mencegah bot crash/storage Drive penuh, mencegah download berulang-ulang kalau Discord-mu kena hack, dan mencegah data rahasia disalin keluar diam-diam. Folder isinya banyak file kecil? Pertimbangkan `archive` biar lebih hemat bandwidth.',

  clear: '**clear** — bersihin pesan preview\nHapus semua pesan hasil `preview` yang masih "tercatat" di sesi ini. Aman — cuma nyentuh pesan preview, command/chat lain nggak ikut kehapus.',

  baterai: '**baterai** — cek status baterai laptop\nNampilin persentase baterai, lagi di-cas atau tidak, dan mode power yang lagi aktif (Server/Hemat/Custom). Kalau laptopnya PC desktop tanpa baterai, bakal dikasih tahu juga.',

  disk: '**disk** — cek sisa storage laptop\nNampilin total, terpakai, dan sisa kapasitas tiap drive lokal fisik di laptop (mis. C:, D:) — beda sama sisa kapasitas Google Drive yang dicek otomatis pas `download`. Berguna dicek sebelum `copy`/`move` file besar biar nggak kehabisan space di tengah proses.',

  network: '**network** — cek status koneksi jaringan\nNampilin semua koneksi aktif (Wi-Fi/LAN): nama jaringan, kategori (🔒 Privat/🌍 Publik/🏢 Domain), status internet, dan sinyal Wi-Fi. 🔒 Detail teknis (IP lokal, gateway, DNS, link speed, MAC) disembunyikan default & wajib PIN: `network detail <pin>` (atau `network -v <pin>`).',

  mode: '**mode** — atur power plan laptop\n`mode server` bikin laptop nggak pernah sleep/hibernate (buat proses upload/download besar yang lama). `mode hemat` balikin ke default harian (sleep 15 menit, hibernate 3 jam). Ada verifikasi otomatis abis diubah, biar ketahuan kalau ada Group Policy/app lain yang nge-override.',

  shutdown: '**shutdown** — matikan laptop dari jarak jauh (butuh PIN)\n`shutdown <pin>` — laptop mati dalam 15 detik setelah command diterima & PIN valid. Koneksi bot otomatis terputus begitu laptop mati — bot baru aktif lagi kalau laptopnya dinyalain manual (kecuali kamu punya cara nyalain jarak jauh di luar bot ini, mis. Wake-on-LAN). PIN wajib supaya kalau Discord-mu kena hack, penyerang tidak bisa asal matiin laptop.',

  restart: '**restart** — restart laptop dari jarak jauh (butuh PIN)\n`restart <pin>` — sama kayak `shutdown` (15 detik delay, wajib PIN), bedanya laptop nyala lagi otomatis setelah Windows selesai booting, dan bot Nausync Cloud ikut aktif lagi otomatis (asalkan sudah di-setting auto-start lewat Task Scheduler).',

  chgpin: '**chgpin** — ganti PIN keamanan secara manual\n`chgpin <pin_lama>` — generate PIN baru secara acak (8 karakter, campur huruf besar/kecil & angka) & kirim ke email alert-mu (terpisah dari Discord), lalu PIN lama langsung tidak berlaku. Butuh PIN LAMA yang benar dulu (sama seperti ganti password pakai password lama). Selain lewat command ini, PIN juga OTOMATIS berganti sendiri (sekali pakai) setiap kali dipakai buat `shutdown`/`restart`/`purge`/`copy`/`move`/`download`/`archive`/preview folder rahasia, DAN otomatis diganti tiap 90 hari walau tidak pernah dipakai sama sekali (rotasi berbasis umur, cegah satu PIN beredar terlalu lama) — jadi `chgpin` ini cuma perlu dipakai kalau kamu mau ganti PIN kapan pun TANPA nunggu salah satu dari dua rotasi otomatis itu. Kalau salah PIN 5x berturut-turut, bot otomatis lockout 15 menit & kirim email alert — kalau ini kejadian padahal bukan kamu yang coba, segera amankan akun Discord-mu.',

  ':': '**Shortcut nomor (`:<angka>`)**\nAbis jalanin `list`, tiap item dapat nomor urut. Command berikutnya (cd/copy/move/delete/download/preview) bisa langsung rujuk nomor itu pakai `:<angka>` alih-alih ngetik ulang nama folder/file yang panjang — mis. `list` lalu `cd :2`, atau `copy :3 Downloads`. Nomornya ngikutin hasil `list` yang PALING TERAKHIR dijalankan.',
};

function getDetailedHelp(cmdName) {
  const entry = DETAILED_HELP[cmdName];
  if (entry) return entry;

  const topics = Object.keys(DETAILED_HELP).filter((k) => k !== ':').sort().join(', ');
  return `❓ Belum ada penjelasan detail buat "${cmdName}".\nTopik yang tersedia: ${topics} (juga \`?:\` buat shortcut nomor).`;
}


function tokenize(text) {
  // Normalisasi smart quotes (‘’“”) jadi straight quotes ('") — keyboard HP
  // (iOS/Android) sering auto-convert " jadi " " saat mengetik, yang bikin
  // regex quote-matching di bawah gagal cocok
  const normalized = text
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");

  const regex = /"([^"]+)"|(\S+)/g;
  const tokens = [];
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    // Ambil string murni dari hasil regex matching teks
    tokens.push(match[1] ?? match[2]);
  }
  return tokens;
}

function getLocalSize(path) {
  if (!fs.existsSync(path)) return 0;
  const stats = fs.statSync(path);
  if (stats.isFile()) return stats.size;
  let totalSize = 0;
  try {
    const files = fs.readdirSync(path);
    for (const file of files) {
      totalSize += getLocalSize(`${path}/${file}`);
    }
  } catch { return 0; }
  return totalSize;
}

function getDriveFreeSpace() {
  return new Promise((resolve) => {
    exec(`rclone about "${config.rcloneRemote}:" --json`, (err, stdout) => {
      if (err) return resolve(Infinity);
      try {
        const data = JSON.parse(stdout.toString());
        resolve(data.free || 0);
      } catch { resolve(Infinity); }
    });
  });
}

// Jalankan satu perintah powercfg, tangkap error/stderr-nya (jangan fire-and-forget)
// Pakai path absolut karena PATH environment proses Node (mis. dijalankan via
// Task Scheduler/service) kadang tidak menyertakan C:\Windows\System32
const POWERCFG_PATH = 'C:\\Windows\\System32\\powercfg.exe';

async function runPowercfg(args) {
  try {
    const { stdout, stderr } = await execAsync(`"${POWERCFG_PATH}" ${args}`);
    if (stderr && stderr.trim()) {
      throw new Error(stderr.trim());
    }
    return { ok: true, output: stdout.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Baca ulang nilai timeout yang benar-benar tersimpan di skema aktif, untuk verifikasi
async function getStandbyMinutes() {
  try {
    const { stdout } = await execAsync(`"${POWERCFG_PATH}" /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`);
    const match = stdout.match(/Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)/i);
    if (!match) return null;
    return Math.round(parseInt(match[1], 16) / 60);
  } catch {
    return null;
  }
}

// Baca info baterai lewat PowerShell (Win32_Battery via CIM). Pakai path
// absolut dengan alasan sama seperti POWERCFG_PATH: PATH env proses Node
// (mis. dijalankan via Task Scheduler/service) kadang tidak lengkap.
const POWERSHELL_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

// Referensi nilai BatteryStatus (WMI Win32_Battery):
// 1=Discharging, 2=AC/tidak diketahui, 3=Fully Charged, 4=Low, 5=Critical,
// 6=Charging, 7=Charging & High, 8=Charging & Low, 9=Charging & Critical,
// 10=Undefined, 11=Partially Charged
function describeBatteryStatus(status) {
  const map = {
    1: { charging: false, label: 'Discharging' },
    2: { charging: false, label: 'AC tersambung' },
    3: { charging: false, label: 'Fully Charged (penuh)' },
    4: { charging: false, label: 'Low' },
    5: { charging: false, label: 'Critical' },
    6: { charging: true, label: 'Charging' },
    7: { charging: true, label: 'Charging (High)' },
    8: { charging: true, label: 'Charging (Low)' },
    9: { charging: true, label: 'Charging (Critical)' },
    10: { charging: false, label: 'Undefined' },
    11: { charging: false, label: 'Partially Charged' },
  };
  return map[status] || { charging: false, label: 'Tidak diketahui' };
}

async function getBatteryInfo() {
  const { stdout } = await execAsync(
    `"${POWERSHELL_PATH}" -NoProfile -NonInteractive -Command "Get-CimInstance -ClassName Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress"`
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null; // biasanya berarti tidak ada baterai (PC desktop)

  const parsed = JSON.parse(trimmed);
  const battery = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!battery || battery.EstimatedChargeRemaining === undefined) return null;
  return battery;
}

// Terjemahkan nilai standby timeout (AC) jadi label mode yang dikenal user,
// berdasarkan nilai yang di-set oleh command "mode server" (0 menit) dan
// "mode hemat" (15 menit). Kalau nilainya beda (mis. diubah manual lewat
// Settings Windows), tampilkan sebagai "Custom" biar tidak menyesatkan.
function describePowerMode(minutes) {
  if (minutes === null) return '❓ Tidak diketahui (gagal membaca setting power)';
  if (minutes === 0) return '🖥️ Mode Server (layar/sleep tidak pernah mati)';
  if (minutes === 15) return '🔋 Mode Hemat (sleep otomatis setelah 15 menit idle)';
  return `⚙️ Custom (standby timeout: ${minutes} menit, bukan dari "mode server"/"mode hemat")`;
}

// Baca info kapasitas semua drive fisik lokal yang "fixed" (DriveType 3 —
// bukan removable/CD/network), lewat PowerShell (Win32_LogicalDisk via CIM).
// Dipakai buat command "disk" — beda dari getDriveFreeSpace() yang ngecek
// sisa kapasitas Google Drive REMOTE (dipakai command "download").
async function getDiskInfo() {
  const { stdout } = await execAsync(
    `"${POWERSHELL_PATH}" -NoProfile -NonInteractive -Command "Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 } | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"`
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function formatBytes(bytes) {
  if (bytes === Infinity || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- Info jaringan (command "network") ---
//
// Sumber data: "Get-NetConnectionProfile" (PowerShell) — satu entry per
// KONEKSI JARINGAN AKTIF (bisa lebih dari satu sekaligus, mis. laptop
// nyambung Wi-Fi DAN Ethernet bersamaan). Digabung dengan "Get-NetAdapter"
// (buat tahu tipe fisiknya: Wi-Fi atau Ethernet, status adapter, kecepatan
// link, MAC) dan "Get-NetIPConfiguration" (buat IP lokal, gateway, DNS).
//
// Kenapa tidak cuma "netsh wlan show interfaces"? Karena itu CUMA nampilin
// info Wi-Fi (Ethernet tidak kebaca sama sekali), dan output teksnya
// ter-LOKALISASI (label bahasa Inggris vs Indonesia beda tergantung setting
// Windows) jadi rawan salah parse. Get-NetConnectionProfile dkk itu
// terstruktur (properti .NET, bukan teks bebas) jadi jauh lebih stabil buat
// data UTAMA. netsh cuma dipakai sebagai TAMBAHAN opsional (buat sinyal
// Wi-Fi %), dengan parsing yang sengaja longgar (lihat parseWifiSignal)
// supaya tetap aman walau gagal cocok — bagian penting (kategori jaringan,
// IP, dll) tidak bergantung sama sekali ke netsh.
function isWifiMediaType(physicalMediaType) {
  return typeof physicalMediaType === 'string' && /802\.11|wireless/i.test(physicalMediaType);
}

// Parsing longgar buat ambil persentase sinyal Wi-Fi dari "netsh wlan show
// interfaces". Sengaja dibuat best-effort (bukan sumber data utama) karena
// output netsh ter-lokalisasi — label "Signal" bisa jadi "Sinyal" dsb
// tergantung bahasa Windows-nya. Kalau gagal cocok, return null dan command
// "network" tetap jalan normal tanpa baris sinyal (bukan error).
function parseWifiSignal(netshOutput) {
  const signalMatch = /^\s*(?:Signal|Sinyal)\s*:\s*(\d{1,3})%/im.exec(netshOutput);
  const radioMatch = /^\s*(?:Radio type|Jenis radio|Tipe radio)\s*:\s*(.+)$/im.exec(netshOutput);
  return {
    signalPercent: signalMatch ? parseInt(signalMatch[1], 10) : null,
    radioType: radioMatch ? radioMatch[1].trim() : null,
  };
}

// Script PowerShell buat command "network" ditulis ke file sementara lalu
// dijalankan lewat "-File" (bukan "-Command" satu baris) — SENGAJA begini,
// bukan gaya "-Command" satu baris seperti getDiskInfo/getBatteryInfo di
// atas, karena script ini punya percabangan if/else & assignment variabel
// bertingkat yang gampang salah parse kalau dipaksa jadi satu baris pakai
// titik-koma (terutama assignment hasil if/else ke dalam hashtable literal,
// yang butuh sintaks tambahan $(...) kalau dipaksa satu baris). Nulis ke
// file .ps1 asli menghindari seluruh masalah escaping/separator itu sama
// sekali — jauh lebih gampang dibaca & dipastikan benar.
const NETWORK_SCRIPT_PATH = path.join(os.tmpdir(), 'nausync-network-info.ps1');

const NETWORK_PS_SCRIPT = `
$profiles = Get-NetConnectionProfile
$result = foreach ($p in $profiles) {
  $adapter = Get-NetAdapter -InterfaceIndex $p.InterfaceIndex -ErrorAction SilentlyContinue
  $ipcfg = Get-NetIPConfiguration -InterfaceIndex $p.InterfaceIndex -ErrorAction SilentlyContinue
  $ipv4 = ($ipcfg.IPv4Address | Select-Object -First 1).IPAddress
  $gateway = ($ipcfg.IPv4DefaultGateway | Select-Object -First 1).NextHop
  $dns = @($ipcfg.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | Select-Object -ExpandProperty ServerAddresses)

  $adapterStatus = $null
  $physicalMedia = $null
  $linkSpeed = $null
  $macAddress = $null
  if ($adapter) {
    $adapterStatus = $adapter.Status.ToString()
    $physicalMedia = $adapter.PhysicalMediaType
    $linkSpeed = $adapter.LinkSpeed
    $macAddress = $adapter.MacAddress
  }

  [PSCustomObject]@{
    Name = $p.Name
    InterfaceAlias = $p.InterfaceAlias
    NetworkCategory = $p.NetworkCategory.ToString()
    IPv4Connectivity = $p.IPv4Connectivity.ToString()
    IPv6Connectivity = $p.IPv6Connectivity.ToString()
    AdapterStatus = $adapterStatus
    PhysicalMediaType = $physicalMedia
    LinkSpeed = $linkSpeed
    MacAddress = $macAddress
    IPv4Address = $ipv4
    Gateway = $gateway
    DNSServers = $dns
  }
}
$result | ConvertTo-Json -Compress -Depth 4
`;

// Tulis script sekali aja saat module di-load (bukan tiap kali command
// "network" dipanggil) — isinya statis, tidak pernah berubah saat runtime.
try {
  fs.writeFileSync(NETWORK_SCRIPT_PATH, NETWORK_PS_SCRIPT, 'utf-8');
} catch (err) {
  console.warn(`⚠️ Gagal menyiapkan script network-info.ps1: ${err.message}. Command "network" mungkin gagal.`);
}

async function getNetworkInfo() {
  const { stdout } = await execAsync(
    `"${POWERSHELL_PATH}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${NETWORK_SCRIPT_PATH}"`
  );

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed);
  const profiles = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    ...p,
    DNSServers: Array.isArray(p.DNSServers) ? p.DNSServers : (p.DNSServers ? [p.DNSServers] : []),
    isWifi: isWifiMediaType(p.PhysicalMediaType),
  }));

  // Kalau ada minimal satu koneksi Wi-Fi, coba perkaya dengan sinyal % dari
  // netsh (best-effort, lihat parseWifiSignal). Cukup dipanggil sekali
  // (bukan per-profile) karena hampir semua laptop cuma punya 1 adapter
  // Wi-Fi fisik; kalaupun gagal/tidak cocok, profile Wi-Fi tetap tampil
  // tanpa baris sinyal.
  if (profiles.some((p) => p.isWifi)) {
    try {
      const { stdout: netshOut } = await execAsync('netsh wlan show interfaces');
      const wifiExtra = parseWifiSignal(netshOut);
      for (const p of profiles) {
        if (p.isWifi) {
          p.signalPercent = wifiExtra.signalPercent;
          p.radioType = wifiExtra.radioType;
        }
      }
    } catch {
      // netsh gagal/tidak tersedia -> lewati saja, bukan fatal buat command "network"
    }
  }

  return profiles;
}

function describeNetworkCategory(category) {
  switch (category) {
    case 'Public':
      return '🌍 **Publik** — laptop ini disembunyikan dari perangkat lain di jaringan yang sama (lebih aman dipakai di Wi-Fi umum/kafe/hotel)';
    case 'Private':
      return '🔒 **Privat** — laptop ini bisa "ditemukan" perangkat lain di jaringan yang sama (cocok untuk Wi-Fi/LAN rumah sendiri yang dipercaya, TAPI berisiko kalau ternyata dipakai di jaringan publik)';
    case 'DomainAuthenticated':
      return '🏢 **Domain** — jaringan kantor/organisasi yang terkelola (Active Directory)';
    default:
      return `❓ ${category || 'Tidak diketahui'}`;
  }
}

function describeConnectivity(v4, v6) {
  if (v4 === 'Internet' || v6 === 'Internet') return '✅ Terhubung ke Internet';
  if (v4 === 'LocalNetwork' || v6 === 'LocalNetwork') return '⚠️ Cuma nyambung ke jaringan lokal (tidak ada akses Internet)';
  if (v4 === 'NoTraffic' || v6 === 'NoTraffic') return '⚠️ Nyambung tapi belum ada traffic terdeteksi';
  return '❌ Tidak terhubung';
}

// Default-nya CUMA nampilin info inti yang relevan buat tujuan command ini
// (cek nyambung ke jaringan apa & privat/publik apa nggak): tipe koneksi,
// nama jaringan, kategori, status internet, dan sinyal Wi-Fi kalau ada.
//
// IP lokal/gateway/DNS/link speed/MAC address SENGAJA disembunyikan di
// mode default — bukan karena itu rahasia besar (IP lokal/gateway/DNS
// cuma alamat privat, tidak bisa diakses dari luar LAN sama sekali, dan
// MAC address cuma berguna buat orang yang SUDAH ada di jaringan fisik
// yang sama), tapi karena tidak ada gunanya buat pertanyaan "lagi nyambung
// ke jaringan apa" — dan prinsip "jangan tampilkan lebih dari yang
// dibutuhkan" tetap berlaku walau risikonya rendah, apalagi MAC address
// bisa dipakai buat fingerprinting perangkat kalau suatu saat histori
// chat ini kebaca orang lain (mis. Discord kena hack). Detail teknis ini
// tetap tersedia buat troubleshooting lewat `network detail`.
function formatNetworkProfile(p, verbose) {
  const typeLabel = p.isWifi ? '📶 Wi-Fi' : '🔌 LAN (Ethernet)';
  const lines = [
    `${typeLabel} — **${p.Name || p.InterfaceAlias || 'Tidak diketahui'}**`,
    `• Kategori jaringan: ${describeNetworkCategory(p.NetworkCategory)}`,
    `• Status: ${describeConnectivity(p.IPv4Connectivity, p.IPv6Connectivity)}`,
  ];
  if (p.isWifi && p.signalPercent !== null && p.signalPercent !== undefined) {
    lines.push(`• Sinyal Wi-Fi: **${p.signalPercent}%**`);
  }

  if (!verbose) return lines.join('\n');

  lines.push(`• Interface: \`${p.InterfaceAlias}\`${p.AdapterStatus ? ` (${p.AdapterStatus})` : ''}`);
  if (p.IPv4Address) lines.push(`• IP Lokal: \`${p.IPv4Address}\``);
  if (p.Gateway) lines.push(`• Gateway: \`${p.Gateway}\``);
  if (p.DNSServers && p.DNSServers.length) lines.push(`• DNS: ${p.DNSServers.map((d) => `\`${d}\``).join(', ')}`);
  if (p.LinkSpeed) lines.push(`• Kecepatan Link: ${p.LinkSpeed}`);
  if (p.isWifi && p.radioType) lines.push(`• Radio: ${p.radioType}`);
  if (p.MacAddress) lines.push(`• MAC Address: \`${p.MacAddress}\``);
  return lines.join('\n');
}

// Ekstensi yang dianggap "gambar" — dikirim sebagai attachment biasa,
// karena Discord SUDAH otomatis render attachment gambar inline (jadi
// nggak perlu ditangani khusus lagi, beda sama dulu yang cuma nampilin path).
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

// Ekstensi yang dianggap "teks" — isinya dibaca & ditampilkan LANGSUNG di
// embed Discord (bukan cuma dikirim sebagai attachment yang harus diklik
// dulu buat baca isinya).
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.csv', '.log',
  '.yml', '.yaml', '.xml', '.html', '.css', '.ini', '.py', '.java',
  '.c', '.cpp', '.sh', '.bat', '.env.example',
]);

// Batas umum attachment Discord buat bot non-boost server (~8MB). DM
// pribadi biasanya ikut batas yang sama.
const MAX_PREVIEW_SIZE = 8 * 1024 * 1024;

// Batas file teks yang masih nyaman dibaca lewat embed (jauh di bawah
// MAX_PREVIEW_SIZE) — di atas ini, baca isinya lebih enak lewat download.
const MAX_TEXT_PREVIEW_SIZE = 512 * 1024;

// Embed Discord dibatasi ~4096 karakter di field "description" — dikasih
// buffer di bawahnya biar aman dari batas persis.
const MAX_TEXT_EMBED_CHARS = 3500;

// Preview "LAMA" — kirim file APA ADANYA sebagai attachment Discord (foto
// otomatis kebuka inline, dokumen lain bisa didownload dari chat). Ini
// behavior preview versi sebelumnya, sekarang dipertahankan sebagai
// fallback buat tipe file yang bukan gambar/teks, dan dipakai langsung oleh
// shortcut "cd <file>".
async function sendAttachmentPreview(absPath, dscMessage, stats) {
  if (stats.size > MAX_PREVIEW_SIZE) {
    return `❌ File terlalu besar untuk preview (*${formatBytes(stats.size)}*, batas ~8MB). Pakai "download" atau "archive" untuk kirim ke Google Drive.`;
  }

  const fileName = path.basename(absPath);
  const sentMsg = await dscMessage.reply({
    content: `👀 **Preview:** \`${fileName}\` (${formatBytes(stats.size)})`,
    files: [{ attachment: absPath, name: fileName }],
  });

  previewMessages.push(sentMsg.id);
  savePreviewMessages();
  return null;
}

// Preview "BARU" — gambar tetap dikirim sebagai attachment (Discord
// otomatis render inline), tapi file TEKS dibaca isinya & ditampilkan
// LANGSUNG sebagai embed (nggak perlu klik/download lagi buat baca
// kontennya). Tipe lain (PDF/docx/zip/dst) fallback ke attachment biasa.
async function sendRichPreview(absPath, dscMessage, stats) {
  const ext = path.extname(absPath).toLowerCase();
  const fileName = path.basename(absPath);

  if (TEXT_EXTENSIONS.has(ext) && stats.size <= MAX_TEXT_PREVIEW_SIZE) {
    const raw = await fs.promises.readFile(absPath, 'utf-8').catch(() => null);
    if (raw !== null) {
      const truncated = raw.length > MAX_TEXT_EMBED_CHARS;
      const body = truncated ? raw.slice(0, MAX_TEXT_EMBED_CHARS) : raw;
      const lang = ext.replace('.', '');

      const embed = {
        title: `📄 ${fileName}`,
        description: '```' + lang + '\n' + body + '\n```' +
          (truncated ? `\n_(dipotong — cuma ${MAX_TEXT_EMBED_CHARS} karakter pertama dari ${raw.length}, pakai "download" buat isi lengkap)_` : ''),
        color: 0x2b6cff,
        footer: { text: formatBytes(stats.size) },
      };

      const sentMsg = await dscMessage.reply({ embeds: [embed] });
      previewMessages.push(sentMsg.id);
      savePreviewMessages();
      return null;
    }
    // Gagal dibaca sebagai UTF-8 (mis. ternyata bukan teks murni) -> fallback
  }

  // Gambar & tipe lain (termasuk teks yang kegedean buat embed) -> attachment biasa
  return sendAttachmentPreview(absPath, dscMessage, stats);
}

// Logic bersama buat command "preview" dan shortcut "cd <file>": validasi
// path, cek PIN (folder RAHASIA dan/atau ukuran ≥50MB), kirim alert email
// kalau relevan, lalu dispatch ke mode tampilan yang sesuai ('rich' buat
// command preview biasa, 'legacy' buat shortcut cd-ke-file).
async function runPreview(args, dscMessage, mode) {
  if (args.length < 1) return 'Format: `preview <path>` (atau `preview <path> <pin>` kalau file-nya rahasia/besar)';
  if (!dscMessage) return 'Fitur preview cuma bisa dipakai lewat Discord.';

  const targetPath = resolvePathArg(args[0]);
  const absPath = resolveForRclone(targetPath);

  if (!fs.existsSync(absPath)) return `❌ File tidak ditemukan.`;

  const stats = fs.statSync(absPath);
  if (stats.isDirectory()) {
    return `❌ "${args[0]}" adalah folder, bukan file. Pakai "list" untuk lihat isinya.`;
  }

  const needsConfidentialPin = isConfidential(absPath);
  const needsSizePin = stats.size >= PIN_SIZE_THRESHOLD;

  if (needsConfidentialPin || needsSizePin) {
    if (args.length < 2) {
      const label = needsConfidentialPin
        ? `🔒 **Data ini bersifat RAHASIA.** File \`${toDisplayPath(targetPath)}\` ada di folder yang ditandai rahasia — butuh PIN keamanan buat preview.`
        : `🔒 **Ukuran ${formatBytes(stats.size)} (≥50MB).** Preview file sebesar ini wajib PIN keamanan.`;
      return `${label}\nFormat: \`preview ${args[0]} <pin>\``;
    }

    const reason = needsConfidentialPin
      ? `preview folder rahasia: ${toDisplayPath(targetPath)}`
      : `preview file besar (${formatBytes(stats.size)}): ${toDisplayPath(targetPath)}`;
    await requirePin(args, reason);

    if (needsConfidentialPin) {
      sendAlertEmail(
        '🔓 Preview folder RAHASIA diakses',
        `File rahasia "${toDisplayPath(targetPath)}" berhasil di-preview dengan PIN yang valid pada ${new Date().toISOString()}.\n\nKalau ini bukan kamu, PIN-mu sudah bocor dan data rahasiamu baru saja dibaca orang lain — segera amankan akun Discord-mu.`
      ).catch(() => {});
    }
  }

  return mode === 'legacy'
    ? sendAttachmentPreview(absPath, dscMessage, stats)
    : sendRichPreview(absPath, dscMessage, stats);
}

export async function handleCommand(rawText, dscMessage = null) {
  const text = rawText.trim();
  if (!text) return buildHelpText();

  const tokens = tokenize(text);
  if (tokens.length === 0) return buildHelpText();
  
  // PERBAIKAN: Mengambil indeks pertama [0] sebagai string command murni
  const command = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  // "?<command>" -> command tersembunyi buat lihat penjelasan detail command
  // tertentu, tanpa bikin "help" utama jadi panjang. Sengaja dicek di sini
  // (sebelum switch di bawah), bukan sebagai "case" biasa, karena "?pwd" dkk
  // bukan nama command aslinya — cuma modifier di depannya.
  if (command.startsWith('?') && command.length > 1) {
    return getDetailedHelp(command.slice(1));
  }
  if (command === '?') {
    const topics = Object.keys(DETAILED_HELP).filter((k) => k !== ':').sort().join(', ');
    return `❓ Ketik \`?<command>\` buat penjelasan detail, contoh \`?pwd\`.\nTopik: ${topics}`;
  }

  try {
    switch (command) {
      case 'help':
        return buildHelpText();

      case 'pwd':
        return `📂 Folder aktif saat ini: \`${displayDir()}\``;

      case 'cd': {
        if (args.length < 1) return `📂 Folder aktif saat ini: \`${displayDir()}\``;

        const targetArg = args[0];
        const isClimbAttempt = targetArg.replace(/\\/g, '/').startsWith('..');
        const newDir = resolvePathArg(targetArg);

        // Kalau user coba naik (".." atau "../xxx") tapi hasilnya tetap di
        // root ('.') karena sudah di puncak sandbox, kasih tahu jelas —
        // jangan seolah-olah berhasil "pindah folder" padahal diam di tempat.
        if (isClimbAttempt && newDir === '.' && currentDir === '.') {
          return `📂 Sudah di folder root (\`${displayDir()}\`), tidak bisa naik lebih tinggi lagi.`;
        }

        // 🆕 Kalau targetnya ternyata FILE (bukan folder), "cd" ke situ nggak
        // ada gunanya (nggak ada isi buat di-"list") — daripada cuma nampilin
        // error, perlakukan sebagai shortcut ke preview versi LAMA (attachment
        // apa adanya). PIN (rahasia/ukuran besar) tetap berlaku sama seperti
        // command "preview", cuma argumennya "digeser": "cd <file> <pin>".
        let targetAbsPath;
        try {
          targetAbsPath = resolveForRclone(newDir);
        } catch (err) {
          return `❌ Gagal pindah folder: ${err.message}`;
        }
        if (fs.existsSync(targetAbsPath) && fs.statSync(targetAbsPath).isFile()) {
          // PENTING: pakai "await" di sini (bukan cuma "return runPreview(...)")
          // — kalau tidak, error yang dilempar runPreview (mis. PIN salah/
          // kosong) akan LOLOS dari try/catch besar di bawah (karena statement
          // "return" sudah keburu keluar dari try SEBELUM promise-nya selesai),
          // dan berakhir jadi pesan generik "Terjadi kesalahan internal..." di
          // index.js alih-alih pesan spesifik "Gagal: ...".
          return await runPreview([targetArg, ...args.slice(1)], dscMessage, 'legacy');
        }

        // Validasi folder benar-benar ada & memang folder (bukan file), lewat
        // listDir supaya sekalian kena aturan safeResolve/whitelist di fsops.js
        try {
          await listDir(newDir);
        } catch (err) {
          return `❌ Gagal pindah folder: ${err.message}`;
        }

        currentDir = newDir;
        return `📂 Pindah ke folder: \`${displayDir()}\``;
      }

      case 'root': {
        if (currentDir === '.') {
          return `📂 Sudah di folder root (\`${displayDir()}\`).`;
        }
        currentDir = '.';
        return `📂 Pindah ke folder: \`${displayDir()}\``;
      }

      case 'list': {
        const targetDir = resolvePathArg(args[0] || '.');
        const entries = await listDir(targetDir);
        if (!entries.length) return `Folder \`${displayDir()}\` kosong.`;

        // Kelompokkan folder dulu baru file, urut alfabetis (case-insensitive),
        // beri nomor urut + ikon supaya lebih gampang dibaca/di-scan
        const collator = new Intl.Collator('id', { sensitivity: 'base' });
        const dirs = entries.filter((e) => e.endsWith('/')).sort(collator.compare);
        const files = entries.filter((e) => !e.endsWith('/')).sort(collator.compare);

        // Simpan urutan ini (folder dulu, baru file) sebagai referensi nomor
        // ":N" untuk command berikutnya (cd/copy/move/delete/download/preview).
        // Virtual path-nya dibuat relatif ke ROOT sandbox (bukan ke targetDir),
        // supaya bisa langsung dipakai sebagai hasil akhir resolvePathArg.
        lastListing = [...dirs, ...files].map((entry) => {
          const bareName = entry.endsWith('/') ? entry.slice(0, -1) : entry;
          return targetDir === '.' ? bareName : `${targetDir}/${bareName}`;
        });

        let num = 1;

        // Tandai entry (folder/file) yang berada di dalam CONFIDENTIAL_PATHS
        // dengan ikon 🔒 di listing — supaya user tahu dari AWAL item mana
        // yang bakal diminta PIN pas di-preview/download, tanpa perlu coba
        // dulu baru ketahuan lewat pesan error. Beda dengan BLOCKED_PATHS
        // (yang memang sudah disembunyikan total dari listDir), item
        // confidential ini memang SENGAJA tetap kelihatan namanya di
        // "list" — cuma isinya yang di-gate PIN.
        function entryNeedsPin(bareName) {
          try {
            const virtualPath = targetDir === '.' ? bareName : `${targetDir}/${bareName}`;
            return isConfidential(safeResolve(virtualPath));
          } catch {
            // Harusnya tidak pernah terjadi (entry ini datang dari listDir
            // folder yang sama), tapi kalau gagal resolve karena sebab apa
            // pun, default-kan "tidak dikasih ikon" daripada bikin seluruh
            // command "list" gagal cuma gara-gara satu entry.
            return false;
          }
        }

        const lines = [
          ...dirs.map((d) => `${num++}. 📁 ${d}${entryNeedsPin(d.slice(0, -1)) ? ' 🔒' : ''}`),
          ...files.map((f) => `${num++}. 📄 ${f}${entryNeedsPin(f) ? ' 🔒' : ''}`),
        ];
        const headerBase = `📂 **${toDisplayPath(targetDir)}** — ${dirs.length} folder, ${files.length} file`;

        // Discord batasi pesan max ~2000 karakter. Daripada kirim file .txt
        // (harus di-download tiap kali), pecah daftar jadi beberapa "halaman"
        // yang muat di 1 pesan, terus kasih tombol ◀️ ▶️ buat geser halaman
        // langsung di chat.
        const PAGE_BUDGET = 1700;
        const pages = [];
        let bucket = [];
        let bucketLen = 0;
        for (const line of lines) {
          if (bucketLen + line.length + 1 > PAGE_BUDGET && bucket.length) {
            pages.push(bucket);
            bucket = [];
            bucketLen = 0;
          }
          bucket.push(line);
          bucketLen += line.length + 1;
        }
        if (bucket.length) pages.push(bucket);

        // Muat dalam 1 pesan, tidak perlu pagination sama sekali
        if (pages.length <= 1) {
          return `${headerBase}:\n${lines.join('\n')}`;
        }

        const renderPage = (i) => `${headerBase} — Hal. ${i + 1}/${pages.length}:\n${pages[i].join('\n')}`;

        if (!dscMessage) {
          // Fallback kalau dipanggil bukan lewat Discord (mis. dites langsung di kode)
          return `${renderPage(0)}\n\n(${pages.length} halaman total — jalankan lewat Discord untuk navigasi tombol)`;
        }

        let pageIndex = 0;
        const buildRow = (i) =>
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('list_prev')
              .setEmoji('◀️')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(i === 0),
            new ButtonBuilder()
              .setCustomId('list_next')
              .setEmoji('▶️')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(i === pages.length - 1),
          );

        const sentMsg = await dscMessage.reply({
          content: renderPage(pageIndex),
          components: [buildRow(pageIndex)],
        });

        // Kumpulkan klik tombol selama 5 menit, cuma owner (pengirim command) yang boleh navigasi
        const collector = sentMsg.createMessageComponentCollector({
          componentType: ComponentType.Button,
          time: 5 * 60 * 1000,
        });

        collector.on('collect', async (interaction) => {
          if (interaction.user.id !== dscMessage.author.id) {
            await interaction.reply({ content: 'Command ini bukan punya kamu.', ephemeral: true }).catch(() => {});
            return;
          }
          if (interaction.customId === 'list_prev' && pageIndex > 0) pageIndex--;
          if (interaction.customId === 'list_next' && pageIndex < pages.length - 1) pageIndex++;

          await interaction.update({
            content: renderPage(pageIndex),
            components: [buildRow(pageIndex)],
          }).catch(() => {});
        });

        // Setelah 5 menit, tombol dinonaktifkan biar gak bisa diklik lagi (interaction expired)
        collector.on('end', () => {
          sentMsg.edit({ components: [] }).catch(() => {});
        });

        return null; // sudah dikirim manual, index.js tidak perlu kirim ulang
      }

      case 'copy': {
        if (args.length < 2) return 'Format: `copy <src> <dst>` (kalau src rahasia dan/atau ukuran ≥50MB, tambahkan PIN: `copy <src> <dst> <pin>`)';

        const srcVirtual = resolvePathArg(args[0]);
        const absSrc = resolveForRclone(srcVirtual);
        if (!fs.existsSync(absSrc)) return `❌ Gagal: \`${toDisplayPath(srcVirtual)}\` tidak ditemukan.`;

        const srcSize = getLocalSize(absSrc);
        const needsConfidentialPin = isConfidential(absSrc);
        const needsSizePin = srcSize >= PIN_SIZE_THRESHOLD;
        let dstArgRaw = args[1];

        if (needsConfidentialPin || needsSizePin) {
          if (args.length < 3) {
            const label = needsConfidentialPin
              ? `🔒 **Data ini bersifat RAHASIA.** \`${toDisplayPath(srcVirtual)}\` butuh PIN keamanan buat di-copy.`
              : `🔒 **Ukuran ${formatBytes(srcSize)} (≥50MB).** Copy sebesar ini wajib PIN keamanan (cegah bot crash/storage penuh & cegah copy berulang-ulang kalau Discord-mu kena hack).`;
            return `${label}\nFormat: \`copy ${args[0]} ${args[1]} <pin>\``;
          }
          const reason = needsConfidentialPin
            ? `copy folder/file rahasia: ${toDisplayPath(srcVirtual)}`
            : `copy besar (${formatBytes(srcSize)}): ${toDisplayPath(srcVirtual)}`;
          const pinChecked = await requirePin(args, reason);
          dstArgRaw = pinChecked[1];

          if (needsConfidentialPin) {
            sendAlertEmail(
              '🔓 Copy folder/file RAHASIA dijalankan',
              `Folder/file rahasia "${toDisplayPath(srcVirtual)}" berhasil di-copy dengan PIN yang valid pada ${new Date().toISOString()}.\n\nKalau ini bukan kamu, PIN-mu sudah bocor dan data rahasiamu baru saja diduplikat orang lain — segera amankan akun Discord-mu.`
            ).catch(() => {});
          }
        }

        const dstVirtual = resolvePathArg(dstArgRaw);
        await copyPath(srcVirtual, dstVirtual);
        return `✅ Copy berhasil ke \`${toDisplayPath(dstVirtual)}\`${needsSizePin ? ` (${formatBytes(srcSize)})` : ''}`;
      }

      case 'move': {
        if (args.length < 2) return 'Format: `move <src> <dst>` (kalau src rahasia dan/atau ukuran ≥50MB, tambahkan PIN: `move <src> <dst> <pin>`)';

        const srcVirtual = resolvePathArg(args[0]);
        const absSrc = resolveForRclone(srcVirtual);
        if (!fs.existsSync(absSrc)) return `❌ Gagal: \`${toDisplayPath(srcVirtual)}\` tidak ditemukan.`;

        const srcSize = getLocalSize(absSrc);
        const needsConfidentialPin = isConfidential(absSrc);
        const needsSizePin = srcSize >= PIN_SIZE_THRESHOLD;
        let dstArgRaw = args[1];

        // Sama alasannya kayak copy: "move" bisa dipakai buat mengeluarkan
        // file/folder RAHASIA dari folder confidential ke lokasi bebas
        // tanpa lewat "preview" sama sekali (jadi tidak ke-detect kalau
        // cuma preview yang di-gate). Tambahan size-gate juga mencegah
        // rename/move berulang-ulang yang bikin I/O disk berat kalau
        // Discord-mu kena hack.
        if (needsConfidentialPin || needsSizePin) {
          if (args.length < 3) {
            const label = needsConfidentialPin
              ? `🔒 **Data ini bersifat RAHASIA.** \`${toDisplayPath(srcVirtual)}\` butuh PIN keamanan buat dipindah.`
              : `🔒 **Ukuran ${formatBytes(srcSize)} (≥50MB).** Move sebesar ini wajib PIN keamanan (cegah move berulang-ulang kalau Discord-mu kena hack).`;
            return `${label}\nFormat: \`move ${args[0]} ${args[1]} <pin>\``;
          }
          const reason = needsConfidentialPin
            ? `move folder/file rahasia: ${toDisplayPath(srcVirtual)}`
            : `move besar (${formatBytes(srcSize)}): ${toDisplayPath(srcVirtual)}`;
          const pinChecked = await requirePin(args, reason);
          dstArgRaw = pinChecked[1];

          if (needsConfidentialPin) {
            sendAlertEmail(
              '🔓 Move folder/file RAHASIA dijalankan',
              `Folder/file rahasia "${toDisplayPath(srcVirtual)}" berhasil dipindah dengan PIN yang valid pada ${new Date().toISOString()}.\n\nKalau ini bukan kamu, PIN-mu sudah bocor dan data rahasiamu baru saja dipindah orang lain — segera amankan akun Discord-mu.`
            ).catch(() => {});
          }
        }

        const dstVirtual = resolvePathArg(dstArgRaw);
        await movePath(srcVirtual, dstVirtual);
        return `✅ Move berhasil ke \`${toDisplayPath(dstVirtual)}\`${needsSizePin ? ` (${formatBytes(srcSize)})` : ''}`;
      }

      case 'delete': {
        if (args.length < 1) return 'Format: `delete <path>` (kalau ada di folder RAHASIA, tambahkan PIN: `delete <path> <pin>`)';
        const targetVirtual = resolvePathArg(args[0]);

        // Sama seperti copy/move/preview/download/archive: cek dulu apakah
        // target ada di folder RAHASIA sebelum jalanin apa pun. Sebelumnya
        // "delete" LOLOS dari gate ini — walau isinya tetap aman (trash
        // ditaruh tetap di dalam folder confidential asal, lihat
        // trashDirFor di fsops.js), memindah SELURUH isi folder rahasia ke
        // trash tanpa PIN & tanpa notifikasi tetap berisiko: kalau akun
        // Discord kena hack, penyerang bisa mengacak-acak folder rahasia
        // (memindah semuanya ke trash) tanpa owner tahu sama sekali.
        let absTarget;
        try {
          absTarget = resolveForRclone(targetVirtual);
        } catch (err) {
          return `❌ Gagal: ${err.message}`;
        }
        if (!fs.existsSync(absTarget)) {
          return `❌ Gagal: \`${toDisplayPath(targetVirtual)}\` tidak ditemukan.`;
        }

        const needsConfidentialPin = isConfidential(absTarget);
        if (needsConfidentialPin) {
          if (args.length < 2) {
            return `🔒 **Data ini bersifat RAHASIA.** \`${toDisplayPath(targetVirtual)}\` butuh PIN keamanan buat dihapus (dipindah ke trash).\nFormat: \`delete ${args[0]} <pin>\``;
          }
          await requirePin(args, `delete folder/file rahasia: ${toDisplayPath(targetVirtual)}`);
          sendAlertEmail(
            '🗑️ Delete (ke trash) folder/file RAHASIA dijalankan',
            `Folder/file rahasia "${toDisplayPath(targetVirtual)}" berhasil dipindah ke trash dengan PIN yang valid pada ${new Date().toISOString()}.\n\nKalau ini bukan kamu, PIN-mu sudah bocor — segera amankan akun Discord-mu. Datanya masih bisa dipulihkan dari trash selama belum di-"purge" atau kena auto-purge retensi.`
          ).catch(() => {});
        }

        await deletePath(targetVirtual);
        return `🗑️ Dipindah ke trash: \`${toDisplayPath(targetVirtual)}\`\n(belum permanen — pakai \`purge\` kalau mau hapus beneran, atau otomatis kehapus permanen setelah ${config.trashRetentionDays} hari)`;
      }

      case 'purge': {
        if (args.length < 1) return 'Format: `purge <path> <pin>`';
        const pinCheckedArgs = await requirePin(args, 'purge'); // lempar Error kalau PIN salah/kosong
        const targetVirtual = resolvePathArg(pinCheckedArgs[0]);

        if (!dscMessage) {
          return '❌ Command `purge` butuh konfirmasi tombol, cuma bisa dipakai lewat Discord.';
        }

        // Validasi dulu targetnya ada, biar gak nampilin dialog konfirmasi
        // buat path yang ternyata salah/tidak ditemukan.
        let absPath;
        try {
          absPath = resolveForRclone(targetVirtual);
        } catch (err) {
          return `❌ Gagal: ${err.message}`;
        }
        if (!fs.existsSync(absPath)) {
          return `❌ Gagal: \`${toDisplayPath(targetVirtual)}\` tidak ditemukan.`;
        }

        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('purge_yes').setLabel('Ya, Hapus Permanen').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('purge_no').setLabel('Batal').setStyle(ButtonStyle.Secondary),
        );

        const confirmMsg = await dscMessage.reply({
          content: `⚠️ **Yakin mau hapus PERMANEN** \`${toDisplayPath(targetVirtual)}\`?\nAksi ini TIDAK BISA dibatalkan (beda sama \`delete\` biasa yang cuma masuk trash).`,
          components: [confirmRow],
        });

        return new Promise((resolve) => {
          let settled = false;

          const collector = confirmMsg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 60 * 1000,
          });

          collector.on('collect', async (interaction) => {
            if (interaction.user.id !== dscMessage.author.id) {
              await interaction.reply({ content: 'Command ini bukan punya kamu.', ephemeral: true }).catch(() => {});
              return;
            }

            settled = true;
            collector.stop();

            if (interaction.customId === 'purge_yes') {
              try {
                await purgePath(targetVirtual);
                sendAlertEmail(
                  '✅ Command "purge" berhasil dieksekusi',
                  `File/folder "${toDisplayPath(targetVirtual)}" berhasil DIHAPUS PERMANEN dengan PIN yang valid pada ${new Date().toISOString()}.\n\nKalau ini bukan kamu, segera amankan akun Discord-mu — file ini TIDAK BISA dikembalikan.`
                ).catch(() => {});
                await interaction.update({
                  content: `🗑️ **Terhapus permanen:** \`${toDisplayPath(targetVirtual)}\``,
                  components: [],
                }).catch(() => {});
              } catch (err) {
                await interaction.update({
                  content: `❌ Gagal hapus permanen: ${err.message}`,
                  components: [],
                }).catch(() => {});
              }
            } else {
              await interaction.update({
                content: `Dibatalkan. \`${toDisplayPath(targetVirtual)}\` tidak jadi dihapus permanen.`,
                components: [],
              }).catch(() => {});
            }

            resolve(null);
          });

          collector.on('end', () => {
            if (!settled) {
              confirmMsg.edit({
                content: `⏱️ Konfirmasi kadaluarsa. \`${toDisplayPath(targetVirtual)}\` tidak jadi dihapus permanen.`,
                components: [],
              }).catch(() => {});
              resolve(null);
            }
          });
        });
      }

      case 'info': {
        if (args.length < 1) return 'Format: `info <path>`';
        const targetVirtual = resolvePathArg(args[0]);

        let absPath;
        try {
          absPath = resolveForRclone(targetVirtual);
        } catch (err) {
          return `❌ Gagal: ${err.message}`;
        }
        if (!fs.existsSync(absPath)) {
          return `❌ Gagal: \`${toDisplayPath(targetVirtual)}\` tidak ditemukan.`;
        }

        const stats = fs.statSync(absPath);
        const isDir = stats.isDirectory();
        const size = getLocalSize(absPath);
        const modified = stats.mtime.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

        let itemCountLine = '';
        if (isDir) {
          try {
            const itemCount = fs.readdirSync(absPath).length;
            itemCountLine = `\n• Isi: ${itemCount} item`;
          } catch {
            // biarkan kosong kalau gagal baca (mis. permission), gak fatal buat "info"
          }
        }

        return `${isDir ? '📁' : '📄'} **${toDisplayPath(targetVirtual)}**\n` +
          `• Tipe: ${isDir ? 'Folder' : 'File'}\n` +
          `• Ukuran: **${formatBytes(size)}**${itemCountLine}\n` +
          `• Terakhir diubah: ${modified}`;
      }

      case 'preview':
        // Sama seperti shortcut "cd <file>" di atas: WAJIB "await" di sini,
        // kalau tidak, error dari runPreview (PIN salah/kosong, dll) lolos
        // dari try/catch handleCommand dan cuma tampil sebagai "Terjadi
        // kesalahan internal..." yang generik di index.js.
        return await runPreview(args, dscMessage, 'rich');

      case 'archive': {
        if (args.length < 1) return 'Format: `archive <path>` (kalau ukuran asli ≥50MB dan/atau rahasia, tambahkan PIN: `archive <path> <pin>`)';
        if (!dscMessage) return 'Fitur archive cuma bisa dipakai lewat Discord.';

        const srcVirtual = resolvePathArg(args[0]);
        const absSrc = resolveForRclone(srcVirtual);
        if (!fs.existsSync(absSrc)) return `❌ Gagal: \`${toDisplayPath(srcVirtual)}\` tidak ditemukan.`;

        // Sama seperti copy/move/delete: cegah archive folder yang di
        // dalamnya ada BLOCKED_PATH — kalau lolos, isi yang di-block ikut
        // terpaket ke .zip dan ke-upload ke Drive (bocor keluar sandbox).
        if (containsBlockedPath(absSrc)) {
          return `❌ Gagal: \`${toDisplayPath(srcVirtual)}\` tidak bisa di-archive karena mengandung folder/file yang diblokir (BLOCKED_PATHS) di dalamnya. Archive isinya per-item saja, lewati yang diblokir.`;
        }

        const localSize = getLocalSize(absSrc);
        const needsConfidentialPin = isConfidential(absSrc);
        const needsSizePin = localSize >= PIN_SIZE_THRESHOLD;

        if (needsConfidentialPin || needsSizePin) {
          if (args.length < 2) {
            const label = needsConfidentialPin
              ? `🔒 **Data ini bersifat RAHASIA.** \`${toDisplayPath(srcVirtual)}\` butuh PIN keamanan buat di-archive.`
              : `🔒 **Ukuran asli ${formatBytes(localSize)} (≥50MB).** Archive sebesar ini wajib PIN keamanan (cegah bot crash/storage penuh & cegah archive berulang-ulang).`;
            return `${label}\nFormat: \`archive ${args[0]} <pin>\``;
          }
          const reason = needsConfidentialPin
            ? `archive folder rahasia: ${toDisplayPath(srcVirtual)}`
            : `archive besar (${formatBytes(localSize)}): ${toDisplayPath(srcVirtual)}`;
          await requirePin(args, reason);
          if (needsConfidentialPin) {
            sendAlertEmail(
              '🔓 Archive folder RAHASIA diakses',
              `Folder/file rahasia "${toDisplayPath(srcVirtual)}" berhasil di-archive & diupload dengan PIN yang valid pada ${new Date().toISOString()}.\n\nKalau ini bukan kamu, PIN-mu sudah bocor dan data rahasiamu baru saja disalin keluar — segera amankan akun Discord-mu.`
            ).catch(() => {});
          }
        }

        const entityName = path.basename(absSrc);
        const zipName = `${entityName}.zip`;
        const tmpDir = path.join(os.tmpdir(), 'nausync-archive');
        await fs.promises.mkdir(tmpDir, { recursive: true });
        const zipAbsPath = path.join(tmpDir, `${Date.now()}__${zipName}`);

        const progressMessage = await dscMessage.reply(`🗜️ **Mengompres...** \`${entityName}\` (${formatBytes(localSize)})`);

        try {
          await createZip(absSrc, zipAbsPath);
        } catch (err) {
          await progressMessage.edit(`❌ **Gagal compress:** ${err.message}`).catch(() => {});
          return null;
        }

        const zipStat = await fs.promises.stat(zipAbsPath);
        await progressMessage.edit(`📦 **Kompres selesai** (${formatBytes(zipStat.size)}, dari ${formatBytes(localSize)}). Mulai upload ke Google Drive...`).catch(() => {});

        const remoteTarget = `${config.rcloneRemote}:${config.rcloneStagingFolder}/${zipName}`;

        return new Promise((resolve) => {
          const proc = spawn('rclone', ['copyto', zipAbsPath, remoteTarget, '--progress', '--stats', '3s']);
          let lastUpdate = 0;

          proc.stdout.on('data', async (data) => {
            const output = data.toString();
            const match = output.match(/(\d+)%\s*,/);
            if (match) {
              const now = Date.now();
              if (now - lastUpdate > 4000) {
                lastUpdate = now;
                await progressMessage.edit(`📤 **Upload:** \`${match[1]}%\` — \`${zipName}\` (${formatBytes(zipStat.size)})`).catch(() => {});
              }
            }
          });

          proc.on('close', async (code) => {
            // WAJIB coba hapus .zip lokal APAPUN hasilnya (sukses/gagal) — dia
            // cuma perantara sementara, bukan tempat penyimpanan. Kalau
            // dibiarkan nyangkut pas upload gagal, lama-lama numpuk dan malah
            // bertentangan sama tujuan command ini sendiri (hemat storage).
            await fs.promises.unlink(zipAbsPath).catch(() => {});

            if (code === 0) {
              await progressMessage.edit(
                `✅ **Archive & Upload Sukses!**\n• Sumber: \`${toDisplayPath(srcVirtual)}\` (${formatBytes(localSize)})\n• Zip: \`${zipName}\` (${formatBytes(zipStat.size)})\n• Zip lokal sudah dihapus permanen.`
              ).catch(() => {});
              resolve('Proses transfer selesai.');
            } else {
              await progressMessage.edit(`❌ **Upload gagal!** (exit code ${code}). Zip lokal tetap sudah dihapus, tidak ada sisa file numpuk.`).catch(() => {});
              resolve(`Proses archive/upload gagal dengan error code ${code}`);
            }
          });
        });
      }

      case 'clear': {
        if (!dscMessage) return 'Fitur ini cuma bisa dipakai lewat Discord.';

        if (previewMessages.length === 0) {
          return 'Belum ada file preview yang perlu dihapus.';
        }

        const channel = dscMessage.channel;
        let deletedCount = 0;

        // Hanya hapus pesan-pesan yang memang tercatat dari "preview" — aman,
        // gak akan menyentuh command kamu atau balasan bot yang lain.
        for (const msgId of previewMessages) {
          try {
            const msg = await channel.messages.fetch(msgId);
            await msg.delete();
            deletedCount++;
          } catch {
            // pesan mungkin sudah dihapus manual / kadaluarsa, lewati saja
          }
        }

        previewMessages.length = 0; // reset catatan setelah dibersihkan
        savePreviewMessages(); // ikut kosongkan file, bukan cuma di memory

        return `🧹 **Selesai!** ${deletedCount} pesan preview berhasil dihapus.`;
      }

      case 'network': {
        const verbose = args[0] && ['detail', '-v', 'verbose'].includes(args[0].toLowerCase());

        // Mode detail nampilin info teknis (IP lokal, gateway, DNS, MAC
        // address, dst) yang bisa dipakai buat fingerprinting/pemetaan
        // jaringan kalau histori chat ini kebaca orang lain (mis. Discord
        // kena hack) — jadi wajib PIN, sama gatenya kayak preview folder
        // rahasia. Mode default (tanpa detail) tetap bebas PIN.
        if (verbose) {
          if (args.length < 2) {
            return '🔒 **Detail teknis jaringan (IP lokal/gateway/DNS/MAC) butuh PIN keamanan.**\nFormat: `network detail <pin>`';
          }
          await requirePin(args, 'network detail (IP lokal/gateway/DNS/MAC)');
        }

        let profiles;
        try {
          profiles = await getNetworkInfo();
        } catch (err) {
          return `❌ Gagal membaca status jaringan: ${err.message}`;
        }

        if (!profiles.length) {
          return '❌ Tidak ada koneksi jaringan aktif terdeteksi (laptop mungkin sedang offline / semua adapter terputus).';
        }

        const blocks = profiles.map((p) => formatNetworkProfile(p, verbose));
        const footer = verbose ? '' : '\n\n_Ketik `network detail <pin>` untuk lihat IP lokal/gateway/DNS/MAC address._';
        return `**🌐 Status Jaringan Laptop**\n\n${blocks.join('\n\n')}${footer}`;
      }

      case 'baterai': {
        let battery;
        try {
          battery = await getBatteryInfo();
        } catch (err) {
          return `❌ Gagal membaca info baterai: ${err.message}`;
        }

        if (!battery) {
          return '❌ Tidak ditemukan baterai di laptop ini (mungkin PC desktop, atau driver baterai tidak terbaca lewat WMI).';
        }

        const percent = battery.EstimatedChargeRemaining;
        const status = describeBatteryStatus(battery.BatteryStatus);
        const chargeLine = status.charging ? '⚡ Sedang di-cas' : '🔌 Tidak di-cas';
        const icon = status.charging ? '🔋' : (percent <= 20 ? '🪫' : '🔋');

        const standbyMinutes = await getStandbyMinutes();
        const modeLine = describePowerMode(standbyMinutes);

        return `${icon} **Status Baterai Laptop**\n• Persentase: **${percent}%**\n• ${chargeLine} _(${status.label})_\n• Mode Power: ${modeLine}`;
      }

      case 'disk': {
        let disks;
        try {
          disks = await getDiskInfo();
        } catch (err) {
          return `❌ Gagal membaca info disk: ${err.message}`;
        }

        if (!disks.length) return '❌ Tidak ada drive lokal fisik yang terbaca.';

        const blocks = disks.map((d) => {
          const total = Number(d.Size) || 0;
          const free = Number(d.FreeSpace) || 0;
          const used = total - free;
          const percentUsed = total > 0 ? Math.round((used / total) * 100) : 0;
          return `💽 **${d.DeviceID}**\n• Total: ${formatBytes(total)}\n• Terpakai: ${formatBytes(used)} (${percentUsed}%)\n• Sisa: **${formatBytes(free)}**`;
        });

        return `**Status Disk Laptop**\n\n${blocks.join('\n\n')}`;
      }

      case 'mode': {
        if (args.length < 1) return 'Format: `mode <server/hemat>`';
        const subMode = args[0].toLowerCase(); // Mengambil string murni sub-argumen

        if (subMode === 'server') {
          // Set timeout AC *dan* DC (baterai) ke 0 (never), dan TUNGGU hasilnya + cek error
          const results = await Promise.all([
            runPowercfg('/change standby-timeout-ac 0'),
            runPowercfg('/change standby-timeout-dc 0'),
            runPowercfg('/change hibernate-timeout-ac 0'),
            runPowercfg('/change hibernate-timeout-dc 0'),
          ]);
          const failed = results.filter(r => !r.ok);
          if (failed.length > 0) {
            return `❌ **Gagal mengubah Mode Server!**\n${failed.map(f => `• ${f.error}`).join('\n')}\n\nKemungkinan bot tidak punya izin/berjalan bukan sebagai user yang login, atau ada Group Policy yang mengunci pengaturan power.`;
          }

          // Verifikasi nilai yang benar-benar tersimpan di skema aktif
          const actualMinutes = await getStandbyMinutes();
          const verified = actualMinutes === 0
            ? '✅ Terverifikasi: standby timeout = Never'
            : `⚠️ Perintah sukses tapi nilai terbaca saat ini: ${actualMinutes ?? 'tidak diketahui'} menit (mungkin ada aplikasi lain yang override, cek Settings > Power).`;

          return `🖥️ **Laptop beralih ke Mode Server!**\n• Status Sleep: **Never**\n• Status Hibernate: **Never**\n${verified}\nLaptop Anda akan tetap terjaga selamanya untuk memproses unggahan besar Anda.`;
        } 
        
        if (subMode === 'hemat') {
          // Kembalikan ke durasi bawaan harian Anda (Sleep 15 menit, Hibernate 3 jam), AC & DC
          const results = await Promise.all([
            runPowercfg('/change standby-timeout-ac 15'),
            runPowercfg('/change standby-timeout-dc 15'),
            runPowercfg('/change hibernate-timeout-ac 180'),
            runPowercfg('/change hibernate-timeout-dc 180'),
          ]);
          const failed = results.filter(r => !r.ok);
          if (failed.length > 0) {
            return `❌ **Gagal mengubah Mode Hemat!**\n${failed.map(f => `• ${f.error}`).join('\n')}`;
          }
          return '🔋 **Laptop beralih ke Mode Hemat (Default)!**\n• Status Sleep: **15 Menit**\n• Status Hibernate: **3 Jam**\nLaptop akan otomatis tidur jika didiamkan sesuai setingan harian Anda.';
        }

        return 'Format salah. Gunakan: `mode server` atau `mode hemat`';
      }

      case 'shutdown': {
        await requirePin(args, 'shutdown');

        // BUG FIX: sebelumnya exec() dipanggil tanpa callback/await sama
        // sekali — kalau shutdown.exe gagal dijalankan (path salah,
        // permission ditolak, dll), bot TETAP bilang "Perintah Diterima"
        // ke user padahal laptop tidak jadi mati, dan errornya tidak
        // ketahuan siapa pun. Lebih parah lagi, child process yang gagal
        // spawn tanpa listener 'error' bisa bikin proses bot sendiri crash
        // diam-diam. Sekarang di-await lewat execAsync (promisify) dan
        // hasilnya dicek eksplisit sebelum bilang sukses ke user/email.
        try {
          await execAsync('C:\\Windows\\System32\\shutdown.exe /s /f /t 15');
        } catch (err) {
          sendAlertEmail(
            '❌ Command "shutdown" GAGAL dieksekusi',
            `PIN valid, tapi command shutdown.exe GAGAL dijalankan.\nError: ${err.message}\nWaktu: ${new Date().toISOString()}`
          ).catch(() => {});
          return `❌ PIN valid, tapi shutdown **GAGAL dijalankan**: ${err.message}`;
        }

        sendAlertEmail(
          '✅ Command "shutdown" berhasil dieksekusi',
          `Command "shutdown" berhasil dijalankan dengan PIN yang valid pada ${new Date().toISOString()}.\n\nKalau ini bukan kamu, PIN-mu sudah bocor — segera amankan akun Discord (ganti password, cek active sessions, aktifkan 2FA). PIN sudah otomatis diganti (lihat email rotasi terpisah), tapi laptop sudah kadung dimatikan.`
        ).catch(() => {});
        return '🔌 **Perintah Diterima!** Laptop Anda di rumah akan otomatis dimatikan dalam waktu 15 detik ke depan. Koneksi bot segera terputus.\n_(Berubah pikiran? Ketik `cancel` sebelum 15 detik habis.)_';
      }

      case 'restart': {
        await requirePin(args, 'restart');

        try {
          await execAsync('C:\\Windows\\System32\\shutdown.exe /r /f /t 15');
        } catch (err) {
          sendAlertEmail(
            '❌ Command "restart" GAGAL dieksekusi',
            `PIN valid, tapi command shutdown.exe (/r) GAGAL dijalankan.\nError: ${err.message}\nWaktu: ${new Date().toISOString()}`
          ).catch(() => {});
          return `❌ PIN valid, tapi restart **GAGAL dijalankan**: ${err.message}`;
        }

        sendAlertEmail(
          '✅ Command "restart" berhasil dieksekusi',
          `Command "restart" berhasil dijalankan dengan PIN yang valid pada ${new Date().toISOString()}.\n\nKalau ini bukan kamu, segera amankan akun Discord-mu.`
        ).catch(() => {});
        return '🔄 **Perintah Diterima!** Laptop Anda di rumah akan otomatis restart dalam waktu 15 detik ke depan. Koneksi bot akan terputus sebentar dan bot Nausync Cloud akan otomatis aktif lagi begitu Windows selesai booting (asalkan sudah di-setting auto-start).\n_(Berubah pikiran? Ketik `cancel` sebelum 15 detik habis.)_';
      }

      // Batalkan shutdown/restart yang masih dalam masa tunggu 15 detik
      // ("shutdown.exe /a" = abort pending shutdown). Sengaja TIDAK butuh
      // PIN — ini aksi yang MENGURANGI risiko (membatalkan aksi berbahaya),
      // bukan menambah, jadi tidak masuk akal untuk di-gate PIN sama
      // seperti aksinya sendiri. Kalau dipanggil tanpa ada shutdown yang
      // pending, shutdown.exe akan balas error — itu wajar, cukup
      // dilaporkan apa adanya.
      case 'cancel': {
        try {
          await execAsync('C:\\Windows\\System32\\shutdown.exe /a');
        } catch (err) {
          return `⚠️ Tidak ada shutdown/restart yang bisa dibatalkan (atau gagal: ${err.message}).`;
        }
        sendAlertEmail(
          '🛑 Shutdown/restart dibatalkan',
          `Command "cancel" berhasil membatalkan shutdown/restart yang sedang pending, pada ${new Date().toISOString()}.`
        ).catch(() => {});
        return '🛑 **Dibatalkan!** Shutdown/restart yang tadi pending sudah dihentikan, laptop tetap menyala.';
      }

      case 'chgpin': {
        if (args.length < 1) return 'Format: `chgpin <pin_lama>`';
        try {
          await changePin(args[0]);
          return '🔐 **PIN berhasil diganti!** PIN baru sudah dikirim ke email alert-mu. PIN lama sudah tidak berlaku lagi.';
        } catch (err) {
          return `❌ Gagal ganti PIN: ${err.message}`;
        }
      }

      case 'download': {
        if (args.length < 1) return 'Format: `download <path>` (kalau file/folder rahasia dan/atau ukuran ≥50MB, tambahkan PIN: `download <path> <pin>`)';
        
        const targetPath = resolvePathArg(args[0]);
        const absPath = resolveForRclone(targetPath);
        
        if (!fs.existsSync(absPath)) return `❌ Gagal: File atau folder tidak ditemukan.`;

        const localSize = getLocalSize(absPath);
        const needsConfidentialPin = isConfidential(absPath);
        const needsSizePin = localSize >= PIN_SIZE_THRESHOLD;

        if (needsConfidentialPin || needsSizePin) {
          if (args.length < 2) {
            const label = needsConfidentialPin
              ? `🔒 **Data ini bersifat RAHASIA.** \`${toDisplayPath(targetPath)}\` butuh PIN keamanan buat didownload.`
              : `🔒 **Ukuran ${formatBytes(localSize)} (≥50MB).** Download sebesar ini wajib PIN keamanan (cegah bot crash/storage Drive penuh & cegah download berulang-ulang kalau Discord-mu kena hack).`;
            return `${label}\nFormat: \`download ${args[0]} <pin>\``;
          }
          const reason = needsConfidentialPin
            ? `download folder/file rahasia: ${toDisplayPath(targetPath)}`
            : `download besar (${formatBytes(localSize)}): ${toDisplayPath(targetPath)}`;
          await requirePin(args, reason);

          if (needsConfidentialPin) {
            sendAlertEmail(
              '🔓 Download folder/file RAHASIA dijalankan',
              `Folder/file rahasia "${toDisplayPath(targetPath)}" berhasil didownload ke Google Drive dengan PIN yang valid pada ${new Date().toISOString()}.\n\nKalau ini bukan kamu, PIN-mu sudah bocor dan data rahasiamu baru saja disalin keluar — segera amankan akun Discord-mu.`
            ).catch(() => {});
          }
        }

        const driveFreeSpace = await getDriveFreeSpace();
        
        if (localSize > driveFreeSpace) {
          return `❌ **Unduhan Ditolak!** Ukuran target melebihi kapasitas Google Drive Anda.\n` +
                 `• Target: **${formatBytes(localSize)}**\n` +
                 `• Sisa Drive: **${formatBytes(driveFreeSpace)}**`;
        }
        
        const stats = fs.statSync(absPath);
        const isDir = stats.isDirectory();
        const entityName = targetPath.replace(/\\/g, '/').split('/').pop() || 'download';
        
        let progressMessage = null;
        if (dscMessage) {
          progressMessage = await dscMessage.reply(`⏳ **Mempersiapkan rclone...** Menghitung data **${formatBytes(localSize)}**`);
        }

        return new Promise((resolve) => {
          let rcloneCmd = 'copy';
          let remoteTarget = `${config.rcloneRemote}:${config.rcloneStagingFolder}/${entityName}`;
          
          if (!isDir) {
            rcloneCmd = 'copyto';
            remoteTarget = `${config.rcloneRemote}:${config.rcloneStagingFolder}/${entityName}`;
          }

          const process = spawn('rclone', [rcloneCmd, absPath, remoteTarget, '--progress', '--stats', '3s']);
          
          let lastUpdate = 0;

          process.stdout.on('data', async (data) => {
            const output = data.toString();
            const match = output.match(/(\d+)%\s*,/);
            if (match && progressMessage) {
              const currentProgress = match[1] + "%";
              const now = Date.now();
              if (now - lastUpdate > 4000) {
                lastUpdate = now;
                await progressMessage.edit(`📦 **Sedang Upload:** \`${currentProgress}\` Selesai\n• Target: "${entityName}" (${formatBytes(localSize)})`).catch(() => {});
              }
            }
          });

          process.on('close', async (code) => {
            if (code === 0) {
              if (progressMessage) {
                await progressMessage.edit(`✅ **Upload Sukses 100%!**\n• Target: "${entityName}"\n• Ukuran: **${formatBytes(localSize)}**\nSilakan cek Google Drive di HP Anda.`).catch(() => {});
              }
              resolve(`Proses transfer selesai.`);
            } else {
              if (progressMessage) {
                await progressMessage.edit(`❌ **Proses Gagal!** Terjadi kesalahan saat rclone melakukan transfer data.`).catch(() => {});
              }
              resolve(`Proses transfer dihentikan dengan error code ${code}`);
            }
          });
        });
      }

      default:
        return `Command tidak dikenali: "${command}". Ketik "help" untuk daftar command.`;
    }
  } catch (err) {
    return `Gagal: ${err.message}`;
  }
}
