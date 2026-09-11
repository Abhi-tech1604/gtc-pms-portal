import { db, transact } from '../db/index.js';
import { ensureSeed } from '../db/seed.js';

/**
 * Clears every operational record and leaves the 16-rig fleet plus the user
 * accounts in place. Use this to hand over a clean system after testing.
 *
 *   npm run reset -- --yes
 */

const TABLES = [
  'mechanical_log_rows',
  'mechanical_log_uploads',
  'equipment_history',
  'health_check_records',
  'health_check_uploads',
  'document_files',
  'notifications',
  'equipment',
];

export function reset(): void {
  transact(() => {
    for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();
  });
  ensureSeed();
}

if (process.argv[1] && process.argv[1].endsWith('reset.ts')) {
  if (!process.argv.includes('--yes')) {
    console.error(
      'This deletes every upload, log row, machine and health check record.\n' +
      'Rigs, companies and user accounts are kept. Re-run with --yes to proceed.',
    );
    process.exit(1);
  }
  reset();
  const rigs = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM rigs').get()!.n;
  console.log(`Reset complete. ${rigs} rigs remain; no operational data left.`);
}
