import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { serialiseModuleAccess } from '../services/moduleAccess.js';
import type { Role } from '../services/rights.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';

/**
 * Single shared connection. better-sqlite3 is synchronous, so a request handler
 * holds the connection only for the duration of its statements; WAL mode lets
 * readers proceed while a write transaction is open.
 */
export const db = new Database(config.dbFile);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 10000');
db.pragma('synchronous = NORMAL');

/**
 * The schema is applied as soon as the connection opens. Modules prepare their
 * statements at import time, so the tables must already exist by then; every
 * statement in schema.sql is CREATE ... IF NOT EXISTS and is safe to re-run.
 */
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
db.exec(fs.readFileSync(schemaPath, 'utf8'));

/**
 * The notifications table predates the per-user notification system and was
 * created with CREATE TABLE IF NOT EXISTS, so a plain re-run of schema.sql can
 * never add the columns the new system needs. This adds them once, idempotently,
 * on every startup, and never touches a row that already exists.
 */
function migrateNotificationsTable(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('notifications')").all() as { name: string }[]).map((c) => c.name),
  );
  const add = (name: string, ddl: string) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE notifications ADD COLUMN ${ddl}`);
  };
  // No REFERENCES clause: SQLite does not enforce a foreign key added this way,
  // and rigId already carries a non-FK sentinel value ('all') elsewhere in this
  // schema (rig_holidays), so an unenforced, nullable link is consistent here.
  add('userId', 'userId TEXT');
  add('title', 'title TEXT');
  add('referenceDate', 'referenceDate TEXT');
  add('dedupeKey', 'dedupeKey TEXT');
  add('createdAt', 'createdAt TEXT');
  add('readAt', 'readAt TEXT');
  add('resolvedAt', 'resolvedAt TEXT');
  // Generic reference beyond equipmentId/rigId — a DRR report id for DRR_*
  // notification types, so the bell can deep-link to the exact report
  // ("Click notification -> open the exact DRR").
  add('entityId', 'entityId TEXT');

  // Existing rows (the machine service-due notifications) predate createdAt;
  // backfill from their reference date so they still sort sensibly.
  db.exec("UPDATE notifications SET createdAt = date || 'T00:00:00.000Z' WHERE createdAt IS NULL");

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(dedupeKey) WHERE dedupeKey IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(userId, createdAt)');
}
migrateNotificationsTable();

/**
 * Two more columns added after equipment and health_narratives already existed
 * in deployed databases: equipment's current physical place (for the transfer
 * feature) and health_narratives' equipmentId (for machine-specific manual
 * entries, added after the table was first used for bulk workbook imports).
 */
function migrateEquipmentAndNarrativeColumns(): void {
  const equipmentColumns = new Set(
    (db.prepare("PRAGMA table_info('equipment')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!equipmentColumns.has('currentPlace')) db.exec('ALTER TABLE equipment ADD COLUMN currentPlace TEXT');
  if (!equipmentColumns.has('currentPlaceSince')) db.exec('ALTER TABLE equipment ADD COLUMN currentPlaceSince TEXT');
  // Every machine that already existed is presumed active; only Equipment
  // Master's own edits ever set this to 0.
  if (!equipmentColumns.has('isActive')) {
    db.exec('ALTER TABLE equipment ADD COLUMN isActive INTEGER NOT NULL DEFAULT 1');
  }

  const narrativeColumns = new Set(
    (db.prepare("PRAGMA table_info('health_narratives')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!narrativeColumns.has('equipmentId')) {
    db.exec('ALTER TABLE health_narratives ADD COLUMN equipmentId TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_narrative_equipment ON health_narratives(equipmentId)');
  }
}
migrateEquipmentAndNarrativeColumns();

/**
 * Every user that existed before the module-access layer was added keeps
 * exactly the PMS access it already had (module-level access only — its real
 * granular permissions are untouched, still in the rights column) so nobody
 * is locked out by this migration; DPR/ILM start closed for everyone but
 * Admin, who gets full access to every module per spec.
 */
function migrateModuleAccessColumn(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('users')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('moduleAccess')) {
    db.exec('ALTER TABLE users ADD COLUMN moduleAccess TEXT');
    const rows = db.prepare('SELECT id, role FROM users').all() as { id: string; role: string }[];
    const update = db.prepare('UPDATE users SET moduleAccess = ? WHERE id = ?');
    for (const row of rows) {
      update.run(serialiseModuleAccess({}, row.role as Role), row.id);
    }
  }
}
migrateModuleAccessColumn();

/**
 * ilm_import_batches was briefly created (in earlier local development)
 * without transactionId before it was added to schema.sql; CREATE TABLE IF
 * NOT EXISTS can't retrofit a column onto a table that already exists, so
 * this adds it once, idempotently, the same way every other predates-its-
 * final-shape table in this file is handled.
 */
function migrateIlmImportBatchesColumn(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ilm_import_batches'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('ilm_import_batches')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('transactionId')) {
    db.exec('ALTER TABLE ilm_import_batches ADD COLUMN transactionId TEXT REFERENCES ilm_transactions(id) ON DELETE SET NULL');
  }
}
migrateIlmImportBatchesColumn();

/**
 * DPR and ILM used to share PMS's `rigs` table; each now has its own
 * independent Rig Master (`dpr_rigs`/`ilm_rigs`, schema.sql). This is a
 * one-time, data-preserving split:
 *
 * 1. Seed dpr_rigs/ilm_rigs from `rigs`, copying every row WITH THE SAME id
 *    — a one-time bootstrap the first time each table is empty, not a
 *    recurring sync. From that point on the three rig lists are edited
 *    completely independently.
 * 2. Because the ids match, any dpr_reports/dpr_import_batches/
 *    ilm_transactions/ilm_import_batches row created before this migration
 *    still has a valid rigId once those tables' FK target is switched from
 *    `rigs` to `dpr_rigs`/`ilm_rigs` — no row data needs rewriting. SQLite
 *    can't ALTER a column's FK target, so the four tables are recreated
 *    (standard SQLite migration dance: create the new shape, copy every
 *    existing row across, drop the old table, rename) with every existing
 *    row preserved.
 */
function migrateDprIlmRigMasterSplit(): void {
  seedRigsInto('dpr_rigs');
  seedRigsInto('ilm_rigs');
  retargetRigForeignKey('dpr_import_batches', 'dpr_rigs', `
    id TEXT PRIMARY KEY, fileName TEXT NOT NULL, storedFileName TEXT,
    rigId TEXT NOT NULL REFERENCES dpr_rigs(id) ON DELETE RESTRICT,
    uploadedBy TEXT NOT NULL, uploadedAt TEXT NOT NULL, status TEXT NOT NULL,
    recordCount INTEGER NOT NULL DEFAULT 0, errorCount INTEGER NOT NULL DEFAULT 0, errorDetail TEXT
  `);
  retargetRigForeignKey('dpr_reports', 'dpr_rigs', `
    id TEXT PRIMARY KEY, rigId TEXT NOT NULL REFERENCES dpr_rigs(id) ON DELETE RESTRICT,
    dprDate TEXT NOT NULL, source TEXT NOT NULL,
    importBatchId TEXT REFERENCES dpr_import_batches(id) ON DELETE SET NULL,
    createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT NOT NULL
  `);
  retargetRigForeignKey('ilm_import_batches', 'ilm_rigs', `
    id TEXT PRIMARY KEY, fileName TEXT NOT NULL, storedFileName TEXT,
    rigId TEXT NOT NULL REFERENCES ilm_rigs(id) ON DELETE RESTRICT,
    uploadedBy TEXT NOT NULL, uploadedAt TEXT NOT NULL, status TEXT NOT NULL, templateVersion TEXT,
    recordCount INTEGER NOT NULL DEFAULT 0, errorCount INTEGER NOT NULL DEFAULT 0, errorDetail TEXT,
    transactionId TEXT REFERENCES ilm_transactions(id) ON DELETE SET NULL
  `);
  retargetRigForeignKey('ilm_transactions', 'ilm_rigs', `
    id TEXT PRIMARY KEY, ilmNumber TEXT NOT NULL UNIQUE,
    rigId TEXT NOT NULL REFERENCES ilm_rigs(id) ON DELETE RESTRICT,
    date TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Completed',
    importBatchId TEXT REFERENCES ilm_import_batches(id) ON DELETE SET NULL,
    createdBy TEXT NOT NULL, createdAt TEXT NOT NULL, updatedBy TEXT, updatedAt TEXT NOT NULL
  `);
}

function seedRigsInto(targetTable: 'dpr_rigs' | 'ilm_rigs'): void {
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM ${targetTable}`).get() as { n: number }).n;
  if (count > 0) return;
  const rigs = db.prepare('SELECT id, name, rigNumber, rigKey, status, createdAt FROM rigs').all();
  if (rigs.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO ${targetTable} (id, name, rigNumber, rigKey, status, createdAt)
    VALUES (@id, @name, @rigNumber, @rigKey, @status, @createdAt)
  `);
  transact(() => { for (const rig of rigs) insert.run(rig); });
}

/** True if `table.rigId` still has an FK pointing at `rigs` rather than `newTarget`. */
function rigIdStillTargetsRigs(table: string): boolean {
  const fks = db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as { table: string; from: string }[];
  return fks.some((fk) => fk.from === 'rigId' && fk.table === 'rigs');
}

function retargetRigForeignKey(table: string, _newTarget: string, newColumnsDdl: string): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table);
  if (!tableExists || !rigIdStillTargetsRigs(table)) return;

  db.pragma('foreign_keys = OFF');
  transact(() => {
    const tmp = `${table}__migrating`;
    db.exec(`CREATE TABLE ${tmp} (${newColumnsDdl})`);
    db.exec(`INSERT INTO ${tmp} SELECT * FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  });
  db.pragma('foreign_keys = ON');
}
migrateDprIlmRigMasterSplit();

/**
 * `departments` and `users.departmentId` predate this schema in older
 * databases; add the column once, idempotently. Nullable — no existing user
 * row is touched, only new columns are added. Department only becomes
 * mandatory at the Create User form/API layer, not retroactively here.
 */
function migrateDepartmentColumn(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('users')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('departmentId')) {
    db.exec('ALTER TABLE users ADD COLUMN departmentId TEXT REFERENCES departments(id) ON DELETE RESTRICT');
  }
}
migrateDepartmentColumn();

/**
 * rigs/equipment/oil_lubricants briefly carried a moduleCodes column (a
 * per-record "which modules use this" tag). Admin > Master's rig, equipment
 * and oil/lubricant lists are shared master data used by every module, so
 * the per-record tag was redundant — drop it once, idempotently, from
 * databases that still carry it.
 */
function dropModuleCodesColumns(): void {
  for (const table of ['rigs', 'equipment', 'oil_lubricants']) {
    const tableExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!tableExists) continue;
    const columns = new Set(
      (db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map((c) => c.name),
    );
    if (columns.has('moduleCodes')) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN moduleCodes`);
    }
  }
}
dropModuleCodesColumns();

/**
 * dpr_rig_rates (a Cost & Rate Master for a since-removed DPR profitability
 * dashboard) was briefly created — nothing was ever entered into it, and the
 * feature was pulled before use. Drop it once, idempotently, from databases
 * that still carry it.
 */
function dropDprRigRatesTable(): void {
  db.exec('DROP TABLE IF EXISTS dpr_rig_rates');
}
dropDprRigRatesTable();

/**
 * dpr_line_items.breakdownReason (Operational DPR report's "Breakdown
 * Reason" column, manual entry only) postdates dpr_line_items in older
 * databases.
 */
function migrateBreakdownReasonColumn(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('dpr_line_items')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('breakdownReason')) {
    db.exec('ALTER TABLE dpr_line_items ADD COLUMN breakdownReason TEXT');
  }
}
migrateBreakdownReasonColumn();

/** dpr_line_items.otherActivityDescription postdates dpr_line_items in older databases. */
function migrateOtherActivityDescriptionColumn(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('dpr_line_items')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('otherActivityDescription')) {
    db.exec('ALTER TABLE dpr_line_items ADD COLUMN otherActivityDescription TEXT');
  }
}
migrateOtherActivityDescriptionColumn();

/**
 * drr_attendance_lines.employeeCode/shift/inTime/outTime postdate the table's
 * original design (roster-driven attendance) — DRR Site Attendance now
 * records actual manpower directly, with roster reduced to a reference
 * indicator only, so these columns capture what the Rig User actually enters.
 */
function migrateAttendanceLineColumns(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('drr_attendance_lines')").all() as { name: string }[]).map((c) => c.name),
  );
  const additions: [string, string][] = [
    ['employeeCode', 'TEXT'], ['shift', 'TEXT'], ['inTime', 'TEXT'], ['outTime', 'TEXT'],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE drr_attendance_lines ADD COLUMN ${name} ${ddl}`);
  }
}
migrateAttendanceLineColumns();

/** ilm_individual.contractDateFrom/contractDateTo postdate the table in older databases. */
function migrateIlmContractDateColumns(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('ilm_individual')").all() as { name: string }[]).map((c) => c.name),
  );
  const additions: [string, string][] = [['contractDateFrom', 'TEXT'], ['contractDateTo', 'TEXT']];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ilm_individual ADD COLUMN ${name} ${ddl}`);
  }
}
migrateIlmContractDateColumns();

/** ilm_crane_rounds.oldLocation/newLocation postdate the table in older databases. */
function migrateIlmCraneRoundLocationColumns(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('ilm_crane_rounds')").all() as { name: string }[]).map((c) => c.name),
  );
  const additions: [string, string][] = [['oldLocation', 'TEXT'], ['newLocation', 'TEXT'], ['locationType', 'TEXT']];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ilm_crane_rounds ADD COLUMN ${name} ${ddl}`);
  }
}
migrateIlmCraneRoundLocationColumns();

/**
 * ilm_trailer_movements.contractDays/contractRuleId postdate the table — the
 * ILM Contract Duration Rules auto-calc (Admin > Master > ILM Contract
 * Duration Rules). ilm_contract_duration_rules itself needs no migration:
 * it's a brand-new table, and schema.sql's CREATE TABLE IF NOT EXISTS already
 * creates it on every boot, including for existing databases.
 */
function migrateIlmTrailerMovementContractColumns(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ilm_trailer_movements'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('ilm_trailer_movements')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('contractDays')) db.exec('ALTER TABLE ilm_trailer_movements ADD COLUMN contractDays REAL');
  if (!columns.has('contractRuleId')) {
    db.exec('ALTER TABLE ilm_trailer_movements ADD COLUMN contractRuleId TEXT REFERENCES ilm_contract_duration_rules(id) ON DELETE SET NULL');
  }
}
migrateIlmTrailerMovementContractColumns();

/**
 * ilm_individual.movementDistanceKm/contractAllowedHours/contractAllowedDays/
 * contractRuleId postdate the table — the ILM header's own Contract Duration
 * Rules preview (shown below Release Date/Time on ILM Add), separate from
 * each Trailer Movement round's own leadDistanceKm/allowedDurationHrs.
 */
function migrateIlmIndividualContractColumns(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ilm_individual'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('ilm_individual')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('movementDistanceKm')) db.exec('ALTER TABLE ilm_individual ADD COLUMN movementDistanceKm REAL');
  if (!columns.has('contractAllowedHours')) db.exec('ALTER TABLE ilm_individual ADD COLUMN contractAllowedHours REAL');
  if (!columns.has('contractAllowedDays')) db.exec('ALTER TABLE ilm_individual ADD COLUMN contractAllowedDays REAL');
  if (!columns.has('contractRuleId')) {
    db.exec('ALTER TABLE ilm_individual ADD COLUMN contractRuleId TEXT REFERENCES ilm_contract_duration_rules(id) ON DELETE SET NULL');
  }
}
migrateIlmIndividualContractColumns();

/** material_master.manualLocation postdates the table — the fallback location for an unassigned record. */
function migrateMaterialMasterColumns(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('material_master')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('manualLocation')) db.exec('ALTER TABLE material_master ADD COLUMN manualLocation TEXT');
}
migrateMaterialMasterColumns();

/** The DRR approval workflow's columns (submittedAt/approvedBy/.../rejectionReason) postdate drr_reports. */
function migrateDrrApprovalColumns(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('drr_reports')").all() as { name: string }[]).map((c) => c.name),
  );
  const additions: [string, string][] = [
    ['submittedAt', 'TEXT'], ['approvedBy', 'TEXT'], ['approvedAt', 'TEXT'],
    ['rejectedBy', 'TEXT'], ['rejectedAt', 'TEXT'], ['rejectionReason', 'TEXT'],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE drr_reports ADD COLUMN ${name} ${ddl}`);
  }
}
migrateDrrApprovalColumns();

/** The Material/Oil Master counters postdate equipment_master_imports in databases created by the first version of that import. */
function migrateEquipmentMasterImportColumns(): void {
  const names = () => new Set(
    (db.prepare("PRAGMA table_info('equipment_master_imports')").all() as { name: string }[]).map((c) => c.name),
  );
  // The catalogs went from "deactivate what the workbook omits" to "delete it";
  // the counters were renamed to match, keeping whatever earlier runs recorded.
  const renames: [string, string][] = [
    ['oilLubricantsDeactivated', 'oilLubricantsRemoved'],
    ['materialsDeactivated', 'materialsRemoved'],
  ];
  for (const [from, to] of renames) {
    const columns = names();
    if (columns.has(from) && !columns.has(to)) {
      db.exec(`ALTER TABLE equipment_master_imports RENAME COLUMN ${from} TO ${to}`);
    }
  }
  const columns = names();
  const additions: [string, string][] = [
    ['oilLubricantsRemoved', 'INTEGER NOT NULL DEFAULT 0'],
    ['oilMappingsRemoved', 'INTEGER NOT NULL DEFAULT 0'],
    ['materialsCreated', 'INTEGER NOT NULL DEFAULT 0'],
    ['materialsUpdated', 'INTEGER NOT NULL DEFAULT 0'],
    ['materialsRemoved', 'INTEGER NOT NULL DEFAULT 0'],
    ['materialsRelinked', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE equipment_master_imports ADD COLUMN ${name} ${ddl}`);
  }
}
migrateEquipmentMasterImportColumns();

/** rigs.client/startDate/completionDate/remarksStatus/projectCoordinator postdate the table in older databases — the Admin > Rig Master form's new fields. */
function migrateRigMasterColumns(): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('rigs')").all() as { name: string }[]).map((c) => c.name),
  );
  const additions: [string, string][] = [
    ['client', 'TEXT'], ['startDate', 'TEXT'], ['completionDate', 'TEXT'],
    ['remarksStatus', 'TEXT'], ['projectCoordinator', 'TEXT'],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE rigs ADD COLUMN ${name} ${ddl}`);
  }
}
migrateRigMasterColumns();

/**
 * dpr_rigs.dprStatus briefly held a hand-set Pending/Completed value. The DPR
 * Dashboard now derives that status from whether the rig has a DPR inside the
 * active date window, so the stored column is dead weight — drop it once,
 * idempotently, from databases that still carry it.
 */
function dropDprStatusColumn(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dpr_rigs'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('dpr_rigs')").all() as { name: string }[]).map((c) => c.name),
  );
  if (columns.has('dprStatus')) {
    db.exec('ALTER TABLE dpr_rigs DROP COLUMN dprStatus');
  }
}
dropDprStatusColumn();

/**
 * mechanical_log_rows gained 9 columns for the Daily Rig Report form (source,
 * status, hsdConsumptionLiters, and 6 breakdown-detail fields) — all
 * nullable/defaulted, so every pre-existing Excel-imported row is unaffected.
 * Added once, idempotently, for databases that predate this change.
 */
function migrateMechanicalLogDrrColumns(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mechanical_log_rows'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('mechanical_log_rows')").all() as { name: string }[]).map((c) => c.name),
  );
  const additions: [string, string][] = [
    ['source', "TEXT NOT NULL DEFAULT 'excel'"],
    ['status', 'TEXT'],
    ['hsdConsumptionLiters', 'REAL'],
    ['breakdownAt', 'TEXT'],
    ['breakdownDescription', 'TEXT'],
    ['actionTaken', 'TEXT'],
    ['partsRequired', 'TEXT'],
    ['expectedRestoration', 'TEXT'],
    ['breakdownRemark', 'TEXT'],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE mechanical_log_rows ADD COLUMN ${name} ${ddl}`);
  }
}
migrateMechanicalLogDrrColumns();

/**
 * ilm_cranes.releaseDate/releaseTime (Crane Summary report's per-unit
 * "Release Date & Time" field) postdate ilm_cranes in older databases.
 */
function migrateIlmCraneReleaseColumns(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ilm_cranes'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('ilm_cranes')").all() as { name: string }[]).map((c) => c.name),
  );
  for (const name of ['releaseDate', 'releaseTime']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ilm_cranes ADD COLUMN ${name} TEXT`);
  }
}
migrateIlmCraneReleaseColumns();

/**
 * ilm_trailer_loads.arrivalDate/arrivalTime (Trailer Summary report's
 * "Loading Point - Arrival Date/Time" field) postdate ilm_trailer_loads in
 * older databases.
 */
function migrateIlmTrailerArrivalColumns(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ilm_trailer_loads'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('ilm_trailer_loads')").all() as { name: string }[]).map((c) => c.name),
  );
  for (const name of ['arrivalDate', 'arrivalTime']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ilm_trailer_loads ADD COLUMN ${name} TEXT`);
  }
}
migrateIlmTrailerArrivalColumns();

/**
 * ilm_trailer_loads.capacityTon (Individual Summary Dashboard's "Trailer
 * Capacity" total) postdates ilm_trailer_loads in older databases.
 */
function migrateIlmTrailerCapacityColumn(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ilm_trailer_loads'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('ilm_trailer_loads')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('capacityTon')) db.exec('ALTER TABLE ilm_trailer_loads ADD COLUMN capacityTon REAL');
}
migrateIlmTrailerCapacityColumn();

/**
 * ilm_individual.operatorName/wellNo/ilmRatePerDay/ilmExpenses (the
 * Individual Summary Dashboard's Operator Name, Well No. and ILM Time &
 * Costs fields) postdate ilm_individual in older databases.
 */
function migrateIlmIndividualSummaryColumns(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ilm_individual'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('ilm_individual')").all() as { name: string }[]).map((c) => c.name),
  );
  const additions: [string, string][] = [
    ['operatorName', 'TEXT'], ['wellNo', 'TEXT'], ['ilmRatePerDay', 'REAL'], ['ilmExpenses', 'REAL'],
  ];
  for (const [name, ddl] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE ilm_individual ADD COLUMN ${name} ${ddl}`);
  }
}
migrateIlmIndividualSummaryColumns();

/**
 * ILM's Active/Completed lifecycle (an ILM is a rig-relocation project that
 * can run for months, not a single day's movement): ilm_transactions gains
 * endDate/endTime/completedBy/completedAt/durationHours; the old
 * UNIQUE(rigId, date) — "one movement per rig per day" — is replaced by
 * "one ACTIVE ilm per rig at a time" (idx_ilm_txn_active_rig, already in
 * schema.sql for fresh installs; here only for databases that still carry
 * the old index). ilm_trailer_loads/ilm_cranes gain movementId/roundId so a
 * round's rows can be grouped without disturbing the transactionId every
 * existing report already reads. Existing single-round data is backfilled
 * into a synthetic "round 1" so nothing already entered disappears from any
 * report; lifecycle columns on pre-existing transactions are left NULL
 * (never fabricated) rather than guessed.
 */
function migrateIlmLifecycle(): void {
  const hasTable = (name: string) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name);
  if (!hasTable('ilm_transactions')) return;

  const txnColumns = new Set(
    (db.prepare("PRAGMA table_info('ilm_transactions')").all() as { name: string }[]).map((c) => c.name),
  );
  const txnAdditions: [string, string][] = [
    ['endDate', 'TEXT'], ['endTime', 'TEXT'], ['completedBy', 'TEXT'],
    ['completedAt', 'TEXT'], ['durationHours', 'REAL'],
  ];
  for (const [name, ddl] of txnAdditions) {
    if (!txnColumns.has(name)) db.exec(`ALTER TABLE ilm_transactions ADD COLUMN ${name} ${ddl}`);
  }

  const oldIndexExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_ilm_txn_rig_date'",
  ).get();
  if (oldIndexExists) db.exec('DROP INDEX idx_ilm_txn_rig_date');

  if (hasTable('ilm_trailer_loads')) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('ilm_trailer_loads')").all() as { name: string }[]).map((c) => c.name),
    );
    if (!cols.has('movementId')) {
      db.exec('ALTER TABLE ilm_trailer_loads ADD COLUMN movementId TEXT REFERENCES ilm_trailer_movements(id) ON DELETE CASCADE');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_ilm_trailer_movement ON ilm_trailer_loads(movementId)');
  }
  if (hasTable('ilm_cranes')) {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('ilm_cranes')").all() as { name: string }[]).map((c) => c.name),
    );
    if (!cols.has('roundId')) {
      db.exec('ALTER TABLE ilm_cranes ADD COLUMN roundId TEXT REFERENCES ilm_crane_rounds(id) ON DELETE CASCADE');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_ilm_crane_round ON ilm_cranes(roundId)');
  }
  if (!hasTable('ilm_trailer_movements') || !hasTable('ilm_crane_rounds')) return; // schema.sql creates these; nothing more to backfill yet

  // Backfill: one "round 1" per transaction that has legacy header/cranes but no round yet.
  const legacyHeaders = db.prepare(`
    SELECT th.* FROM ilm_trailer_header th
    WHERE NOT EXISTS (SELECT 1 FROM ilm_trailer_movements m WHERE m.transactionId = th.transactionId)
  `).all() as {
    transactionId: string; rigName: string | null; oldLocation: string | null; newLocation: string | null;
    leadDistanceKm: number | null; rigReleaseAt: string | null; fleetReportAt: string | null; allowedDurationHrs: number | null;
  }[];
  if (legacyHeaders.length) {
    const insertMovement = db.prepare(`
      INSERT INTO ilm_trailer_movements (id, transactionId, movementNo, rigName, oldLocation, newLocation,
        leadDistanceKm, rigReleaseAt, fleetReportAt, allowedDurationHrs, createdBy, createdAt)
      VALUES (@id, @transactionId, 1, @rigName, @oldLocation, @newLocation,
        @leadDistanceKm, @rigReleaseAt, @fleetReportAt, @allowedDurationHrs, 'migration', @createdAt)
    `);
    const linkLoads = db.prepare('UPDATE ilm_trailer_loads SET movementId = ? WHERE transactionId = ? AND movementId IS NULL');
    const stamp = nowIso();
    for (const h of legacyHeaders) {
      const id = newId('ilmmvt');
      insertMovement.run({ ...h, id, createdAt: stamp });
      linkLoads.run(id, h.transactionId);
    }
  }

  const transactionsWithUnroundedCranes = db.prepare(`
    SELECT DISTINCT transactionId FROM ilm_cranes
    WHERE roundId IS NULL
  `).all() as { transactionId: string }[];
  if (transactionsWithUnroundedCranes.length) {
    const insertRound = db.prepare(`
      INSERT INTO ilm_crane_rounds (id, transactionId, roundNo, createdBy, createdAt)
      VALUES (@id, @transactionId, 1, 'migration', @createdAt)
    `);
    const linkCranes = db.prepare('UPDATE ilm_cranes SET roundId = ? WHERE transactionId = ? AND roundId IS NULL');
    const stamp = nowIso();
    for (const { transactionId } of transactionsWithUnroundedCranes) {
      const existingRound = db.prepare(
        'SELECT id FROM ilm_crane_rounds WHERE transactionId = ? AND roundNo = 1',
      ).get(transactionId) as { id: string } | undefined;
      const id = existingRound?.id ?? newId('ilmrnd');
      if (!existingRound) insertRound.run({ id, transactionId, createdAt: stamp });
      linkCranes.run(id, transactionId);
    }
  }
}
migrateIlmLifecycle();

/**
 * equipment.ecmPresent/etToolApplicable (Equipment Master's uploaded-workbook
 * columns) postdate `equipment` in older databases.
 */
function migrateEquipmentMasterColumns(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'equipment'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('equipment')").all() as { name: string }[]).map((c) => c.name),
  );
  for (const name of ['ecmPresent', 'etToolApplicable']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE equipment ADD COLUMN ${name} INTEGER`);
  }
}
migrateEquipmentMasterColumns();

/**
 * equipment.transferred was a simple Yes/No/Unknown flag imported from the
 * Equipment Master workbook, independent of and confusingly named next to the
 * real transfer history (equipment_transfers / Admin > Master > Transfer
 * Equipment). Removed permanently in favor of that one real system — drop it
 * once, idempotently, from databases that still carry it.
 */
function dropEquipmentTransferredColumn(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'equipment'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('equipment')").all() as { name: string }[]).map((c) => c.name),
  );
  if (columns.has('transferred')) db.exec('ALTER TABLE equipment DROP COLUMN transferred');
}
dropEquipmentTransferredColumn();

/** equipment_transfers.destinationType ('Rig' | 'Yard' | 'Other') postdates the table in older databases. */
function migrateEquipmentTransfersDestinationType(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'equipment_transfers'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('equipment_transfers')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('destinationType')) db.exec('ALTER TABLE equipment_transfers ADD COLUMN destinationType TEXT');
}
migrateEquipmentTransfersDestinationType();

/**
 * oil_lubricants.equipmentName (Oil & Lubricant Master's "which equipment"
 * link) postdates oil_lubricants in older databases.
 */
function migrateOilLubricantEquipmentNameColumn(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oil_lubricants'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('oil_lubricants')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('equipmentName')) db.exec('ALTER TABLE oil_lubricants ADD COLUMN equipmentName TEXT');
}
migrateOilLubricantEquipmentNameColumn();

/**
 * Engine Master and Transmission Master were briefly two separate tables
 * before being unified into one material_master table (materialType 'Engine'
 * | 'Transmission'). This copies any rows already imported into the old two
 * tables across exactly once — it never runs again once material_master has
 * rows, and the old tables are left in place untouched either way, so the
 * original data can never be lost even if this runs more than once.
 */
function migrateEngineTransmissionIntoMaterialMaster(): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM material_master').get() as { n: number };
  if (existing.n > 0) return;

  const copy = (from: 'engine_master' | 'transmission_master', materialType: 'Engine' | 'Transmission') => {
    const rows = db.prepare(`SELECT * FROM ${from}`).all() as Record<string, unknown>[];
    const insert = db.prepare(`
      INSERT INTO material_master (id, rigId, equipmentId, materialType, name, make, model, serialNumber, status, source, createdBy, createdAt, updatedAt)
      VALUES (@id, @rigId, @equipmentId, @materialType, @name, @make, @model, @serialNumber, @status, @source, @createdBy, @createdAt, @updatedAt)
    `);
    for (const row of rows) {
      insert.run({ ...row, materialType, name: row.application });
    }
  };
  copy('engine_master', 'Engine');
  copy('transmission_master', 'Transmission');
}
migrateEngineTransmissionIntoMaterialMaster();

/**
 * material_master.rigId started out NOT NULL, but Material Master is now a
 * global catalog (the same engine/transmission spec is reusable across many
 * rigs' equipment) — rigId only ever carried "which rig's workbook row this
 * came from" and is no longer required or read anywhere. SQLite can't loosen
 * a NOT NULL constraint in place, so this rebuilds the table with rigId
 * nullable, copying every existing row across untouched (same rebuild-and-
 * swap shape as retargetRigForeignKey below). Guarded on rigId still being
 * NOT NULL, so it runs at most once.
 */
function migrateMaterialMasterRigOptional(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'material_master'",
  ).get();
  if (!tableExists) return;
  const rigIdColumn = (db.prepare("PRAGMA table_info('material_master')").all() as { name: string; notnull: number }[])
    .find((c) => c.name === 'rigId');
  if (!rigIdColumn || rigIdColumn.notnull === 0) return;

  db.pragma('foreign_keys = OFF');
  transact(() => {
    const tmp = 'material_master__migrating';
    db.exec(`
      CREATE TABLE ${tmp} (
        id            TEXT PRIMARY KEY,
        rigId         TEXT REFERENCES rigs(id) ON DELETE SET NULL,
        equipmentId   TEXT REFERENCES equipment(id) ON DELETE SET NULL,
        materialType  TEXT NOT NULL,
        name          TEXT NOT NULL,
        make          TEXT,
        model         TEXT,
        serialNumber  TEXT,
        status        TEXT NOT NULL DEFAULT 'Active',
        source        TEXT NOT NULL DEFAULT 'Manual',
        createdBy     TEXT NOT NULL,
        createdAt     TEXT NOT NULL,
        updatedAt     TEXT NOT NULL
      )
    `);
    db.exec(`INSERT INTO ${tmp} SELECT * FROM material_master`);
    db.exec('DROP TABLE material_master');
    db.exec(`ALTER TABLE ${tmp} RENAME TO material_master`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_material_master_rig ON material_master(rigId)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_material_master_equipment ON material_master(equipmentId)');
  });
  db.pragma('foreign_keys = ON');
}
migrateMaterialMasterRigOptional();

/**
 * equipment.linkedEngineId/linkedTransmissionId: the new link direction from
 * Equipment to its optional global Engine/Transmission Material Master
 * record (superseding material_master.equipmentId, which pointed the other
 * way and could only ever link one equipment per material row).
 */
function migrateEquipmentMaterialLinkColumns(): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'equipment'",
  ).get();
  if (!tableExists) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info('equipment')").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has('linkedEngineId')) db.exec('ALTER TABLE equipment ADD COLUMN linkedEngineId TEXT REFERENCES material_master(id) ON DELETE SET NULL');
  if (!columns.has('linkedTransmissionId')) db.exec('ALTER TABLE equipment ADD COLUMN linkedTransmissionId TEXT REFERENCES material_master(id) ON DELETE SET NULL');
}
migrateEquipmentMaterialLinkColumns();

/**
 * One-time backfill for the FK-direction flip above: any material_master row
 * that already had its old (now-deprecated) equipmentId set — from this
 * feature's brief prior use of that direction — gets mirrored onto the
 * equipment row's new linkedEngineId/linkedTransmissionId, so no linkage
 * already made is silently lost. Only ever sets a currently-null column.
 */
function backfillEquipmentMaterialLinks(): void {
  const rows = db.prepare(`
    SELECT id, equipmentId, materialType FROM material_master WHERE equipmentId IS NOT NULL
  `).all() as { id: string; equipmentId: string; materialType: 'Engine' | 'Transmission' }[];
  for (const row of rows) {
    const column = row.materialType === 'Engine' ? 'linkedEngineId' : 'linkedTransmissionId';
    db.prepare(`UPDATE equipment SET ${column} = ? WHERE id = ? AND ${column} IS NULL`).run(row.id, row.equipmentId);
  }
}
backfillEquipmentMaterialLinks();

/**
 * Traceability-only FK additions so Equipment Master is referenceable by ID
 * from every point-in-time transaction record that already stores an
 * equipment name snapshot: ILM's per-movement crane/trailer rows, and DRR's
 * Breakdown Equipment / HSD per-equipment lines. The existing text columns
 * remain the authoritative historical label forever — these new columns are
 * purely additive and nullable, never touching a row that already exists.
 */
function migrateEquipmentTraceabilityColumns(): void {
  const additions: [string, string, string][] = [
    ['ilm_cranes', 'equipmentId', 'ALTER TABLE ilm_cranes ADD COLUMN equipmentId TEXT REFERENCES equipment(id) ON DELETE SET NULL'],
    ['ilm_trailer_loads', 'equipmentId', 'ALTER TABLE ilm_trailer_loads ADD COLUMN equipmentId TEXT REFERENCES equipment(id) ON DELETE SET NULL'],
    ['dpr_line_items', 'breakdownEquipmentId', 'ALTER TABLE dpr_line_items ADD COLUMN breakdownEquipmentId TEXT REFERENCES equipment(id) ON DELETE SET NULL'],
    ['hsd_equipment_lines', 'equipmentId', 'ALTER TABLE hsd_equipment_lines ADD COLUMN equipmentId TEXT REFERENCES equipment(id) ON DELETE SET NULL'],
  ];
  for (const [table, column, ddl] of additions) {
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!tableExists) continue;
    const columns = new Set((db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]).map((c) => c.name));
    if (!columns.has(column)) db.exec(ddl);
  }
}
migrateEquipmentTraceabilityColumns();

/**
 * The admin-manageable module list predates the modules table in older
 * databases; seed the three fixed modules once, idempotently.
 */
function seedModules(): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO modules (id, code, name, description, isActive, createdAt)
    VALUES (@id, @code, @name, @description, 1, @createdAt)
  `);
  const now = new Date().toISOString();
  const defs = [
    { code: 'PMS', name: 'PMS Portal', description: 'Preventive Maintenance System for the rig fleet.' },
    { code: 'DPR', name: 'DPR Module', description: 'Daily Progress Report module.' },
    { code: 'ILM', name: 'ILM Module', description: 'Inventory / Logistics Management module.' },
    { code: 'DRR', name: 'Daily Rig Report', description: 'Unified daily entry across DPR, Mechanical Log and HSD.' },
  ];
  for (const d of defs) {
    insert.run({ id: `mod_${d.code.toLowerCase()}`, code: d.code, name: d.name, description: d.description, createdAt: now });
  }
}
seedModules();

/**
 * DRR's "Lubricating Oil" section used to read a fixed 11-item array in code
 * (server/src/routes/dailyRigReport.ts); it now reads Admin > Master > Oil &
 * Lubricant Master (oil_lubricants) instead. Seed those same 11 names so a
 * database that has never had an Oil & Lubricant Master isn't left with a
 * blank Lubricating Oil section.
 *
 * Only ever runs against an EMPTY table. `INSERT OR IGNORE` on fixed ids was
 * not enough: it skips a row only while that row still exists, so once an
 * Admin deleted a seeded type (or an Excel master import replaced the whole
 * list) the next restart silently put all 11 back. The list belongs to
 * whoever manages it; defaults are for a database that has none.
 */
function seedDefaultLubricants(): void {
  const existing = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM oil_lubricants').get();
  if ((existing?.n ?? 0) > 0) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO oil_lubricants (id, name, nameKey, status, createdAt)
    VALUES (@id, @name, @nameKey, 'Active', @createdAt)
  `);
  const now = new Date().toISOString();
  const names = [
    'ENGINE OIL 15W40', 'Hydraulic Oil-68', 'Gear Oil 80-W-90', 'Transmission Oil-30',
    'SAE-40 Compressor Oil', 'REFINED OIL (FOR BCU)', 'PREMIX 50-50 COOLANT',
    'DOPE AS PER API', 'Grease M.P', 'Corona-68 Oil (ULTRA COOLANT)', 'Drillo Meter Charging Oil',
  ];
  for (const name of names) {
    const nameKey = name.trim().toLowerCase().replace(/\s+/g, ' ');
    insert.run({ id: `oil_seed_${nameKey.replace(/[^a-z0-9]+/g, '_')}`, name, nameKey, createdAt: now });
  }
}
seedDefaultLubricants();

/**
 * Runs fn inside a single IMMEDIATE transaction. Ingestion of a workbook must be
 * atomic: if any part throws, nothing is written (spec 3.2 / 11.1).
 */
export function transact<T>(fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped.immediate();
}
