import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from '../config.js';
import { pool, redact, shutdown } from '../db/postgres.js';
import { migratePostgres } from '../db/migrate.postgres.js';

/**
 * One-way data copy: existing SQLite database -> PostgreSQL.
 *
 *   npm run migrate:sqlite-to-postgres
 *
 * The source database is opened READ-ONLY and is never written to, renamed or
 * deleted — the file this reads (server/data/pms.db by default, or DB_FILE)
 * remains exactly as it was, and remains the live database until the
 * application itself is switched over.
 *
 * Behaviour:
 *  - applies the PostgreSQL schema first (idempotent), so the target is ready
 *  - copies tables in foreign-key dependency order
 *  - preserves every primary key exactly (this schema's ids are application-
 *    generated strings, so there are no identity sequences to resync)
 *  - converts SQLite's 0/1 into real booleans for the columns the PostgreSQL
 *    schema declares BOOLEAN, and leaves every other integer alone
 *  - preserves NULLs and text exactly
 *  - one transaction per table: a table either lands completely or not at all
 *  - prints a per-table row count comparison at the end, and exits non-zero
 *    if any table does not match
 *
 * Re-running is safe: rows already present (same primary key) are skipped via
 * ON CONFLICT DO NOTHING rather than duplicated or overwritten.
 */

/**
 * Dependency order: a table only appears after everything it references. Any
 * table not listed here is copied afterwards, alphabetically — new tables are
 * therefore never silently skipped, they just copy last (and will only fail
 * if they happen to have an unlisted parent, which the summary will show).
 */
const TABLE_ORDER = [
  'companies', 'departments', 'modules', 'rigs', 'dpr_rigs', 'ilm_rigs',
  'users', 'user_rig_access', 'login_history',
  'material_master', 'engine_master', 'transmission_master',
  'oil_lubricants', 'equipment', 'equipment_oil_lubricants',
  'equipment_master_imports', 'equipment_history', 'equipment_service_records',
  'equipment_transfers', 'document_files', 'material_transfers',
  'mechanical_log_uploads', 'mechanical_log_rows',
  'health_check_uploads', 'health_check_records',
  'health_narrative_uploads', 'health_narratives',
  'rig_holidays', 'audit_logs', 'notification_settings', 'notifications', 'smtp_settings',
  'dpr_import_batches', 'dpr_reports', 'dpr_line_items',
  'hsd_import_batches', 'hsd_reports', 'hsd_equipment_lines', 'hsd_site_lines',
  'employees', 'manpower_roster',
  'drr_import_batches', 'drr_reports', 'drr_rig_responsibility',
  'drr_approval_history', 'drr_attendance_lines', 'drr_oil_lines', 'drr_hydraulic_lines',
  'ilm_import_batches', 'ilm_transactions', 'ilm_individual', 'ilm_individual_lines',
  'ilm_delay_records', 'ilm_contract_duration_rules',
  'ilm_trailer_header', 'ilm_trailer_movements', 'ilm_trailer_loads',
  'ilm_crane_rounds', 'ilm_cranes',
  'internal_followups', 'invoice_settings', 'invoices', 'demo_data_log',
];

interface TableResult {
  table: string; sqliteRows: number; postgresRows: number; inserted: number; error?: string;
}

/** Reads which columns PostgreSQL declares BOOLEAN, so 0/1 is converted for exactly those and nothing else. */
async function booleanColumns(): Promise<Map<string, Set<string>>> {
  const rows = (await pool.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'boolean'
  `)).rows;
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Set());
    map.get(r.table_name)!.add(r.column_name);
  }
  return map;
}

function toPg(value: unknown, isBoolean: boolean): unknown {
  if (value === null || value === undefined) return null;
  if (isBoolean) {
    if (value === 1 || value === '1' || value === true) return true;
    if (value === 0 || value === '0' || value === false) return false;
    return null;
  }
  if (Buffer.isBuffer(value)) return value;
  return value;
}

async function copyTable(
  sqlite: Database.Database, table: string, boolCols: Set<string>,
): Promise<TableResult> {
  const result: TableResult = { table, sqliteRows: 0, postgresRows: 0, inserted: 0 };

  const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
  result.sqliteRows = rows.length;

  if (rows.length > 0) {
    const columns = Object.keys(rows[0]);
    const quoted = columns.map((c) => `"${c}"`).join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        const values = columns.map((c) => toPg(row[c], boolCols.has(c)));
        const res = await client.query(sql, values);
        result.inserted += res.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      result.error = redact((err as Error).message);
    } finally {
      client.release();
    }
  }

  try {
    const countRes = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM "${table}"`);
    result.postgresRows = Number(countRes.rows[0].n);
  } catch (err) {
    result.error ??= redact((err as Error).message);
  }
  return result;
}

async function main(): Promise<void> {
  const dbFile = config.dbFile;
  console.log('SQLite -> PostgreSQL migration');
  console.log(`  source (read-only): ${dbFile}`);
  console.log(`  target database   : ${config.postgres.database}`);
  console.log('');

  const sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });

  try {
    console.log('Applying PostgreSQL schema...');
    await migratePostgres();

    const boolMap = await booleanColumns();

    const present = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
        .map((r) => r.name),
    );
    const ordered = TABLE_ORDER.filter((t) => present.has(t));
    const extras = [...present].filter((t) => !TABLE_ORDER.includes(t) && t !== 'schema_migrations').sort();
    if (extras.length) console.log(`Note: copying unlisted table(s) last: ${extras.join(', ')}`);

    const results: TableResult[] = [];
    for (const table of [...ordered, ...extras]) {
      process.stdout.write(`  ${table} ... `);
      const r = await copyTable(sqlite, table, boolMap.get(table) ?? new Set());
      results.push(r);
      console.log(r.error ? `FAILED (${r.error})` : `${r.inserted} inserted`);
    }

    console.log('\n================ VALIDATION ================');
    let mismatches = 0;
    for (const r of results) {
      const status = r.error ? 'ERROR' : r.sqliteRows === r.postgresRows ? 'MATCH' : 'MISMATCH';
      if (status !== 'MATCH') mismatches++;
      console.log(
        `${r.table.padEnd(32)} SQLite: ${String(r.sqliteRows).padStart(6)}   PostgreSQL: ${String(r.postgresRows).padStart(6)}   ${status}`,
      );
      if (r.error) console.log(`  └─ ${r.error}`);
    }
    console.log('===========================================');
    console.log(
      mismatches === 0
        ? `All ${results.length} table(s) match. Migration successful.`
        : `${mismatches} of ${results.length} table(s) did NOT match — migration is NOT complete.`,
    );
    console.log(`\nThe source database was not modified: ${path.basename(dbFile)}`);
    if (mismatches > 0) process.exitCode = 1;
  } catch (err) {
    console.error('Migration aborted:', redact((err as Error).message));
    process.exitCode = 1;
  } finally {
    sqlite.close();
    await shutdown();
  }
}

void main();
