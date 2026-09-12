import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { pool, redact, shutdown } from './postgres.js';

/**
 * PostgreSQL migration runner. Applies every migrations/NNN_*.sql file that
 * has not been applied before, in filename order, each inside its own
 * transaction, recording what ran in schema_migrations.
 *
 * Idempotent by design: running it twice applies nothing the second time, and
 * the schema files themselves are written so that even a forced re-run is a
 * no-op (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and
 * constraint additions wrapped in an exception-swallowing DO block). It never
 * drops or truncates anything.
 *
 *   npm run migrate:postgres
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');

async function ensureTrackingTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function migratePostgres(): Promise<{ applied: string[]; skipped: string[] }> {
  await ensureTrackingTable();

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set(
    (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (done.has(file)) { skipped.push(file); continue; }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      console.log(`  applied  ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${file} failed (rolled back): ${redact((err as Error).message)}`);
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

async function main(): Promise<void> {
  console.log(`Migrating PostgreSQL database "${config.postgres.database}"...`);
  try {
    const { applied, skipped } = await migratePostgres();
    if (skipped.length) console.log(`  ${skipped.length} migration(s) already applied, skipped.`);
    console.log(applied.length ? `Done — ${applied.length} migration(s) applied.` : 'Done — database already up to date.');
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('migrate.postgres.ts')) {
  void main();
}
