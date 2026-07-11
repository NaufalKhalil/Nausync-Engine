import path from 'node:path';
import { config } from './config.js';

/**
 * Resolve path relatif terhadap BASE_DIR dan pastikan hasilnya
 * tidak keluar dari BASE_DIR (mencegah "../../" traversal atau path absolut liar).
 * Melempar error kalau path dicurigai di luar whitelist.
 */
export function safeResolve(userPath) {
  if (!userPath || typeof userPath !== 'string') {
    throw new Error('Path kosong atau tidak valid.');
  }

  // Kalau user kirim path absolut, tetap dianggap relatif terhadap BASE_DIR
  // supaya tidak bisa "kabur" ke C:\ atau folder sistem.
  const cleaned = userPath.replace(/^[a-zA-Z]:\\?/, '').replace(/^\/+/, '');
  const resolved = path.resolve(config.baseDir, cleaned);

  const normalizedBase = config.baseDir.endsWith(path.sep)
    ? config.baseDir
    : config.baseDir + path.sep;

  if (resolved !== config.baseDir && !resolved.startsWith(normalizedBase)) {
    throw new Error(`Path "${userPath}" berada di luar folder yang diizinkan.`);
  }

  return resolved;
}
