import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(process.cwd());

function resolve(p: string): string {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const dataDir = resolve(process.env.DATA_DIR || './data');

export const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: ensureDir(dataDir),
  dbFile: resolve(process.env.DB_FILE || path.join(dataDir, 'pms.db')),
  uploadDir: ensureDir(resolve(process.env.UPLOAD_DIR || path.join(dataDir, 'uploads'))),
  backupDir: ensureDir(resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'))),
  timezone: process.env.TIMEZONE || 'Asia/Kolkata',
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024,
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

ensureDir(path.dirname(config.dbFile));

// A production deployment must never run on the placeholder secret — every
// token it would ever sign is forgeable by anyone who reads this source.
if (process.env.NODE_ENV === 'production' && config.jwtSecret === 'change-me-in-production') {
  throw new Error('JWT_SECRET must be set to a real secret before running in production.');
}
