import { db } from './index.js';

/**
 * The schema is applied when the connection opens (see db/index.ts), because
 * modules prepare statements at import time. This entry point exists so the
 * migration can also be run on its own, and so index.ts states the intent.
 */
export function migrate(): void {
  const tables = db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  const required = ['rigs', 'equipment', 'mechanical_log_uploads', 'mechanical_log_rows', 'users'];
  const missing = required.filter((t) => !tables.includes(t));
  if (missing.length) {
    throw new Error(`The schema is incomplete. Missing tables: ${missing.join(', ')}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate();
  console.log('Schema applied and verified.');
}
