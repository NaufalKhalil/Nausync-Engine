import { Client, GatewayIntentBits, Partials } from 'discord.js';
import pino from 'pino';
import { handleCommand } from './commands.js';
import { checkRcloneReady } from './rclone.js';

const logger = pino({ level: 'info' });

const client = new Client({
  intents: [GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

client.once('ready', async () => {
  logger.info(`Bot Nausync Cloud sukses terhubung ke Discord sebagai: ${client.user.tag}`);
  try {
    await checkRcloneReady();
    logger.info('rclone OK, remote Google Drive terhubung.');
  } catch (err) {
    logger.warn('rclone belum siap / remote belum dikonfigurasi.');
  }
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
  } catch (err) {
    logger.error(err, 'Gagal memproses command');
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
