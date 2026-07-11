import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Environment variable ${name} belum diset. Cek file .env`);
  }
  return val;
}

export const config = {
  ownerNumber: required('OWNER_NUMBER'),
  baseDir: path.resolve(required('BASE_DIR')),
  rcloneRemote: required('RCLONE_REMOTE'),
  rcloneStagingFolder: process.env.RCLONE_STAGING_FOLDER || 'nausync-staging',
};
