import { listDir, copyPath, movePath, deletePath, resolveForRclone } from './fsops.js';
import { uploadToDrive } from './rclone.js';
import { config } from './config.js';
import fs from 'fs';
import { exec, spawn } from 'child_process';

const HELP_TEXT = `*Nausync Cloud — command yang tersedia*

list <folder>          -> lihat isi folder (default: root)
copy <src> <dst>        -> copy file/folder
move <src> <dst>        -> move file/folder
delete <path>           -> hapus file/folder
download <path>         -> upload file atau folder ke Google Drive
shutdown                -> matikan laptop rumah dari jarak jauh
help                    -> tampilkan pesan ini

Semua path relatif terhadap folder yang diizinkan di laptop.`;

function tokenize(text) {
  const regex = /"([^"]+)"|(\S+)/g;
  const tokens = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
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

  const [cmd, ...args] = tokenize(text);
  if (!cmd) return HELP_TEXT;
  const command = cmd.toLowerCase();

  try {
    switch (command) {
      case 'help':
        return HELP_TEXT;

      case 'list': {
        const entries = await listDir(args[0] || '.');
        return entries.length ? `Isi folder:\n${entries.join('\n')}` : 'Folder kosong.';
      }

      case 'copy': {
        if (args.length < 2) return 'Format: copy <src> <dst>';
        const dst = await copyPath(args[0], args[1]);
        return `Berhasil copy ke: ${dst}`;
      }

      case 'move': {
        if (args.length < 2) return 'Format: move <src> <dst>';
        const dst = await movePath(args[0], args[1]);
        return `Berhasil move ke: ${dst}`;
      }

      case 'delete': {
        if (args.length < 1) return 'Format: delete <path>';
        const target = await deletePath(args[0]);
        return `Berhasil hapus: ${target}`;
      }

      case 'shutdown': {
        // Memanggil path absolut shutdown.exe milik Windows agar lolos dari blokir background task
        exec('C:\\Windows\\System32\\shutdown.exe /s /f /t 0', (err) => {
          if (err) {
            // Jika rute utama diblokir, gunakan jalur pintas alternatif PowerShell Force
            exec('powershell -Command "Stop-Computer -Force"');
          }
        });
        return '🔌 *Perintah Diterima!* Laptop Anda di rumah dipaksa mati (*shutdown*) secara instan dari background senyap. Koneksi bot segera terputus.';
      }

      case 'download': {
        if (args.length < 1) return 'Format: download <path>';
        
        const targetPath = args[0];
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