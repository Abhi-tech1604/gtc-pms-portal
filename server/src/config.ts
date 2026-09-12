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

/**
 * PostgreSQL connection settings. DATABASE_URL wins when set (the single
 * value a production deployment normally provides); otherwise the discrete
 * PG* variables are assembled into one, so either style works. Nothing here
 * is ever logged — see db/postgres.ts, which redacts the password from every
 * error it reports.
 */
function postgresUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.PGHOST || '127.0.0.1';
  const port = process.env.PGPORT || '5432';
  const database = process.env.PGDATABASE || 'gtc_pms';
  const user = process.env.PGUSER || 'gtc_admin';
  const password = process.env.PGPASSWORD || '';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

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
  postgres: {
    /** True once real connection details are supplied — the switch that says "PostgreSQL is live here". */
    configured: !!(process.env.DATABASE_URL || process.env.PGPASSWORD),
    url: postgresUrl(),
    ssl: /^(1|true|yes)$/i.test(process.env.DB_SSL || ''),
    poolMin: Number(process.env.DB_POOL_MIN || 2),
    poolMax: Number(process.env.DB_POOL_MAX || 20),
    /** Named only so /api/health can report which database it is talking to — never the credentials. */
    database: process.env.PGDATABASE
      || (process.env.DATABASE_URL ? safeDatabaseName(process.env.DATABASE_URL) : 'gtc_pms'),
  },
};

/** Pulls just the database name out of a connection string — never the user, host or password. */
function safeDatabaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '') || 'gtc_pms';
  } catch {
    return 'gtc_pms';
  }
}

ensureDir(path.dirname(config.dbFile));

// A production deployment must never run on the placeholder secret — every
// token it would ever sign is forgeable by anyone who reads this source.
if (process.env.NODE_ENV === 'production' && config.jwtSecret === 'change-me-in-production') {
  throw new Error('JWT_SECRET must be set to a real secret before running in production.');
}
