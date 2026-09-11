-- PMS Portal schema. Every relationship that matters is a real foreign key so
-- that equipment can never reference a rig that no longer exists (spec 3.2).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  code          TEXT,
  gstNumber     TEXT,
  pan           TEXT,
  contactPerson TEXT,
  email         TEXT,
  phone         TEXT,
  createdAt     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rigs (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,          -- "Rig Name" on the Admin > Rig Master form; must be unique (enforced in routes/rigs.ts, case-insensitive)
  rigNumber         TEXT NOT NULL,          -- technical ID workbooks are matched against — kept alongside Rig Name, not replaced by it
  rigKey            TEXT NOT NULL UNIQUE,   -- normalised rigNumber, spec 8.1
  companyId         TEXT REFERENCES companies(id) ON DELETE SET NULL,
  location          TEXT,
  rigType           TEXT,                  -- "Type": 'Workover' | 'Drilling' (existing rows may still carry the older 'Work-Over' spelling — never rewritten)
  status            TEXT NOT NULL DEFAULT 'Active',
  commissionDate    TEXT,
  client            TEXT,                  -- "Client": ONGC | OIL | free text
  startDate         TEXT,
  completionDate    TEXT,                  -- nullable — blank while the project is ongoing
  remarksStatus     TEXT,                  -- 'On Going Project' | 'Rig Under Commissioning' | 'Project will start further'
  projectCoordinator TEXT,
  createdAt         TEXT NOT NULL
);

-- DPR and ILM each get their own independent Rig Master, structurally
-- separate from `rigs` above and from each other — adding/editing/deleting a
-- rig in one module must never affect another (not a shared table filtered
-- by module). See the migration in db/index.ts for how dpr_reports/
-- ilm_transactions etc. point at these instead of `rigs`.
CREATE TABLE IF NOT EXISTS dpr_rigs (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  rigNumber TEXT NOT NULL,
  rigKey    TEXT NOT NULL UNIQUE,
  status    TEXT NOT NULL DEFAULT 'Active',   -- the rig's own operational status (Active/Idle/Maintenance)
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ilm_rigs (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  rigNumber TEXT NOT NULL,
  rigKey    TEXT NOT NULL UNIQUE,
  status    TEXT NOT NULL DEFAULT 'Active',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment (
  id                  TEXT PRIMARY KEY,
  rigId               TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  name                TEXT NOT NULL,
  nameKey             TEXT NOT NULL,     -- normalised name, scoped to the rig
  category            TEXT NOT NULL DEFAULT 'Others',
  manufacturer        TEXT,
  model               TEXT,
  serialNumber        TEXT,
  serialKey           TEXT,              -- normalised serial, spec 8.4
  assetNumber         TEXT,
  engineNumber        TEXT,
  installationDate    TEXT,
  currentRunningHours INTEGER NOT NULL DEFAULT 0,
  lastServiceHours    INTEGER NOT NULL DEFAULT 0,
  serviceInterval     INTEGER NOT NULL DEFAULT 500,
  lastHealthCheckDate TEXT,
  healthCheckInterval INTEGER NOT NULL DEFAULT 90,
  isBreakdown         INTEGER NOT NULL DEFAULT 0,
  isActive            INTEGER NOT NULL DEFAULT 1,   -- soft status: Equipment Master's Active/Inactive
  status              TEXT NOT NULL DEFAULT 'Normal',
  section             TEXT NOT NULL DEFAULT 'diesel',  -- diesel | generator
  currentPlace        TEXT,               -- set when physically away from rigId: 'Bakrol Yard', 'Central Store', etc.
  currentPlaceSince   TEXT,               -- date of the transfer that set currentPlace
  ecmPresent          INTEGER,            -- Equipment Master import field; nullable (0/1) — unknown until entered, never fabricated
  etToolApplicable    INTEGER,            -- Equipment Master import field; nullable (0/1)
  linkedEngineId      TEXT REFERENCES material_master(id) ON DELETE SET NULL,        -- optional link to the global Engine Material Master
  linkedTransmissionId TEXT REFERENCES material_master(id) ON DELETE SET NULL,       -- optional link to the global Transmission Material Master
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equipment_rig ON equipment(rigId);
CREATE INDEX IF NOT EXISTS idx_equipment_rig_serial ON equipment(rigId, serialKey);
CREATE INDEX IF NOT EXISTS idx_equipment_rig_name ON equipment(rigId, nameKey);

-- Engine Master / Transmission Master: a live, editable roster of the engines
-- and transmissions fitted to each rig — distinct from `health_narratives`
-- (a problem/action history log parsed from a similarly-shaped workbook).
-- `equipmentId` is an optional, best-effort link to an existing `equipment`
-- row (e.g. "Carrier engine" -> the rig's "Rig Carrier Engine" machine); it is
-- never forced, since not every application text names a specific machine.
CREATE TABLE IF NOT EXISTS engine_master (
  id            TEXT PRIMARY KEY,
  rigId         TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
  equipmentId   TEXT REFERENCES equipment(id) ON DELETE SET NULL,
  application   TEXT NOT NULL,
  make          TEXT,
  model         TEXT,
  serialNumber  TEXT,
  status        TEXT NOT NULL DEFAULT 'Active',
  source        TEXT NOT NULL DEFAULT 'Manual',
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engine_master_rig ON engine_master(rigId);
CREATE INDEX IF NOT EXISTS idx_engine_master_equipment ON engine_master(equipmentId);

CREATE TABLE IF NOT EXISTS transmission_master (
  id            TEXT PRIMARY KEY,
  rigId         TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
  equipmentId   TEXT REFERENCES equipment(id) ON DELETE SET NULL,
  application   TEXT NOT NULL,
  make          TEXT,
  model         TEXT,
  serialNumber  TEXT,
  status        TEXT NOT NULL DEFAULT 'Active',
  source        TEXT NOT NULL DEFAULT 'Manual',
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transmission_master_rig ON transmission_master(rigId);
CREATE INDEX IF NOT EXISTS idx_transmission_master_equipment ON transmission_master(equipmentId);

-- Material Master: the single, unified roster of Engine + Transmission
-- records (superseding the separate engine_master/transmission_master tabs
-- above — those two tables are kept, unreferenced, purely so the data they
-- already hold is never at risk; db/index.ts migrates their rows in here
-- once, on first boot after this table was added).
-- Material Master: a global Engine/Transmission catalog, independent of any
-- rig — the same physical-spec record is reusable across many rigs'
-- equipment, linked from the equipment side (equipment.linkedEngineId /
-- linkedTransmissionId below), not owned by one rig or one machine.
-- rigId/equipmentId here are vestigial (harmless historical provenance from
-- an earlier, rig-scoped iteration of this table) and are never required or
-- read by the application.
CREATE TABLE IF NOT EXISTS material_master (
  id            TEXT PRIMARY KEY,
  rigId         TEXT REFERENCES rigs(id) ON DELETE SET NULL,
  equipmentId   TEXT REFERENCES equipment(id) ON DELETE SET NULL,
  materialType  TEXT NOT NULL,   -- 'Engine' | 'Transmission'
  name          TEXT NOT NULL,   -- e.g. "Carrier engine", "DG Set - 1 (125 KVA)"
  make          TEXT,
  model         TEXT,
  serialNumber  TEXT,
  status        TEXT NOT NULL DEFAULT 'Active',
  source        TEXT NOT NULL DEFAULT 'Manual',
  -- Fallback location for a record NOT currently linked to any equipment
  -- (e.g. "Bakrol Yard"). Never competes with the real thing: as soon as the
  -- record is linked to equipment, the rig derived from that equipment is what
  -- every screen shows, and this is ignored. See services/materialMaster.ts.
  manualLocation TEXT,
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_material_master_rig ON material_master(rigId);
CREATE INDEX IF NOT EXISTS idx_material_master_equipment ON material_master(equipmentId);

CREATE TABLE IF NOT EXISTS mechanical_log_uploads (
  id                    TEXT PRIMARY KEY,
  rigId                 TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  fileName              TEXT NOT NULL,
  storedFileName        TEXT,
  uploadDate            TEXT NOT NULL,   -- wall-clock ISO timestamp
  logMonth              TEXT NOT NULL,   -- YYYY-MM
  coverageStartDate     TEXT,            -- earliest logDate ingested
  coverageEndDate       TEXT,            -- latest logDate ingested
  uploadedBy            TEXT NOT NULL,
  status                TEXT NOT NULL,   -- Uploaded | Validation Failed
  recordsImported       INTEGER NOT NULL DEFAULT 0,
  validationErrorsCount INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_uploads_rig ON mechanical_log_uploads(rigId);
CREATE INDEX IF NOT EXISTS idx_uploads_month ON mechanical_log_uploads(rigId, logMonth);

CREATE TABLE IF NOT EXISTS mechanical_log_rows (
  id                            TEXT PRIMARY KEY,
  uploadId                      TEXT NOT NULL REFERENCES mechanical_log_uploads(id) ON DELETE CASCADE,
  equipmentId                   TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  rigId                         TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  sheetDay                      INTEGER NOT NULL,
  logDate                       TEXT NOT NULL,
  isInUse                       TEXT,
  hoursRunDay                   INTEGER,
  hoursRunNight                 INTEGER,
  lubeOilPressure               TEXT,
  lubeOilAdded                  INTEGER,
  openingRunningHours           INTEGER,
  totalRunHours                 INTEGER,
  closingHours                  INTEGER,
  lastServiceHours              INTEGER,
  runningHoursAfterLastService  INTEGER,
  defineHours                   INTEGER,
  hoursRemainingForNextService  INTEGER,
  preventiveMaintenanceDetails  TEXT,
  remarks                       TEXT,
  lastServiceDate               TEXT,
  makeModel                     TEXT,
  serialNumber                  TEXT,
  -- Everything below is additive for the Daily Rig Report form (nullable/
  -- defaulted, so every existing Excel-imported row is unaffected): the
  -- operational status concept Excel never captured, HSD consumption
  -- attributed to this equipment for the day, and breakdown detail fields
  -- shown only when status = 'Breakdown'.
  source                        TEXT NOT NULL DEFAULT 'excel', -- 'excel' | 'drr'
  status                        TEXT,     -- Running | Standby | Breakdown | Maintenance | Not Available
  hsdConsumptionLiters          REAL,
  breakdownAt                   TEXT,
  breakdownDescription          TEXT,
  actionTaken                   TEXT,
  partsRequired                 TEXT,
  expectedRestoration           TEXT,
  breakdownRemark               TEXT
);
CREATE INDEX IF NOT EXISTS idx_rows_upload ON mechanical_log_rows(uploadId);
CREATE INDEX IF NOT EXISTS idx_rows_equipment ON mechanical_log_rows(equipmentId);
CREATE INDEX IF NOT EXISTS idx_rows_rig_date ON mechanical_log_rows(rigId, logDate);

CREATE TABLE IF NOT EXISTS equipment_history (
  id                      TEXT PRIMARY KEY,
  equipmentId             TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  date                    TEXT NOT NULL,
  runningHours            INTEGER,
  addedHours              INTEGER,
  runningSinceLastService INTEGER,
  remainingServiceHours   INTEGER,
  remarks                 TEXT,
  uploadId                TEXT REFERENCES mechanical_log_uploads(id) ON DELETE SET NULL,
  updatedBy               TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_equipment ON equipment_history(equipmentId, date);

CREATE TABLE IF NOT EXISTS health_check_uploads (
  id              TEXT PRIMARY KEY,
  rigId           TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  fileName        TEXT NOT NULL,
  storedFileName  TEXT,
  uploadDate      TEXT NOT NULL,
  checkDate       TEXT,
  uploadedBy      TEXT NOT NULL,
  recordsImported INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hcuploads_rig ON health_check_uploads(rigId);

CREATE TABLE IF NOT EXISTS health_check_records (
  id          TEXT PRIMARY KEY,
  equipmentId TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  rigId       TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  date        TEXT NOT NULL,
  status      TEXT NOT NULL,             -- Normal | Breakdown
  remarks     TEXT,
  inspector   TEXT,
  method      TEXT NOT NULL,             -- Excel | Manual
  uploadId    TEXT REFERENCES health_check_uploads(id) ON DELETE CASCADE,
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hc_equipment ON health_check_records(equipmentId, date);
CREATE INDEX IF NOT EXISTS idx_hc_rig ON health_check_records(rigId, date);

-- One row per service event, append-only (mirrors health_check_records
-- above) — equipment.lastServiceHours is the live "current" pointer, this
-- table is its permanent history. 'DRR' rows come from the "Service Done
-- Today" checkbox on a submitted Daily Rig Report; 'Manual' rows come from
-- the Head Office/Admin Spanner-button entry on Equipment Directory/Detail.
CREATE TABLE IF NOT EXISTS equipment_service_records (
  id           TEXT PRIMARY KEY,
  equipmentId  TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  rigId        TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  date         TEXT NOT NULL,
  serviceHours INTEGER NOT NULL,
  remarks      TEXT,
  method       TEXT NOT NULL,             -- DRR | Manual
  recordedBy   TEXT NOT NULL,
  createdAt    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_equipment ON equipment_service_records(equipmentId, date);
CREATE INDEX IF NOT EXISTS idx_service_rig ON equipment_service_records(rigId, date);

-- Engineering health check-up narratives: a separate, distinct data model from
-- health_check_records above. Those are a simple per-machine Normal/Breakdown
-- reading; these carry prose problem/action/outcome history per engine or
-- transmission, either bulk-imported from the engineering log workbook (Engine
-- and Transmission sheets, plus a yard/central-store sheet) or logged one at a
-- time from a specific machine's own record.
--
-- A bulk-imported row is deliberately NOT linked to equipmentId: the workbook's
-- "Application" text (e.g. "Carrier engine (Spare)") does not reliably identify
-- one registered machine, and a wrong link here would misattribute one
-- machine's history to another (the same class of mistake documented as defect
-- D11 elsewhere in this schema). A row logged from a machine's own health
-- checkup button carries equipmentId, because there the machine is unambiguous
-- — the user opened that machine's own record to log it.
CREATE TABLE IF NOT EXISTS health_narrative_uploads (
  id              TEXT PRIMARY KEY,
  fileName        TEXT NOT NULL,
  storedFileName  TEXT,
  uploadDate      TEXT NOT NULL,
  uploadedBy      TEXT NOT NULL,
  recordsImported INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS health_narratives (
  id            TEXT PRIMARY KEY,
  uploadId      TEXT NOT NULL REFERENCES health_narrative_uploads(id) ON DELETE CASCADE,
  equipmentId   TEXT REFERENCES equipment(id) ON DELETE SET NULL,
  sourceSheet   TEXT NOT NULL,   -- the workbook sheet this row came from, or 'Manual Entry'
  category      TEXT NOT NULL,   -- Engine | Transmission | an equipment category, for manual entries
  rigId         TEXT REFERENCES rigs(id) ON DELETE SET NULL,
  rigText       TEXT,            -- the Rig cell exactly as written, kept even when unmatched
  place         TEXT,            -- yard / workshop / central store location (third sheet only);
                                  -- when set, this is the primary location and rigText is secondary
  application   TEXT,
  make          TEXT,
  details       TEXT,            -- raw model/serial block, as written
  serialNumber  TEXT,            -- best-effort extraction from details, for search only
  previousDate  TEXT,            -- parsed ISO date, when the cell parsed as one
  previousDateRaw TEXT,
  lastDate      TEXT,
  lastDateRaw   TEXT,
  problem       TEXT,
  action        TEXT,
  outcomeNotes  TEXT,            -- "Overhauling Details"/"Status" column, or Remarks on a manual entry
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_narrative_rig ON health_narratives(rigId);
CREATE INDEX IF NOT EXISTS idx_narrative_upload ON health_narratives(uploadId);
-- idx_narrative_equipment is created in db/index.ts's migration step, not here:
-- on a database created before the equipmentId column existed, an index on it
-- would fail before the migration has had a chance to ALTER TABLE it in.

-- Equipment transfers: a physical relocation of one machine, either to another
-- rig (updates equipment.rigId, the machine becomes that rig's asset going
-- forward) or to a yard/other location (updates equipment.currentPlace while
-- rigId keeps naming its home/owning rig). Every transfer is kept as history;
-- moving it again — including moving it "back" — is just another row here.
-- This is the single, centralized transfer mechanism for the whole app
-- (Admin > Master > Transfer Equipment) — there is no second transfer table
-- or duplicate business logic anywhere else.
CREATE TABLE IF NOT EXISTS equipment_transfers (
  id                 TEXT PRIMARY KEY,
  equipmentId        TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  fromRigId          TEXT REFERENCES rigs(id) ON DELETE SET NULL,
  fromPlace          TEXT,
  toRigId            TEXT REFERENCES rigs(id) ON DELETE SET NULL,
  toPlace            TEXT,
  destinationType    TEXT,            -- 'Rig' | 'Yard' | 'Other' — which picker the admin used; NULL on rows from before this column existed
  transferType       TEXT NOT NULL,   -- Permanent | Temporary
  expectedReturnDate TEXT,            -- only meaningful for a Temporary transfer
  date               TEXT NOT NULL,
  remarks            TEXT,
  createdBy          TEXT,
  createdAt          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_equipment ON equipment_transfers(equipmentId, date);

CREATE TABLE IF NOT EXISTS document_files (
  id             TEXT PRIMARY KEY,
  equipmentId    TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  docType        TEXT NOT NULL,
  title          TEXT NOT NULL,
  fileName       TEXT NOT NULL,
  storedFileName TEXT NOT NULL,
  uploadDate     TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  uploadedBy     TEXT
);
CREATE INDEX IF NOT EXISTS idx_docs_equipment ON document_files(equipmentId);

CREATE TABLE IF NOT EXISTS material_transfers (
  id             TEXT PRIMARY KEY,
  transferNumber TEXT NOT NULL,
  materialName   TEXT NOT NULL,
  quantity       INTEGER NOT NULL DEFAULT 1,
  unit           TEXT,
  source         TEXT,
  destination    TEXT,
  transferType   TEXT,
  status         TEXT NOT NULL DEFAULT 'Pending',
  date           TEXT NOT NULL,
  remarks        TEXT,
  createdBy      TEXT,
  approvedBy     TEXT,
  approvedAt     TEXT
);

CREATE TABLE IF NOT EXISTS rig_holidays (
  id          TEXT PRIMARY KEY,
  rigId       TEXT NOT NULL,             -- a rig id, or the literal all
  date        TEXT NOT NULL,
  type        TEXT,
  description TEXT,
  createdAt   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_holiday_unique ON rig_holidays(rigId, date);

CREATE TABLE IF NOT EXISTS audit_logs (
  id       TEXT PRIMARY KEY,
  user     TEXT,
  time     TEXT NOT NULL,
  ip       TEXT,
  action   TEXT NOT NULL,
  entity   TEXT,
  entityId TEXT,
  field    TEXT,
  oldValue TEXT,
  newValue TEXT,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs(time);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user);

-- Module -> Department -> User -> (future) rig-wise rights. Every department
-- belongs to exactly one module; the same name may exist under two different
-- modules (they're genuinely different departments) but not twice within the
-- same module — enforced via the (moduleCode, nameKey) unique index below.
CREATE TABLE IF NOT EXISTS departments (
  id         TEXT PRIMARY KEY,
  moduleCode TEXT NOT NULL,              -- 'PMS' | 'DPR' | 'ILM' (MODULE_CODES), validated in code
  name       TEXT NOT NULL,
  nameKey    TEXT NOT NULL,              -- normalised name, scoped to moduleCode
  status     TEXT NOT NULL DEFAULT 'Active',
  createdAt  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dept_module_namekey ON departments(moduleCode, nameKey);

-- Admin > Master > Oil & Lubricant Master: a simple named reference list
-- (e.g. "Engine Oil 15W40"), shared by every module the same way rigs and
-- equipment are.
CREATE TABLE IF NOT EXISTS oil_lubricants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  nameKey       TEXT NOT NULL UNIQUE,        -- normalised name
  equipmentName TEXT,                        -- optional: which equipment this lubricant applies to (free text, matches equipment.name across rigs — not a FK, since one lubricant type applies to a named class of machine, not one physical unit)
  status        TEXT NOT NULL DEFAULT 'Active',
  createdAt     TEXT NOT NULL
);

-- The actual Rig -> Equipment -> Oil/Lubricant assignment: which specific
-- oils/lubricants from the global oil_lubricants list are in use on a given
-- physical equipment row. Distinct from oil_lubricants.equipmentName (free
-- text, one value) and from drr_oil_lines (day-to-day consumption entries) --
-- this is the reusable reference relationship the rest of the app reads.
CREATE TABLE IF NOT EXISTS equipment_oil_lubricants (
  id             TEXT PRIMARY KEY,
  equipmentId    TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  oilLubricantId TEXT NOT NULL REFERENCES oil_lubricants(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'Active',
  createdBy      TEXT NOT NULL,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_oil_unique ON equipment_oil_lubricants(equipmentId, oilLubricantId);
CREATE INDEX IF NOT EXISTS idx_equipment_oil_equipment ON equipment_oil_lubricants(equipmentId);

-- Admin > Master > Equipment Master > Import Correct Master Data — one row
-- per workbook import run, so the admin screen can show a history of what
-- was replaced/added and when, without needing to dig through the audit log.
CREATE TABLE IF NOT EXISTS equipment_master_imports (
  id                    TEXT PRIMARY KEY,
  fileName              TEXT NOT NULL,
  importedBy            TEXT NOT NULL,
  importedAt            TEXT NOT NULL,
  rigsMatched           INTEGER NOT NULL,
  rigsUnmatched         INTEGER NOT NULL,
  equipmentCreated      INTEGER NOT NULL,
  equipmentUpdated      INTEGER NOT NULL,
  equipmentDeactivated  INTEGER NOT NULL,
  oilLubricantsCreated  INTEGER NOT NULL,
  unmatchedRigNames     TEXT NOT NULL DEFAULT '[]',  -- JSON array of rig names in the workbook that matched nothing in Rig Master
  -- The same run also rebuilds the two global catalogs this workbook is the
  -- source for: Material Master (Engine/Transmission) and Oil & Lubricant
  -- Master. Unlike equipment, records those two hold that the workbook does
  -- not contain are DELETED (they carry no historical references — see
  -- services/rigMasterDataImport.ts), which is what these counters record.
  oilLubricantsRemoved  INTEGER NOT NULL DEFAULT 0,
  oilMappingsRemoved    INTEGER NOT NULL DEFAULT 0,
  materialsCreated      INTEGER NOT NULL DEFAULT 0,
  materialsUpdated      INTEGER NOT NULL DEFAULT 0,
  materialsRemoved      INTEGER NOT NULL DEFAULT 0,
  materialsRelinked     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  role         TEXT NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT,
  rigId        TEXT REFERENCES rigs(id) ON DELETE SET NULL,
  departmentId TEXT REFERENCES departments(id) ON DELETE RESTRICT,
  status       TEXT NOT NULL DEFAULT 'Active',
  rights       TEXT NOT NULL,            -- JSON object of permission flags
  createdAt    TEXT NOT NULL
);

-- Multi-rig assignment: which rigs a user's account is scoped to across the
-- WHOLE app (PMS/DPR/ILM visibility via middleware/auth.ts's rigScope(), AND
-- — for Storekeeper/Operational Manager — DRR approval routing via
-- services/drrResponsibility.ts, kept in sync from this same table). Set from
-- Admin > Users > Add/Edit User's "Assigned Rigs" checkboxes. Generalizes the
-- legacy single users.rigId column (kept, and still used as a fallback for
-- an account with no rows here — never removed, so nothing that predates
-- this table changes behavior). One user can be assigned many rigs; one rig
-- can be assigned to many users — never a single global scope.
CREATE TABLE IF NOT EXISTS user_rig_access (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rigId     TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_rig_access_unique ON user_rig_access(userId, rigId);
CREATE INDEX IF NOT EXISTS idx_user_rig_access_user ON user_rig_access(userId);
CREATE INDEX IF NOT EXISTS idx_user_rig_access_rig ON user_rig_access(rigId);

CREATE TABLE IF NOT EXISTS login_history (
  id        TEXT PRIMARY KEY,
  userId    TEXT,
  username  TEXT NOT NULL,
  time      TEXT NOT NULL,
  ip        TEXT,
  success   INTEGER NOT NULL,
  userAgent TEXT,
  reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_user ON login_history(username, time);

-- The three application modules sharing this login (spec: GTC Oilfield shell).
-- users.moduleAccess (added by a migration below, since this table predates it)
-- holds the actual per-user access; this table is just the admin-manageable list.
CREATE TABLE IF NOT EXISTS modules (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,     -- 'PMS' | 'DPR' | 'ILM'
  name        TEXT NOT NULL,
  description TEXT,
  isActive    INTEGER NOT NULL DEFAULT 1,
  createdAt   TEXT NOT NULL
);

-- General-purpose notification store. Rows created by the machine service-due
-- check (ingest.ts) carry no userId and are keyed by date/type/equipmentId as
-- before. Rows created by the scheduled per-user checks (services/notifications.ts)
-- carry userId, title, referenceDate and a dedupeKey that a unique index enforces,
-- so the same requirement can never generate two notifications for one user.
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  message       TEXT NOT NULL,
  equipmentId   TEXT REFERENCES equipment(id) ON DELETE CASCADE,
  rigId         TEXT REFERENCES rigs(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  isRead        INTEGER NOT NULL DEFAULT 0,
  severity      TEXT NOT NULL DEFAULT 'info',
  userId        TEXT,            -- who this notification is for; NULL for the legacy rig-wide rows
  title         TEXT,            -- short heading shown in the notification bell
  referenceDate TEXT,            -- the business date the notification is about
  dedupeKey     TEXT,            -- unique per (type, user, requirement); enforces idempotent generation
  createdAt     TEXT,            -- when the notification was generated
  readAt        TEXT,
  resolvedAt    TEXT             -- set once the underlying requirement is satisfied; history is kept, not deleted
);
-- The dedupeKey/userId indexes are created in db/index.ts's migration step, not
-- here: on a database created before these columns existed, an index on them
-- would fail before the migration has had a chance to ALTER TABLE them in.

-- Admin > Notification Settings — one row per notification type, so every
-- type's enabled flag, thresholds, escalation time, reminder frequency and
-- delivery channels (in-app/email) are independently configurable rather than
-- hardcoded. services/notifications.ts reads this at generation time; a type
-- with no row here (a brand-new one just shipped) falls back to its
-- NOTIFICATION_DEFAULTS entry, so nothing needs a settings row to work.
CREATE TABLE IF NOT EXISTS notification_settings (
  type              TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 1,
  warningThreshold  REAL,     -- meaning depends on type: hours for Service Due, days for Health Check Due
  criticalThreshold REAL,     -- hours/days remaining at which it becomes Overdue/critical (normally 0)
  escalationHours   REAL,     -- how long an unresolved item waits before escalating to Admin
  reminderHours     REAL,     -- minimum gap before a resolved-then-recurring condition can notify again
  inApp             INTEGER NOT NULL DEFAULT 1,
  email             INTEGER NOT NULL DEFAULT 0,
  updatedBy         TEXT,
  updatedAt         TEXT
);

-- Admin > SMTP Configuration — single row (id is always 'default'), the mail
-- provider every outbound email in the app (starting with
-- notification_settings' email channel above, via services/mailer.ts) sends
-- through. `enabled` gates real delivery off even when a host/credentials are
-- saved, so an Admin can configure and test before going live.
CREATE TABLE IF NOT EXISTS smtp_settings (
  id        TEXT PRIMARY KEY DEFAULT 'default',
  enabled   INTEGER NOT NULL DEFAULT 0,
  host      TEXT,
  port      INTEGER,
  secure    INTEGER NOT NULL DEFAULT 0,  -- true = implicit TLS (port 465); false = STARTTLS/plain (587/25)
  username  TEXT,
  password  TEXT,
  fromEmail TEXT,
  fromName  TEXT,
  updatedBy TEXT,
  updatedAt TEXT
);

/* ------------------------------------------------------------------ */
/* DPR (Daily Progress Report) module                                  */
/* ------------------------------------------------------------------ */

-- One row per Excel upload attempt, whether it fully succeeded or not — the
-- Import Center's history and the audit trail for what actually landed.
CREATE TABLE IF NOT EXISTS dpr_import_batches (
  id             TEXT PRIMARY KEY,
  fileName       TEXT NOT NULL,
  storedFileName TEXT,
  rigId          TEXT NOT NULL REFERENCES dpr_rigs(id) ON DELETE RESTRICT,
  uploadedBy     TEXT NOT NULL,
  uploadedAt     TEXT NOT NULL,
  status         TEXT NOT NULL,             -- Successful | PartiallyFailed | Failed
  recordCount    INTEGER NOT NULL DEFAULT 0,
  errorCount     INTEGER NOT NULL DEFAULT 0,
  errorDetail    TEXT                       -- JSON [{row, message}] when status != Successful
);
CREATE INDEX IF NOT EXISTS idx_dpr_batch_rig ON dpr_import_batches(rigId);

-- One row per rig+date report, regardless of whether it came from Excel or
-- was typed in manually — the single source Progress Report and the
-- Dashboard both read from (spec: excel and manual entry share one model).
-- rigId references DPR's own independent Rig Master (dpr_rigs), not PMS's.
CREATE TABLE IF NOT EXISTS dpr_reports (
  id            TEXT PRIMARY KEY,
  rigId         TEXT NOT NULL REFERENCES dpr_rigs(id) ON DELETE RESTRICT,
  dprDate       TEXT NOT NULL,
  source        TEXT NOT NULL,              -- 'excel' | 'manual'
  importBatchId TEXT REFERENCES dpr_import_batches(id) ON DELETE SET NULL,
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  updatedBy     TEXT,
  updatedAt     TEXT NOT NULL
);
-- One report per rig per day; a second upload/entry for the same rig+date is
-- a replace, never a silent duplicate (spec 15).
CREATE UNIQUE INDEX IF NOT EXISTS idx_dpr_report_rig_date ON dpr_reports(rigId, dprDate);

-- One row per activity line within a report — the DPR sheet's rows 4-19.
CREATE TABLE IF NOT EXISTS dpr_line_items (
  id                 TEXT PRIMARY KEY,
  reportId           TEXT NOT NULL REFERENCES dpr_reports(id) ON DELETE CASCADE,
  lineNo             INTEGER NOT NULL,
  wellName           TEXT,
  operationCode      TEXT,
  workType           TEXT,
  startTime          TEXT,                  -- "HH:MM", 24h
  endTime            TEXT,
  totalHours         REAL,                  -- always recomputed server-side, never trusted from Excel
  description        TEXT,
  breakdownEquipment TEXT,
  breakdownEquipmentId TEXT REFERENCES equipment(id) ON DELETE SET NULL,  -- traceability only; breakdownEquipment stays the historical label as recorded, never rewritten if the machine is later renamed
  breakdownReason    TEXT,               -- manual entry only; not present in the Excel template's fixed columns
  drillingSection    TEXT,
  drillingFrom       REAL,
  drillingTo         REAL,
  drillingTotal      REAL,                  -- recomputed: drillingTo - drillingFrom
  casingSection      TEXT,
  casingFrom         REAL,
  casingTo           REAL,
  casingTotal        REAL,                  -- recomputed: casingTo - casingFrom
  otherActivityDescription TEXT             -- free text, only meaningful when operationCode = '23 - Other'; word-capped (35) client-side
);
CREATE INDEX IF NOT EXISTS idx_dpr_line_report ON dpr_line_items(reportId);

/* ------------------------------------------------------------------ */
/* HSD (diesel consumption) — a second import stream inside the DPR    */
/* module. Structurally parallel to the DPR tables above (batch ->     */
/* report -> lines, one report per rig per day) and keyed to the same  */
/* dpr_rigs master, but kept in its own tables: an HSD day sheet is a  */
/* different document from a DPR day sheet and the two are uploaded    */
/* independently.                                                       */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS hsd_import_batches (
  id             TEXT PRIMARY KEY,
  fileName       TEXT NOT NULL,
  storedFileName TEXT,
  rigId          TEXT NOT NULL REFERENCES dpr_rigs(id) ON DELETE RESTRICT,
  uploadedBy     TEXT NOT NULL,
  uploadedAt     TEXT NOT NULL,
  status         TEXT NOT NULL,             -- Successful | Failed
  recordCount    INTEGER NOT NULL DEFAULT 0,
  errorCount     INTEGER NOT NULL DEFAULT 0,
  errorDetail    TEXT                       -- JSON [{day, row, message}] when status != Successful
);
CREATE INDEX IF NOT EXISTS idx_hsd_batch_rig ON hsd_import_batches(rigId);

-- One row per rig+date HSD day sheet: the sheet's own header block.
CREATE TABLE IF NOT EXISTS hsd_reports (
  id            TEXT PRIMARY KEY,
  rigId         TEXT NOT NULL REFERENCES dpr_rigs(id) ON DELETE RESTRICT,
  hsdDate       TEXT NOT NULL,
  wellName      TEXT,
  r1Hours       REAL,
  r2Hours       REAL,
  r3Hours       REAL,
  ilmHours      REAL,
  totalHours    REAL,                        -- recomputed: R1+R2+R3+ILM, never trusted from the sheet
  importBatchId TEXT REFERENCES hsd_import_batches(id) ON DELETE SET NULL,
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  updatedBy     TEXT,
  updatedAt     TEXT NOT NULL
);
-- One HSD report per rig per day; re-uploading the same day replaces it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hsd_report_rig_date ON hsd_reports(rigId, hsdDate);

-- The per-equipment diesel table — the day sheet's rows 6-26.
CREATE TABLE IF NOT EXISTS hsd_equipment_lines (
  id                  TEXT PRIMARY KEY,
  reportId            TEXT NOT NULL REFERENCES hsd_reports(id) ON DELETE CASCADE,
  lineNo              INTEGER NOT NULL,
  equipment           TEXT,
  equipmentId         TEXT REFERENCES equipment(id) ON DELETE SET NULL,  -- traceability only; `equipment` stays the historical label as recorded
  openingStock        REAL,
  topUp               REAL,
  totalHsd            REAL,                  -- recomputed: opening + top-up (sheet formula D=B+C)
  consumedHsd         REAL,
  consumedHours       REAL,
  openingRunningHours REAL,
  closingHours        REAL,                  -- recomputed: openingRunning + consumedHours (H=SUM(G,F))
  closingStock        REAL,                  -- recomputed: totalHsd - consumedHsd (I=D-E)
  average             REAL,                  -- recomputed: consumedHsd / consumedHours (J=IFERROR(E/F,""))
  remark              TEXT
);
CREATE INDEX IF NOT EXISTS idx_hsd_equip_report ON hsd_equipment_lines(reportId);

-- The rig-site diesel / drinking-water block — the day sheet's rows 30-31.
CREATE TABLE IF NOT EXISTS hsd_site_lines (
  id               TEXT PRIMARY KEY,
  reportId         TEXT NOT NULL REFERENCES hsd_reports(id) ON DELETE CASCADE,
  lineNo           INTEGER NOT NULL,
  label            TEXT,                     -- 'Rig Site Diesel' | 'Rig Site -D.Water'
  openingBalance   REAL,
  received         REAL,
  totalBalance     REAL,                     -- recomputed: opening + received (D=SUM(B:C))
  topUp            REAL,
  totalConsumption REAL,
  closingBalance   REAL,                     -- recomputed: totalBalance - topUp (G=D-E)
  remark           TEXT
);
CREATE INDEX IF NOT EXISTS idx_hsd_site_report ON hsd_site_lines(reportId);

/* ------------------------------------------------------------------ */
/* Daily Rig Report (DRR) — one unified daily entry point that writes  */
/* into DPR (dpr_reports), Mechanical Log (mechanical_log_rows) and    */
/* HSD (hsd_reports) in one save. rigId points at the PMS rig master   */
/* (rigs), since that is the only one with equipment attached; the     */
/* matching dpr_rigs row is resolved by rigNumber at save time rather  */
/* than stored redundantly here. Lubricating oil and hydraulic oil are */
/* genuinely new concepts (no prior table tracks a running balance for */
/* either), so they get their own tables; equipment running hours do   */
/* not — those are written straight into mechanical_log_rows.          */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS drr_reports (
  id            TEXT PRIMARY KEY,
  rigId         TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  reportDate    TEXT NOT NULL,
  wellNo        TEXT,
  shift         TEXT NOT NULL,              -- Day | Night | 24 Hour (free-ish, validated against a small fixed list)
  fieldLocation TEXT,
  -- Draft | PendingApproval | Submitted | Rejected. 'Submitted' is the one
  -- terminal, distributed state (see saveReport()) — reached either directly
  -- (Excel import, demo seed: unchanged) or, for the interactive form, only
  -- via an Operational Manager's Approve action on a PendingApproval report.
  -- This is deliberately the SAME status value the app already treated as
  -- final everywhere (carry-forward, previous-report lookups), so approval
  -- adds a gate in front of it without touching what "Submitted" means.
  status        TEXT NOT NULL DEFAULT 'Draft',
  dprReportId   TEXT REFERENCES dpr_reports(id) ON DELETE SET NULL,
  hsdReportId   TEXT REFERENCES hsd_reports(id) ON DELETE SET NULL,
  mechLogUploadId TEXT REFERENCES mechanical_log_uploads(id) ON DELETE SET NULL,
  -- Approval history/trail (also mirrored, one row per event, in
  -- drr_approval_history below — these columns are just "current state" for
  -- fast reads; the history table is the full audit trail).
  submittedAt    TEXT,   -- last time this report was moved to PendingApproval
  approvedBy     TEXT,
  approvedAt     TEXT,
  rejectedBy     TEXT,
  rejectedAt     TEXT,
  rejectionReason TEXT,  -- required whenever rejectedBy/rejectedAt are set
  -- While status = 'Draft', the whole form payload is snapshotted here (JSON)
  -- instead of being distributed into dpr_reports/hsd_reports/
  -- mechanical_log_rows/drr_oil_lines/drr_hydraulic_lines — so a draft can be
  -- resumed with everything the user typed, without those other tables (or
  -- next-day carry-forward, which reads them) ever seeing unsubmitted data.
  -- Submitting clears it back to NULL once the real tables hold the data.
  draftPayload  TEXT,
  submittedBy   TEXT NOT NULL,
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  updatedBy     TEXT,
  updatedAt     TEXT NOT NULL
);
-- One report per rig+date+shift; re-saving the same id (edit) is allowed,
-- a second *new* report for the same slot is not (spec 17: duplicate guard).
CREATE UNIQUE INDEX IF NOT EXISTS idx_drr_report_rig_date_shift ON drr_reports(rigId, reportDate, shift);
CREATE INDEX IF NOT EXISTS idx_drr_report_rig ON drr_reports(rigId);

-- Admin > DRR > Rig Responsibility: which Storekeeper(s) and Operational
-- Manager(s) are assigned to each rig. A many-to-many mapping — one person
-- can be responsible for several rigs, and one rig gets a Primary + Backup
-- for each of the two roles (never a single global manager). Approval
-- routing (services/drrResponsibility.ts) reads this live: a DRR's rig
-- decides who may approve/reject it, not any fixed assignment on the report.
CREATE TABLE IF NOT EXISTS drr_rig_responsibility (
  id        TEXT PRIMARY KEY,
  rigId     TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
  roleType  TEXT NOT NULL,               -- 'Storekeeper' | 'OperationalManager'
  tier      TEXT NOT NULL DEFAULT 'Primary', -- 'Primary' | 'Backup'
  userId    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status    TEXT NOT NULL DEFAULT 'Active',
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
-- Exactly one row per rig+role+tier slot (e.g. one "Primary Storekeeper" for
-- Rig 50-01) — reassigning replaces it rather than accumulating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drr_rig_resp_slot ON drr_rig_responsibility(rigId, roleType, tier);
CREATE INDEX IF NOT EXISTS idx_drr_rig_resp_user ON drr_rig_responsibility(userId);

-- Full approval audit trail — one row per Submit/Approve/Reject event, so a
-- report's history survives even across several reject/resubmit cycles
-- (drr_reports' own submittedAt/approvedBy/... columns only hold the latest).
CREATE TABLE IF NOT EXISTS drr_approval_history (
  id       TEXT PRIMARY KEY,
  reportId TEXT NOT NULL REFERENCES drr_reports(id) ON DELETE CASCADE,
  action   TEXT NOT NULL,   -- 'Submitted' | 'Approved' | 'Rejected'
  byUser   TEXT NOT NULL,
  atTime   TEXT NOT NULL,
  reason   TEXT             -- set only for 'Rejected'
);
CREATE INDEX IF NOT EXISTS idx_drr_approval_history_report ON drr_approval_history(reportId);

-- Admin-only Excel Import for DRR: a bulk alternative to the manual form that
-- writes through the exact same saveReport() path (routes/dailyRigReport.ts)
-- -- this table only records the upload attempt itself, mirroring
-- ilm_import_batches's shape (see its comment for why status/errorDetail are
-- kept even on failure).
CREATE TABLE IF NOT EXISTS drr_import_batches (
  id              TEXT PRIMARY KEY,
  fileName        TEXT NOT NULL,
  storedFileName  TEXT,
  rigId           TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  reportDate      TEXT,
  uploadedBy      TEXT NOT NULL,
  uploadedAt      TEXT NOT NULL,
  status          TEXT NOT NULL,             -- Successful | Failed
  templateVersion TEXT,
  recordCount     INTEGER NOT NULL DEFAULT 0,
  errorCount      INTEGER NOT NULL DEFAULT 0,
  errorDetail     TEXT                       -- JSON [{level,row,sheet,message}]
);
CREATE INDEX IF NOT EXISTS idx_drr_import_batch_rig ON drr_import_batches(rigId);

-- Manpower Roster / Site Attendance. Three tables: a global Employee master
-- (same tier as Oil & Lubricant Master's global list), a per-rig rotation
-- assignment (Employee -> Rig, ON/OFF cycle, effective range), and the
-- per-DRR-report attendance record itself. Attendance rows are a frozen
-- snapshot (name/designation/rosterStatus captured at save time) -- they
-- never live-join back to employees/manpower_roster, so editing or
-- reassigning an employee's roster later never changes a past report's
-- attendance (spec: history must never change under a roster edit).
CREATE TABLE IF NOT EXISTS employees (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  employeeCode       TEXT,
  defaultDesignation TEXT,
  status             TEXT NOT NULL DEFAULT 'Active',
  createdBy          TEXT NOT NULL,
  createdAt          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manpower_roster (
  id                TEXT PRIMARY KEY,
  employeeId        TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  rigId             TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  designation       TEXT NOT NULL,
  rotationType      TEXT NOT NULL,             -- '4 ON / 6 OFF' | '6 ON / 4 OFF' | 'Custom' -- a label; onDays/offDays are the real source of truth
  onDays            INTEGER NOT NULL,
  offDays           INTEGER NOT NULL,
  rotationStartDate TEXT NOT NULL,             -- anchor date the ON/OFF cycle is counted from
  shift             TEXT NOT NULL,             -- Day | Night | 24 Hour, same vocabulary as drr_reports.shift
  effectiveFrom     TEXT NOT NULL,
  effectiveTo       TEXT,                      -- NULL = still ongoing
  status            TEXT NOT NULL DEFAULT 'Active',
  createdBy         TEXT NOT NULL,
  createdAt         TEXT NOT NULL,
  updatedBy         TEXT,
  updatedAt         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roster_rig ON manpower_roster(rigId);
CREATE INDEX IF NOT EXISTS idx_roster_employee ON manpower_roster(employeeId);

CREATE TABLE IF NOT EXISTS drr_attendance_lines (
  id               TEXT PRIMARY KEY,
  reportId         TEXT NOT NULL REFERENCES drr_reports(id) ON DELETE CASCADE,
  employeeId       TEXT REFERENCES employees(id) ON DELETE SET NULL,  -- NULL for a temporary/ad-hoc "+ Add Employee" entry
  employeeName     TEXT NOT NULL,              -- frozen snapshot
  employeeCode     TEXT,                       -- frozen snapshot, from Employee Master
  designation      TEXT,                       -- frozen snapshot
  rosterStatus     TEXT,                       -- 'ON' | 'OFF' | NULL -- reference only, computed at save time; never gates attendanceStatus
  attendanceStatus TEXT NOT NULL,              -- Present | Absent | Leave -- the ACTUAL recorded attendance, entered by the Rig User
  shift            TEXT,                       -- the shift this person actually worked, independent of the report's own shift
  inTime           TEXT,                       -- free-text/HH:MM, optional
  outTime          TEXT,                       -- free-text/HH:MM, optional
  isTemporary      INTEGER NOT NULL DEFAULT 0,
  remarks          TEXT
);
CREATE INDEX IF NOT EXISTS idx_drr_attendance_report ON drr_attendance_lines(reportId);

-- Lubricating oil balance per equipment+oilType per report. Genuinely new:
-- mechanical_log_rows.lubeOilAdded is a bare per-day number with no
-- opening/closing balance or carry-forward concept, and one equipment can
-- have zero or several applicable oil types (grain mismatch either way).
CREATE TABLE IF NOT EXISTS drr_oil_lines (
  id             TEXT PRIMARY KEY,
  reportId       TEXT NOT NULL REFERENCES drr_reports(id) ON DELETE CASCADE,
  equipmentId    TEXT REFERENCES equipment(id) ON DELETE SET NULL,
  oilType        TEXT NOT NULL,
  openingBalance REAL,
  oilAdded       REAL,
  oilConsumed    REAL,
  closingBalance REAL,                      -- recomputed: opening + added - consumed
  remark         TEXT
);
CREATE INDEX IF NOT EXISTS idx_drr_oil_report ON drr_oil_lines(reportId);

-- Hydraulic tank levels per report — zero prior representation anywhere in
-- this schema (the HSD workbook's own Hydraulic Oil sheet is a pure rollup
-- the HSD importer already ignores).
CREATE TABLE IF NOT EXISTS drr_hydraulic_lines (
  id            TEXT PRIMARY KEY,
  reportId      TEXT NOT NULL REFERENCES drr_reports(id) ON DELETE CASCADE,
  tankName      TEXT NOT NULL,               -- 'Rig Carrier Hydraulic Tank' | 'Accumulator Tank'
  openingLevel  REAL,
  topUp         REAL,
  loss          REAL,
  closingLevel  REAL,                        -- recomputed: opening + topUp - loss
  remark        TEXT
);
CREATE INDEX IF NOT EXISTS idx_drr_hydraulic_report ON drr_hydraulic_lines(reportId);

/* ------------------------------------------------------------------ */
/* ILM (Inter Location Movement) module                                */
/* ------------------------------------------------------------------ */

-- One row per Excel upload attempt, whether it fully succeeded or not.
CREATE TABLE IF NOT EXISTS ilm_import_batches (
  id              TEXT PRIMARY KEY,
  fileName        TEXT NOT NULL,
  storedFileName  TEXT,
  rigId           TEXT NOT NULL REFERENCES ilm_rigs(id) ON DELETE RESTRICT,
  uploadedBy      TEXT NOT NULL,
  uploadedAt      TEXT NOT NULL,
  status          TEXT NOT NULL,             -- Successful | PartiallyFailed | Failed
  templateVersion TEXT,
  recordCount     INTEGER NOT NULL DEFAULT 0,
  errorCount      INTEGER NOT NULL DEFAULT 0,
  errorDetail     TEXT                       -- JSON [{level,row,sheet,message}]
);
CREATE INDEX IF NOT EXISTS idx_ilm_batch_rig ON ilm_import_batches(rigId);

-- One row per ILM (a rig relocation project), whether created by Excel
-- import or typed in manually — the same unified record the Dashboard and
-- Progress Report read from. ilmNumber is a human-readable sequence
-- (ILM-2026-00001). An ILM is a long-lived parent: it starts Active and can
-- accumulate many Trailer Movements/Crane Rounds/Delay lines over weeks or
-- months before someone ends it — "date" is the ILM's start date, not "the"
-- movement date.
CREATE TABLE IF NOT EXISTS ilm_transactions (
  id            TEXT PRIMARY KEY,
  ilmNumber     TEXT NOT NULL UNIQUE,
  rigId         TEXT NOT NULL REFERENCES ilm_rigs(id) ON DELETE RESTRICT,
  date          TEXT NOT NULL,
  source        TEXT NOT NULL,              -- 'excel' | 'manual'
  status        TEXT NOT NULL DEFAULT 'Active', -- 'Active' | 'Completed'
  importBatchId TEXT REFERENCES ilm_import_batches(id) ON DELETE SET NULL,
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  updatedBy     TEXT,
  updatedAt     TEXT NOT NULL,
  endDate       TEXT,                       -- set by "End ILM"
  endTime       TEXT,
  completedBy   TEXT,
  completedAt   TEXT,
  durationHours REAL                        -- createdAt -> completedAt, computed once at end
);
-- Only one Active ILM per rig at a time (a rig can have many ILMs over its
-- life, historically, just not two running at once).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ilm_txn_active_rig ON ilm_transactions(rigId) WHERE status = 'Active';

-- 2_ILM_Individual header block: Date/Rig live on ilm_transactions itself,
-- everything else that's one-value-per-movement lives here (1:1).
CREATE TABLE IF NOT EXISTS ilm_individual (
  transactionId    TEXT PRIMARY KEY REFERENCES ilm_transactions(id) ON DELETE CASCADE,
  area             TEXT,
  operatorName     TEXT,
  wellNo           TEXT,
  movementFromWell TEXT,
  movementToWell   TEXT,
  releaseDate      TEXT,
  releaseTime      TEXT,
  spudDate         TEXT,
  spudTime         TEXT,
  ilmRatePerDay    REAL,             -- entered per-movement (Summary Dashboard's "ILM Time & Costs")
  ilmExpenses      REAL,             -- entered per-movement; null until someone fills it in, never fabricated
  contractDateFrom TEXT,             -- shown once Release Date & Time are entered; Total Contract Days is derived, never stored
  contractDateTo   TEXT,
  -- ILM Contract Duration Rules preview at the header level (Admin > Master >
  -- ILM Contract Duration Rules): movementDistanceKm is a header-level input,
  -- separate from any Trailer Movement round's own leadDistanceKm.
  -- contractAllowedHours/contractAllowedDays/contractRuleId are resolved and
  -- FROZEN every time the header is saved with a distance present (createIlm/
  -- updateIlmHeader) — never recomputed just because a rule changes later;
  -- only an explicit re-save of this header recalculates them, same freeze
  -- discipline as ilm_trailer_movements.
  movementDistanceKm    REAL,
  contractAllowedHours  REAL,
  contractAllowedDays   REAL,
  contractRuleId        TEXT REFERENCES ilm_contract_duration_rules(id) ON DELETE SET NULL
);

-- 2_ILM_Individual's repeating delay/fuel table (rows 13+) — one movement can
-- log multiple delay/fuel events.
CREATE TABLE IF NOT EXISTS ilm_individual_lines (
  id                   TEXT PRIMARY KEY,
  transactionId        TEXT NOT NULL REFERENCES ilm_transactions(id) ON DELETE CASCADE,
  lineNo               INTEGER NOT NULL,
  reasonForDelay       TEXT,
  totalDelayHours      REAL,
  hsdStockAccession    REAL,
  receivedQtyDuringIlm REAL,
  hsdStockShiftEnd     REAL,
  totalHsdConsumption  REAL,                 -- recomputed: accession + received - shiftEnd
  ilmDistanceKm        REAL,
  totalLoadsMoved      REAL,
  cumulativeTrailerKm  REAL,
  avgConsumptionPerKm  REAL                  -- recomputed: totalHsdConsumption / ilmDistanceKm
);
CREATE INDEX IF NOT EXISTS idx_ilm_ind_line_txn ON ilm_individual_lines(transactionId);

-- One row per automatic Delay popup submission (shown when the user saves
-- an ILM that has run past its Contract Date To while still Active). Kept
-- as its own table, separate from ilm_individual_lines' Reason for
-- Delay/Delay Hours columns (which those two columns predate and are no
-- longer written to by the UI) so Fuel Log and Delay stay genuinely
-- separate concepts, never overwriting one another.
CREATE TABLE IF NOT EXISTS ilm_delay_records (
  id             TEXT PRIMARY KEY,
  transactionId  TEXT NOT NULL REFERENCES ilm_transactions(id) ON DELETE CASCADE,
  reasonForDelay TEXT NOT NULL,
  otherReason    TEXT,             -- free text when reasonForDelay = 'Others'
  delayHours     REAL,             -- auto-calculated: hours between Contract Date To and the moment of saving
  remarks        TEXT,
  createdBy      TEXT NOT NULL,
  createdAt      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ilm_delay_txn ON ilm_delay_records(transactionId);

-- ILM Contract Duration Rules (Admin > Master > ILM Contract Duration Rules):
-- per-ILM-rig, distance-banded allowed-hours rules. Every rig configures its
-- own bands independently — nothing here is shared or hardcoded across rigs
-- (e.g. 36 hours / 1.5 hrs-per-km are Admin-entered values, never literals in
-- code). A Trailer Movement resolves the matching Active band for its rig at
-- creation time (see services/ilmContractDuration.ts) and freezes the result
-- onto ilm_trailer_movements.allowedDurationHrs/contractDays/contractRuleId —
-- editing or deactivating a rule here never recalculates an already-created
-- movement, mirroring the same freeze discipline as manpower_roster.
CREATE TABLE IF NOT EXISTS ilm_contract_duration_rules (
  id              TEXT PRIMARY KEY,
  ilmRigId        TEXT NOT NULL REFERENCES ilm_rigs(id) ON DELETE CASCADE,
  fromDistanceKm  REAL NOT NULL,
  toDistanceKm    REAL,                       -- NULL = open-ended ("above X KM")
  baseHours       REAL NOT NULL,
  extraHoursPerKm REAL NOT NULL DEFAULT 0,
  roundPerKm      INTEGER NOT NULL DEFAULT 1, -- "per KM or part thereof": round the extra distance up to the next whole KM
  status          TEXT NOT NULL DEFAULT 'Active',
  createdBy       TEXT NOT NULL,
  createdAt       TEXT NOT NULL,
  updatedBy       TEXT,
  updatedAt       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ilm_contract_rules_rig ON ilm_contract_duration_rules(ilmRigId);

-- 4_ILM_Trailer_Load_Detail header block. Kept in place for old rows but no
-- longer written to — superseded by ilm_trailer_movements, which is the same
-- shape made 1:many (one ILM now has many Trailer Movement rounds, not one).
CREATE TABLE IF NOT EXISTS ilm_trailer_header (
  transactionId      TEXT PRIMARY KEY REFERENCES ilm_transactions(id) ON DELETE CASCADE,
  rigName            TEXT,
  oldLocation        TEXT,
  newLocation        TEXT,
  leadDistanceKm     REAL,
  rigReleaseAt       TEXT,
  fleetReportAt      TEXT,
  allowedDurationHrs REAL
);

-- One row per Trailer Movement round under an ILM. oldLocation/newLocation/
-- rigReleaseAt are a SNAPSHOT taken from ilm_individual at the moment the
-- round is created (spec: "Movement From/To Well" and "Release Date/Time"
-- auto-map in, then freeze) — editing the ILM header later never changes an
-- already-created round's snapshot.
CREATE TABLE IF NOT EXISTS ilm_trailer_movements (
  id                 TEXT PRIMARY KEY,
  transactionId      TEXT NOT NULL REFERENCES ilm_transactions(id) ON DELETE CASCADE,
  movementNo         INTEGER NOT NULL,
  rigName            TEXT,
  oldLocation        TEXT,
  newLocation        TEXT,
  leadDistanceKm     REAL,
  rigReleaseAt       TEXT,
  fleetReportAt      TEXT,
  allowedDurationHrs REAL,
  -- Frozen at creation from the rig's matching ilm_contract_duration_rules
  -- band (or left NULL/manually entered if no rule matched) — never
  -- recomputed later. contractRuleId is informational provenance only, kept
  -- even if that rule is later edited/deactivated/deleted (ON DELETE SET NULL).
  contractDays       REAL,
  contractRuleId     TEXT REFERENCES ilm_contract_duration_rules(id) ON DELETE SET NULL,
  createdBy          TEXT NOT NULL,
  createdAt          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ilm_trailer_mvmt_txn ON ilm_trailer_movements(transactionId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ilm_trailer_mvmt_no ON ilm_trailer_movements(transactionId, movementNo);

-- 4_ILM_Trailer_Load_Detail's repeating trailer-row table. movementId groups
-- loads into their Trailer Movement round; transactionId is kept alongside
-- it (denormalised) so every fleet-wide/rig-wide report that already reads
-- "every load for this ILM" continues to work unchanged regardless of how
-- many rounds exist. srNo is always server-assigned (1, 2, 3… per round),
-- never user-entered.
CREATE TABLE IF NOT EXISTS ilm_trailer_loads (
  id              TEXT PRIMARY KEY,
  transactionId   TEXT NOT NULL REFERENCES ilm_transactions(id) ON DELETE CASCADE,
  movementId      TEXT REFERENCES ilm_trailer_movements(id) ON DELETE CASCADE,
  lineNo          INTEGER NOT NULL,
  srNo            TEXT,
  mtGatePassNo    TEXT,
  trailerNo       TEXT,
  equipmentId     TEXT REFERENCES equipment(id) ON DELETE SET NULL,  -- optional link to the central Equipment Master (category 'Trailer'); trailerNo stays the historical label as recorded
  trailerType     TEXT,
  capacityTon     REAL,
  arrivalDate     TEXT,
  arrivalTime     TEXT,
  loadingDate     TEXT,
  loadingTime     TEXT,
  loadDescription TEXT,
  totalPackages   REAL,
  unloadingDate   TEXT,
  unloadingTime   TEXT,
  driverName      TEXT,
  driverContact   TEXT
);
CREATE INDEX IF NOT EXISTS idx_ilm_trailer_txn ON ilm_trailer_loads(transactionId);
-- idx_ilm_trailer_movement (on movementId) is created in db/index.ts's migration
-- instead of here: on a pre-existing database this table already exists from
-- before movementId was added, and an index on a not-yet-added column would
-- fail before the ALTER TABLE that adds it ever runs.

-- One row per Crane Round under an ILM — a crane can arrive, work, be
-- released, and a later crane brought in as its own separate round, all
-- under the same ILM. oldLocation/newLocation are a SNAPSHOT taken from
-- ilm_individual at the moment the round is created (same convention as
-- ilm_trailer_movements) — editing the ILM header later never changes an
-- already-created round's snapshot.
CREATE TABLE IF NOT EXISTS ilm_crane_rounds (
  id            TEXT PRIMARY KEY,
  transactionId TEXT NOT NULL REFERENCES ilm_transactions(id) ON DELETE CASCADE,
  roundNo       INTEGER NOT NULL,
  oldLocation   TEXT,
  newLocation   TEXT,
  -- Which the Add Crane Round form's "Location" dropdown had selected:
  -- 'Old Location' | 'New Location'. Null on rows from before this dropdown
  -- existed. Purely a record of the choice made — oldLocation/newLocation
  -- themselves are unaffected by it.
  locationType  TEXT,
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ilm_crane_round_txn ON ilm_crane_rounds(transactionId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ilm_crane_round_no ON ilm_crane_rounds(transactionId, roundNo);

-- 5_ILM_Crane_Detail — a flat repeating table, no header block. roundId
-- groups records into their Crane Round; transactionId stays alongside it
-- (denormalised) so existing fleet/rig reports keep working unchanged.
CREATE TABLE IF NOT EXISTS ilm_cranes (
  id              TEXT PRIMARY KEY,
  transactionId   TEXT NOT NULL REFERENCES ilm_transactions(id) ON DELETE CASCADE,
  roundId         TEXT REFERENCES ilm_crane_rounds(id) ON DELETE CASCADE,
  lineNo          INTEGER NOT NULL,
  craneNo         TEXT,
  equipmentId     TEXT REFERENCES equipment(id) ON DELETE SET NULL,  -- optional link to the central Equipment Master (category 'Crane'); craneNo stays the historical label as recorded
  capacityTon     REAL,
  reportingDate   TEXT,
  rigOrHired      TEXT,
  registrationNo  TEXT,
  arrivedDate     TEXT,
  arrivedTime     TEXT,
  releaseDate     TEXT,
  releaseTime     TEXT,
  transporterName TEXT,
  dayNo           INTEGER,
  shiftDate       TEXT,
  dayShiftHrs     REAL,
  detailsJobDay   TEXT,
  nightShiftHrs   REAL,
  detailsJobNight TEXT,
  breakdownHrs    REAL,
  cumulativeHrs   REAL,
  issuedHsdLtrs   REAL,
  totalWorkingHrs REAL
);
CREATE INDEX IF NOT EXISTS idx_ilm_crane_txn ON ilm_cranes(transactionId);
-- idx_ilm_crane_round (on roundId) is created in db/index.ts's migration
-- instead of here, for the same reason as idx_ilm_trailer_movement above.

-- Internal Follow-up: the weekly office review meeting log. One row per
-- Rig+Equipment issue discussed in a meeting — "allow multiple equipment/
-- issues in one meeting" is simply multiple rows sharing the same
-- meetingDate+rigId, the same way DRR/mechanical logs are per-row entries
-- with no separate "meeting" header entity. equipmentName/Make/Model/Serial
-- and responsiblePerson are frozen snapshots taken at save time (spec:
-- "Historical follow-ups must never change when equipment details change" /
-- "Preserve complete follow-up history") — equipmentId/responsiblePersonId
-- are kept purely for linking/filtering, never re-joined for display.
CREATE TABLE IF NOT EXISTS internal_followups (
  id                  TEXT PRIMARY KEY,
  meetingDate         TEXT NOT NULL,
  rigId               TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  equipmentId         TEXT NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
  equipmentName       TEXT NOT NULL,
  equipmentMake       TEXT,
  equipmentModel      TEXT,
  equipmentSerial     TEXT,
  equipmentStatus     TEXT NOT NULL,   -- 'Working' | 'Stopped' | 'Breakdown' | 'Under Maintenance'
  issue               TEXT,
  discussionNote      TEXT,
  requiredAction      TEXT,
  responsiblePersonId TEXT REFERENCES users(id) ON DELETE SET NULL,
  responsiblePerson   TEXT,            -- name snapshot; always populated when responsiblePersonId is
  priority            TEXT NOT NULL DEFAULT 'Medium',  -- 'Low' | 'Medium' | 'High' | 'Critical'
  targetDate          TEXT,
  status              TEXT NOT NULL DEFAULT 'Open',    -- 'Open' | 'In Progress' | 'Completed' | 'On Hold'
  remarks             TEXT,
  createdBy           TEXT NOT NULL,
  createdAt           TEXT NOT NULL,
  updatedBy           TEXT,
  updatedAt           TEXT NOT NULL,
  closedAt            TEXT
);
CREATE INDEX IF NOT EXISTS idx_ifu_rig ON internal_followups(rigId);
CREATE INDEX IF NOT EXISTS idx_ifu_equipment ON internal_followups(equipmentId);
CREATE INDEX IF NOT EXISTS idx_ifu_status ON internal_followups(status);
CREATE INDEX IF NOT EXISTS idx_ifu_meeting_date ON internal_followups(meetingDate);

-- Admin > Invoice > Invoice Settings: the per-rig/contract commercial terms
-- and printed-footer details an invoice needs that exist NOWHERE else in
-- this database (Contract No., Accounting Code, our own GSTIN/PAN/bank
-- details, day rates, GST %). None of this is operational data — it is
-- contract configuration, entered once per rig and reused by every invoice
-- for that rig until an Admin changes it. Genuinely new data, not derived
-- from DRR/DPR/ILM/PMS, so it never overlaps with or duplicates those.
CREATE TABLE IF NOT EXISTS invoice_settings (
  id                   TEXT PRIMARY KEY,
  rigId                TEXT NOT NULL UNIQUE REFERENCES rigs(id) ON DELETE CASCADE,
  contractNo           TEXT,
  accountingCode       TEXT,
  clientAddressBlock   TEXT,   -- client's address/phone/fax/email lines; the client's NAME and GSTIN still come live from `companies` via rigs.companyId, never duplicated here
  contractorAddress    TEXT,   -- our own site/registered address printed on the invoice
  contractorGstin      TEXT,   -- our own GSTIN for this contract's state
  operatingDayRate     REAL,   -- base day rate; Standby/Repair rates below are a % of this, matching the reference Excel's G17=G16*70%, G18=G16*60%
  standbyRatePct       REAL NOT NULL DEFAULT 70,
  repairRatePct        REAL NOT NULL DEFAULT 60,
  forceMajeureRate     REAL NOT NULL DEFAULT 0,   -- "During ILM - no charge" in the reference Excel; kept configurable rather than hardcoded to 0
  ilmChargeRate        REAL,   -- lumpsum rate per completed ILM event
  sgstPercent          REAL NOT NULL DEFAULT 9,
  cgstPercent          REAL NOT NULL DEFAULT 9,
  bankAccountName      TEXT,   -- "Name and Address of contractor as per Bank record"
  bankName             TEXT,   -- "Name and Address of Bank with Branch details"
  bankAccountType      TEXT,   -- Current | Savings | Cash Credit
  bankAccountNumber    TEXT,
  bankIfsc             TEXT,
  pan                  TEXT,
  authorisedEmail      TEXT,
  signatoryCompanyName TEXT,   -- "For, <company>" line above the signature
  createdBy            TEXT NOT NULL,
  createdAt            TEXT NOT NULL,
  updatedBy            TEXT,
  updatedAt            TEXT NOT NULL
);

-- Admin > Invoice: one row per generated invoice. Every header/footer field
-- and the 5 price-element lines are FROZEN at save time (priceLines is a
-- JSON snapshot) — a later correction to DRR/DPR hours, an ILM transaction,
-- Rig Master, Companies, or Invoice Settings must never change an
-- already-saved invoice's numbers, mirroring the freeze-at-save discipline
-- used throughout this app (ILM contract duration, manpower roster,
-- internal_followups). The uniqueness guard blocks a second non-cancelled
-- invoice for the same rig+period, not a second row outright (a cancelled
-- invoice can be superseded by a fresh one for the same period).
CREATE TABLE IF NOT EXISTS invoices (
  id                 TEXT PRIMARY KEY,
  invoiceNumber      TEXT NOT NULL UNIQUE,
  rigId              TEXT NOT NULL REFERENCES rigs(id) ON DELETE RESTRICT,
  invoiceDate        TEXT NOT NULL,
  periodFrom         TEXT NOT NULL,
  periodTo           TEXT NOT NULL,
  periodLabel        TEXT NOT NULL,     -- e.g. "JULY'2026 (01.07.2026 to 31.07.2026)", frozen text matching the reference Excel

  clientName         TEXT,
  clientAddressBlock TEXT,
  clientGstin        TEXT,
  rigName            TEXT NOT NULL,
  rigNumber          TEXT NOT NULL,
  contractNo         TEXT,
  accountingCode     TEXT,
  wellLocation       TEXT,
  contractorAddress  TEXT,
  contractorGstin    TEXT,

  priceLines         TEXT NOT NULL,     -- JSON: [{sNo, particulars, totalHrs, qty, uom, rate, grossAmount}]

  totalAmount        REAL NOT NULL,
  sgstPercent        REAL NOT NULL,
  sgstAmount         REAL NOT NULL,
  cgstPercent        REAL NOT NULL,
  cgstAmount         REAL NOT NULL,
  netAmount          REAL NOT NULL,
  amountInWords      TEXT NOT NULL,

  bankAccountName    TEXT,
  bankName           TEXT,
  bankAccountType    TEXT,
  bankAccountNumber  TEXT,
  bankIfsc           TEXT,
  pan                TEXT,
  authorisedEmail    TEXT,
  signatoryCompanyName TEXT,

  status             TEXT NOT NULL DEFAULT 'Final',  -- 'Final' | 'Cancelled'
  remarks            TEXT,    -- the one freely-editable invoice-specific note field
  createdBy          TEXT NOT NULL,
  createdAt          TEXT NOT NULL,
  updatedBy          TEXT,
  updatedAt          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_rig ON invoices(rigId);
CREATE INDEX IF NOT EXISTS idx_invoices_period ON invoices(periodFrom);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_rig_period_active ON invoices(rigId, periodFrom, periodTo) WHERE status != 'Cancelled';

-- Admin > Demo Data: every row a "Load Demo Data" run creates, logged here so
-- "Clear Demo Data" can remove exactly those rows (and nothing a real user
-- entered) without needing an isDemo column bolted onto a dozen unrelated
-- tables. Only top-level rows are logged (rigs, users, equipment, oil
-- lubricants, dpr_reports, hsd_reports, drr_reports, ilm_transactions,
-- departments) — their line-item children already cascade-delete with them.
CREATE TABLE IF NOT EXISTS demo_data_log (
  id          TEXT PRIMARY KEY,
  entityTable TEXT NOT NULL,
  entityId    TEXT NOT NULL,
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_data_log_table ON demo_data_log(entityTable);

