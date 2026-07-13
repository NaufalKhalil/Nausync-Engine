import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Upload file/folder lokal ke folder staging Google Drive lewat rclone.
 * Membutuhkan rclone sudah terinstall & remote sudah dikonfigurasi (`rclone config`).
 */
export async function uploadToDrive(localAbsPath) {
  const remoteTarget = `${config.rcloneRemote}:${config.rcloneStagingFolder}`;
  const fileName = path.basename(localAbsPath);

  await execFileAsync('rclone', ['copy', localAbsPath, remoteTarget, '--progress=false']);

  return { fileName, remoteTarget };
}

/**
 * Cek apakah rclone terinstall & remote bisa diakses. Berguna untuk healthcheck saat startup.
 */
export async function checkRcloneReady() {
  await execFileAsync('rclone', ['lsd', `${config.rcloneRemote}:`]);
}
