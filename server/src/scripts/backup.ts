import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';

/**
 * Online backup. better-sqlite3's VACUUM INTO writes a consistent copy while the
 * service keeps running, so this is safe to schedule against a live database.
 *
 *   npm run backup            -> data/backups/pms-YYYY-MM-DD-HHmm.db
 *   npm run backup -- 30      -> also prunes backups older than 30 days
 */

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function backup(retentionDays?: number): string {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const target = path.join(config.backupDir, `pms-${stamp()}.db`);
  db.prepare('VACUUM INTO ?').run(target);

  const uploadCount = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM mechanical_log_uploads').get()!.n;
  const rowCount = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM mechanical_log_rows').get()!.n;
  const size = fs.statSync(target).size;
  console.log(`Backup written: ${target}`);
  console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB · ${uploadCount} uploads · ${rowCount} log rows`);

  if (retentionDays && retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 86400000;
    let pruned = 0;
    for (const name of fs.readdirSync(config.backupDir)) {
      if (!name.startsWith('pms-') || !name.endsWith('.db')) continue;
      const full = path.join(config.backupDir, name);
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        pruned++;
      }
    }
    if (pruned) console.log(`  Pruned ${pruned} backup(s) older than ${retentionDays} days.`);
  }

  return target;
}

if (process.argv[1] && process.argv[1].endsWith('backup.ts')) {
  const retention = Number(process.argv[2]);
  backup(Number.isFinite(retention) ? retention : undefined);
}
