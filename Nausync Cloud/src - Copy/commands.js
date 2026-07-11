import { listDir, copyPath, movePath, deletePath, resolveForRclone } from './fsops.js';
import { uploadToDrive } from './rclone.js';
import { config } from './config.js';
import fs from 'fs';
import path from 'node:path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';

const execAsync = promisify(exec);

// --- FITUR: "current directory" per sesi bot, biar user tidak perlu ketik ---
// path panjang berulang-ulang tiap mau list/copy/move/delete/download.
// Konsepnya mirip `cd` di terminal: sekali pindah folder dengan "cd <folder>",
// command lain (list, copy, move, delete, download) otomatis dianggap relatif
// terhadap folder itu, kecuali user awali dengan "/" (artinya relatif ke root
// BASE_DIR) atau pakai "..".
// State ini disimpan di memory proses (bukan per-user), cukup karena bot ini
// memang cuma dipakai 1 owner.
let currentDir = '.'; // relatif terhadap BASE_DIR, pakai format "/"

// Nyimpen ID pesan hasil "preview" yang masih "aktif" (belum di-clear), supaya
// command "clear" cuma hapus pesan-pesan itu — bukan seluruh riwayat chat.
// Sengaja simple array di memory, karena bot ini cuma dipakai 1 owner.
const previewMessages = [];

function displayDir() {
  return currentDir === '.' ? '/' : `/${currentDir}`;
}

// Gabungkan sebuah argumen path yang diketik user dengan currentDir yang aktif.
// - "" atau "." -> currentDir apa adanya
// - diawali "/" -> dianggap relatif terhadap root BASE_DIR (bukan currentDir)
// - selain itu -> digabung dengan currentDir (mendukung "..", "../..", dst)
function resolvePathArg(inputPath) {
  if (!inputPath || inputPath === '.') return currentDir;

  const normalizedInput = inputPath.replace(/\\/g, '/');

  if (normalizedInput.startsWith('/')) {
    const stripped = normalizedInput.replace(/^\/+/, '');
    return stripped === '' ? '.' : path.posix.normalize(stripped);
  }

  const base = currentDir === '.' ? '' : currentDir;
  const combined = path.posix.normalize(path.posix.join(base, normalizedInput));

  if (combined === '' || combined === '.') return '.';
  return combined;
}

const HELP_TEXT = `*Nausync Cloud — command yang tersedia*

cd <folder>             -> pindah "folder aktif", biar gak perlu ketik path panjang berulang
cd ..                   -> naik satu folder ke atas
pwd                     -> lihat folder aktif saat ini
list <folder>           -> lihat isi folder (default: folder aktif)
copy <src> <dst>        -> copy file/folder
move <src> <dst>        -> move file/folder
delete <path>           -> hapus file/folder
download <path>         -> upload file atau folder ke Google Drive
preview <path>          -> kirim file biar bisa dilihat langsung di chat (foto, pdf, dokumen kecil, dll)
clear                   -> hapus pesan preview terakhir yang dikirim bot (aman, gak sentuh pesan lain)
baterai                 -> cek persentase baterai, status di-cas atau tidak, & mode power aktif (server/hemat)
mode server             -> ubah laptop ke mode tanpa sleep (menyala terus)
mode hemat              -> kembalikan laptop ke mode hemat biasa (sleep otomatis)
shutdown                -> matikan laptop rumah dari jarak jauh
restart                 -> restart laptop rumah dari jarak jauh
help                    -> tampilkan pesan ini

Semua path relatif terhadap folder aktif (lihat "pwd"). Awali path dengan "/"
untuk merujuk ke root folder yang diizinkan, contoh: list /Dokumen/Kerja`;

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

function formatBytes(bytes) {
  if (bytes === Infinity || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function handleCommand(rawText, dscMessage = null) {
  const text = rawText.trim();
  if (!text) return HELP_TEXT;

  const tokens = tokenize(text);
  if (tokens.length === 0) return HELP_TEXT;
  
  // PERBAIKAN: Mengambil indeks pertama [0] sebagai string command murni
  const command = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  try {
    switch (command) {
      case 'help':
        return HELP_TEXT;

      case 'pwd':
        return `📂 Folder aktif saat ini: \`${displayDir()}\``;

      case 'cd': {
        if (args.length < 1) return `📂 Folder aktif saat ini: \`${displayDir()}\``;

        const targetArg = args[0];
        const newDir = resolvePathArg(targetArg);

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

      case 'list': {
        const targetDir = resolvePathArg(args[0] || '.');
        const entries = await listDir(targetDir);
        if (!entries.length) return `Folder \`${displayDir()}\` kosong.`;

        // Kelompokkan folder dulu baru file, urut alfabetis (case-insensitive),
        // beri nomor urut + ikon supaya lebih gampang dibaca/di-scan
        const collator = new Intl.Collator('id', { sensitivity: 'base' });
        const dirs = entries.filter((e) => e.endsWith('/')).sort(collator.compare);
        const files = entries.filter((e) => !e.endsWith('/')).sort(collator.compare);

        let num = 1;
        const lines = [
          ...dirs.map((d) => `${num++}. 📁 ${d}`),
          ...files.map((f) => `${num++}. 📄 ${f}`),
        ];
        const shownPath = targetDir === '.' ? '/' : `/${targetDir}`;
        const headerBase = `Isi folder "${shownPath}" — ${dirs.length} folder, ${files.length} file`;

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
        if (args.length < 2) return 'Format: copy <src> <dst>';
        const dst = await copyPath(resolvePathArg(args[0]), resolvePathArg(args[1]));
        return `Berhasil copy ke: ${dst}`;
      }

      case 'move': {
        if (args.length < 2) return 'Format: move <src> <dst>';
        const dst = await movePath(resolvePathArg(args[0]), resolvePathArg(args[1]));
        return `Berhasil move ke: ${dst}`;
      }

      case 'delete': {
        if (args.length < 1) return 'Format: delete <path>';
        const target = await deletePath(resolvePathArg(args[0]));
        return `Berhasil hapus: ${target}`;
      }

      case 'preview': {
        if (args.length < 1) return 'Format: preview <path>';
        if (!dscMessage) return 'Fitur preview cuma bisa dipakai lewat Discord.';

        const targetPath = resolvePathArg(args[0]);
        const absPath = resolveForRclone(targetPath);

        if (!fs.existsSync(absPath)) return `❌ File tidak ditemukan.`;

        const stats = fs.statSync(absPath);
        if (stats.isDirectory()) {
          return `❌ "${args[0]}" adalah folder, bukan file. Pakai "list" untuk lihat isinya.`;
        }

        // Batas umum attachment Discord buat bot non-boost server (~8MB). DM
        // pribadi biasanya ikut batas yang sama.
        const MAX_PREVIEW_SIZE = 8 * 1024 * 1024;
        if (stats.size > MAX_PREVIEW_SIZE) {
          return `❌ File terlalu besar untuk preview (*${formatBytes(stats.size)}*, batas ~8MB). Pakai "download" untuk kirim ke Google Drive.`;
        }

        const fileName = path.basename(absPath);
        const sentMsg = await dscMessage.reply({
          content: `👀 *Preview:* \`${fileName}\` (${formatBytes(stats.size)})`,
          files: [{ attachment: absPath, name: fileName }],
        });

        // Catat pesan ini supaya "clear" nanti tahu apa yang boleh dihapus
        previewMessages.push(sentMsg.id);

        return null; // sudah dikirim manual
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

        return `🧹 *Selesai!* ${deletedCount} pesan preview berhasil dihapus.`;
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

        return `${icon} *Status Baterai Laptop*\n• Persentase: *${percent}%*\n• ${chargeLine} _(${status.label})_\n• Mode Power: ${modeLine}`;
      }

      case 'mode': {
        if (args.length < 1) return 'Format: mode <server/hemat>';
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
            return `❌ *Gagal mengubah Mode Server!*\n${failed.map(f => `• ${f.error}`).join('\n')}\n\nKemungkinan bot tidak punya izin/berjalan bukan sebagai user yang login, atau ada Group Policy yang mengunci pengaturan power.`;
          }

          // Verifikasi nilai yang benar-benar tersimpan di skema aktif
          const actualMinutes = await getStandbyMinutes();
          const verified = actualMinutes === 0
            ? '✅ Terverifikasi: standby timeout = Never'
            : `⚠️ Perintah sukses tapi nilai terbaca saat ini: ${actualMinutes ?? 'tidak diketahui'} menit (mungkin ada aplikasi lain yang override, cek Settings > Power).`;

          return `🖥️ *Laptop beralih ke Mode Server!* \n• Status Sleep: *Never* \n• Status Hibernate: *Never* \n${verified}\nLaptop Anda akan tetap terjaga selamanya untuk memproses unggahan besar Anda.`;
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
            return `❌ *Gagal mengubah Mode Hemat!*\n${failed.map(f => `• ${f.error}`).join('\n')}`;
          }
          return '🔋 *Laptop beralih ke Mode Hemat (Default)!* \n• Status Sleep: *15 Menit* \n• Status Hibernate: *3 Jam* \nLaptop akan otomatis tidur jika didiamkan sesuai setingan harian Anda.';
        }

        return 'Format salah. Gunakan: `mode server` atau `mode hemat`';
      }

      case 'shutdown': {
        exec('C:\\Windows\\System32\\shutdown.exe /s /f /t 15');
        return '🔌 *Perintah Diterima!* Laptop Anda di rumah akan otomatis dimatikan dalam waktu 15 detik ke depan. Koneksi bot segera terputus.';
      }

      case 'restart': {
        exec('C:\\Windows\\System32\\shutdown.exe /r /f /t 15');
        return '🔄 *Perintah Diterima!* Laptop Anda di rumah akan otomatis restart dalam waktu 15 detik ke depan. Koneksi bot akan terputus sebentar dan bot Nausync Cloud akan otomatis aktif lagi begitu Windows selesai booting (asalkan sudah di-setting auto-start).';
      }

      case 'download': {
        if (args.length < 1) return 'Format: download <path>';
        
        const targetPath = resolvePathArg(args[0]);
        const absPath = resolveForRclone(targetPath);
        
        if (!fs.existsSync(absPath)) return `❌ Gagal: File atau folder tidak ditemukan.`;

        const localSize = getLocalSize(absPath);
        const driveFreeSpace = await getDriveFreeSpace();
        
        if (localSize > driveFreeSpace) {
          return `❌ *Unduhan Ditolak!* Ukuran target melebihi kapasitas Google Drive Anda.\n` +
                 `• Target: *${formatBytes(localSize)}*\n` +
                 `• Sisa Drive: *${formatBytes(driveFreeSpace)}*`;
        }
        
        const stats = fs.statSync(absPath);
        const isDir = stats.isDirectory();
        const entityName = targetPath.replace(/\\/g, '/').split('/').pop() || 'download';
        
        let progressMessage = null;
        if (dscMessage) {
          progressMessage = await dscMessage.reply(`⏳ *Mempersiapkan rclone...* Menghitung data *${formatBytes(localSize)}*`);
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
                await progressMessage.edit(`📦 *Sedang Upload:* \`${currentProgress}\` Selesai\n• Target: "${entityName}" (${formatBytes(localSize)})`).catch(() => {});
              }
            }
          });

          process.on('close', async (code) => {
            if (code === 0) {
              if (progressMessage) {
                await progressMessage.edit(`✅ *Upload Sukses 100%!* \n• Target: "${entityName}"\n• Ukuran: *${formatBytes(localSize)}*\nSilakan cek Google Drive di HP Anda.`).catch(() => {});
              }
              resolve(`Proses transfer selesai.`);
            } else {
              if (progressMessage) {
                await progressMessage.edit(`❌ *Proses Gagal!* Terjadi kesalahan saat rclone melakukan transfer data.`).catch(() => {});
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

export function isOwner(jid) {
  return jid?.startsWith(config.ownerNumber);
}
