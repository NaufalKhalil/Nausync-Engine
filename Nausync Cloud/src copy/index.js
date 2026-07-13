import { Client, GatewayIntentBits, Partials } from 'discord.js';
import pino from 'pino';
import { handleCommand, BUILD_TAG } from './commands.js';
import { checkRcloneReady } from './rclone.js';
import { initPin, startPinExpiryWatcher, sendAlertEmail } from './pinStore.js';
import { purgeExpiredTrash } from './fsops.js';
import { config } from './config.js';

const logger = pino({ level: 'info' });

// --- Sweep harian auto-purge trash (lihat purgeExpiredTrash di fsops.js) ---
// Item di ".trash" yang sudah lebih tua dari config.trashRetentionDays
// dihapus PERMANEN otomatis, supaya trash tidak menumpuk selamanya. Owner
// tetap dapat email ringkasan tiap kali ada yang benar-benar terhapus,
// supaya tidak ada penghapusan permanen yang terjadi "diam-diam" tanpa
// sepengetahuan owner.
const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1x/hari cukup

async function runTrashRetentionSweep() {
  try {
    const purged = await purgeExpiredTrash();
    if (purged.length === 0) return;

    logger.info(`Auto-purge trash: ${purged.length} item dihapus permanen (retensi ${config.trashRetentionDays} hari terlewati).`);
    await sendAlertEmail(
      `🧹 Auto-purge trash (${purged.length} item, retensi ${config.trashRetentionDays} hari)`,
      `${purged.length} item di ".trash" sudah lebih dari ${config.trashRetentionDays} hari dan otomatis DIHAPUS PERMANEN oleh sweep rutin:\n\n${purged.map((p) => `• ${p}`).join('\n')}\n\nIni bukan aksi manual — kalau ada item yang ternyata masih dibutuhkan, seharusnya sudah tidak bisa dipulihkan lagi. Pertimbangkan naikkan TRASH_RETENTION_DAYS di .env kalau retensi 30 hari (default) dirasa terlalu singkat.`
    ).catch((err) => logger.warn(`⚠️ Gagal kirim email ringkasan auto-purge trash: ${err.message}`));
  } catch (err) {
    logger.error(err, 'Gagal menjalankan auto-purge trash.');
  }
}

const client = new Client({
  intents: [GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

// Fungsi untuk menyalakan fitur utama setelah berhasil login ke Discord
client.once('ready', async () => {
  logger.info(`Bot Nausync Cloud sukses terhubung ke Discord sebagai: ${client.user.tag}`);
  logger.info(`Kode command yang aktif: ${BUILD_TAG}`);
  
  // Cek kesiapan rclone sekali saja saat awal start
  try {
    await checkRcloneReady();
    logger.info('rclone OK, remote Google Drive terhubung.');
  } catch (err) {
    logger.warn('rclone belum siap / remote belum dikonfigurasi.');
  }

  // Generate PIN keamanan (sekali saja, first run) & kirim ke email —
  // lihat pinStore.js. Command berbahaya (shutdown/restart/purge) butuh
  // PIN ini, independen dari Discord, supaya tetap aman walau akun
  // Discord kena hack.
  try {
    await initPin();
    startPinExpiryWatcher();
    logger.info('PIN keamanan siap (cek pin.store.json / email kalau baru pertama kali).');
  } catch (err) {
    logger.error(err, 'Gagal inisialisasi PIN keamanan.');
  }

  // Jalankan sweep auto-purge trash sekali di awal, lalu jadwalkan ulang
  // tiap TRASH_SWEEP_INTERVAL_MS selama proses bot hidup (pola sama seperti
  // startPinExpiryWatcher di atas).
  runTrashRetentionSweep();
  setInterval(runTrashRetentionSweep, TRASH_SWEEP_INTERVAL_MS);

  // --- FITUR BARU: KIRIM PESAN NOTIFIKASI STARTUP LANGSUNG KE DM OWNER ---
  try {
    const ownerId = process.env.DISCORD_OWNER_ID;
    if (ownerId) {
      // Ambil objek pengguna berdasarkan ID pemilik di file .env
      const owner = await client.users.fetch(ownerId);
      
      // Kirim pesan salam pembuka ke DM pribadi Anda
      await owner.send(`🟢 *Bot Nausync Cloud Telah Aktif!* \nLaptop Anda di rumah baru saja dinyalakan/login dan sistem background sudah *stand-by* menerima perintah Anda.`);
      logger.info('Notifikasi startup sukses dikirim ke DM owner.');
    }
  } catch (err) {
    logger.error(err, 'Gagal mengirim notifikasi pesan startup ke DM owner');
  }
  // ---------------------------------------------------------------------
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id !== process.env.DISCORD_OWNER_ID) return;

  const text = message.content.trim();
  if (!text) return;

  logger.info(`Command diterima dari owner via Discord: ${text}`);

  try {
    // Teruskan objek message ke fungsi commands agar pesan bisa diedit otomatis
    const reply = await handleCommand(text, message);

    // Kirim pesan teks akhir jika ada log info tambahan
    if (reply && !reply.includes("Proses transfer selesai")) {
      await message.reply(reply);
    }

    // Catat balasan bot ke log juga (dipotong biar log tidak kebanjiran),
    // supaya kalau ada masalah bisa dicek dari log server tanpa perlu
    // screenshot Discord tiap kali.
    const replyPreview = reply ? reply.slice(0, 300).replace(/\n/g, ' ') : '(null / sudah dikirim manual)';
    logger.info(`Balasan bot untuk "${text}": ${replyPreview}`);
  } catch (err) {
    logger.error(err, `Gagal memproses command "${text}"`);
    await message.reply('Terjadi kesalahan internal saat menjalankan perintah.');
  }
});

client.on('error', (err) => {
  logger.error(err, 'Terjadi error pada koneksi Discord');
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  logger.error(err, 'Gagal login ke Discord.');
  process.exit(1);
});
