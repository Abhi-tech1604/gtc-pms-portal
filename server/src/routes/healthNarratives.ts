import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { isIsoDate, nowIso, today } from '../util/date.js';
import { cleanText } from '../util/num.js';
import { parseHealthNarrativeWorkbook, type ParsedNarrativeRow } from '../excel/parseHealthNarrative.js';
import { guessCategory } from '../excel/ingest.js';
import { nameKey, serialKey } from '../excel/normalize.js';
import { assertRigAllowed, requireAuth, requirePage, rigScope } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { equipmentStatus } from '../services/calc.js';
import { resolveEquipmentHealthCheckupPending, resolveHealthCheckDueSoon } from '../services/notifications.js';
import { createEquipment } from './equipment.js';

export const healthNarrativesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.xlsx', '.xls', '.xlsm'].includes(ext)) {
      cb(new HttpError(400, `"${file.originalname}" is not an Excel workbook.`));
      return;
    }
    cb(null, true);
  },
});

interface MatchedRow extends ParsedNarrativeRow {
  rigId: string | null;
  rigName: string | null;
  rigNumber: string | null;
  equipmentId: string | null;
  equipmentName: string | null;
  /**
   * Set only when the row names a resolved rig but no existing machine there
   * — grouped by serial (or name, when no serial is given), scoped to the
   * rig, so the same never-seen machine mentioned on several rows becomes
   * exactly one new equipment record at import, not one per row.
   */
  pendingGroupKey: string | null;
}

/** Groups an unmatched row for equipment creation: serial when given, else name — scoped to the rig, same priority as matchNarrativeEquipment itself. */
function narrativeGroupKey(rigId: string, serialNumber: string | null, application: string | null): string | null {
  const sk = serialKey(serialNumber);
  if (sk) return `${rigId}|s:${sk}`;
  const nk = nameKey(application);
  return nk ? `${rigId}|n:${nk}` : null;
}

/**
 * Serial-then-name matching scoped to one rig — the same rule
 * excel/ingest.ts's matchEquipment uses for the mechanical log, and for the
 * same reason: a serial number, when both sides state one, is decisive; a
 * name only decides when neither side has a serial to disagree over. Applying
 * it here is what makes an uploaded workbook actually reset a tracked
 * machine's health countdown, rather than only ever being informational text.
 */
export function matchNarrativeEquipment(
  rigId: string,
  serialNumber: string | null,
  application: string | null,
): { id: string; name: string } | null {
  const candidates = db.prepare<[string], { id: string; name: string; serialKey: string | null; nameKey: string }>(
    'SELECT id, name, serialKey, nameKey FROM equipment WHERE rigId = ?',
  ).all(rigId);

  const sk = serialKey(serialNumber);
  if (sk) {
    const bySerial = candidates.find((c) => c.serialKey && c.serialKey === sk);
    if (bySerial) return bySerial;
  }
  const nk = nameKey(application);
  if (nk) {
    const byName = candidates.find((c) => c.nameKey === nk);
    if (byName) return byName;
  }
  return null;
}

interface PendingNarrative {
  planId: string;
  fileName: string;
  storedFileName: string;
  rows: MatchedRow[];
  issues: { level: 'warning'; message: string }[];
  sheetsFound: string[];
  userId: string;
  createdAt: number;
}

const pending = new Map<string, PendingNarrative>();
const PENDING_TTL_MS = 60 * 60 * 1000;

function sweepPending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(id);
  }
}

/* ---------------------------- preview ---------------------------- */

export interface NarrativePlan {
  rows: MatchedRow[];
  issues: { level: 'warning'; message: string }[];
}

/**
 * Resolves each parsed row against the rig and equipment registries: which
 * rig it belongs to, which existing machine (if any) it matches, and — when a
 * rig resolved but no machine did — the group key a same-machine row should
 * share so import creates one new machine, not one per row. Reads the
 * database but writes nothing, so it can run inside a preview and be
 * unit-tested without touching a real Excel file.
 *
 * The alert this produces: a machine named in the health check-up but absent
 * from its rig's equipment directory usually means no mechanical log has been
 * uploaded for that rig yet (that is normally what creates equipment).
 * Rather than silently drop the finding, it is surfaced as a warning here and
 * the machine is created from what the health check-up itself provides at
 * import. The reverse — equipment the mechanical log knows about that this
 * workbook never mentions — is expected and is never flagged.
 */
export function planNarrativeRows(rows: ParsedNarrativeRow[], scope: string[] | null): NarrativePlan {
  const rigRows = db.prepare<[], { id: string; name: string; rigNumber: string; rigKey: string }>(
    'SELECT id, name, rigNumber, rigKey FROM rigs',
  ).all();
  const byKey = new Map(rigRows.map((r) => [r.rigKey, r]));

  const issues: { level: 'warning'; message: string }[] = [];
  let unmatchedRigCount = 0;
  let outOfScopeCount = 0;

  const matched: MatchedRow[] = rows.map((row) => {
    const rig = row.rigKey ? byKey.get(row.rigKey) ?? null : null;
    if (row.rigText && !rig) unmatchedRigCount++;
    const equipment = rig ? matchNarrativeEquipment(rig.id, row.serialNumber, row.application) : null;
    return {
      ...row,
      rigId: rig?.id ?? null, rigName: rig?.name ?? null, rigNumber: rig?.rigNumber ?? null,
      equipmentId: equipment?.id ?? null, equipmentName: equipment?.name ?? null,
      pendingGroupKey: rig && !equipment ? narrativeGroupKey(rig.id, row.serialNumber, row.application) : null,
    };
  }).filter((row) => {
    // A rig-scoped user only imports entries for their own rig; entries for
    // other rigs (or with no rig, e.g. yard spares) are left out of their
    // preview entirely rather than silently imported against a rig they
    // cannot see.
    if (!scope) return true;
    if (row.rigId && scope.includes(row.rigId)) return true;
    if (row.rigId) outOfScopeCount++;
    return false;
  });

  if (unmatchedRigCount > 0) {
    issues.push({
      level: 'warning',
      message: `${unmatchedRigCount} row(s) name a rig that is not registered. They will be imported with the ` +
        `rig kept as text only, unlinked from any specific rig.`,
    });
  }
  if (scope && outOfScopeCount > 0) {
    issues.push({
      level: 'warning',
      message: `${outOfScopeCount} row(s) for other rigs were left out of this preview; your account is limited ` +
        'to its assigned rig.',
    });
  }
  if (matched.length === 0) {
    issues.push({ level: 'warning', message: 'Nothing in this workbook applies to your account.' });
  }

  const missingByRig = new Map<string, { rigNumber: string; count: number; samples: string[] }>();
  for (const row of matched) {
    if (!row.pendingGroupKey || !row.rigId || !row.rigNumber) continue;
    const bucket = missingByRig.get(row.rigId) ?? { rigNumber: row.rigNumber, count: 0, samples: [] };
    bucket.count++;
    if (row.application && !bucket.samples.includes(row.application) && bucket.samples.length < 3) {
      bucket.samples.push(row.application);
    }
    missingByRig.set(row.rigId, bucket);
  }
  for (const { rigNumber, count: n, samples } of missingByRig.values()) {
    issues.push({
      level: 'warning',
      message: `${rigNumber}: ${n} machine(s) in this health check-up are not in its equipment directory yet ` +
        `(e.g. ${samples.join(', ')}${n > samples.length ? ', ...' : ''}) — usually because no mechanical log ` +
        `has been uploaded for this rig. They will be created from this health check-up data; verify their ` +
        `running hours and service interval once a mechanical log is available.`,
    });
  }

  return { rows: matched, issues };
}

healthNarrativesRouter.post('/preview', requireAuth, requirePage('PMS','healthcheckup','create'),
  upload.single('file'), wrap((req, res) => {
    sweepPending();
    if (!req.file) throw badRequest('Attach the Engine/Transmission Health Check-up workbook to upload.');

    const parsed = parseHealthNarrativeWorkbook(req.file.buffer);
    const plan = planNarrativeRows(parsed.rows, rigScope(req));
    const issues = [...parsed.issues, ...plan.issues];

    const storedFileName = `${Date.now()}_${newId('hn')}${path.extname(req.file.originalname).toLowerCase()}`;
    fs.writeFileSync(path.join(config.uploadDir, storedFileName), req.file.buffer);

    const entry: PendingNarrative = {
      planId: newId('hnplan'),
      fileName: req.file.originalname,
      storedFileName,
      rows: plan.rows,
      issues,
      sheetsFound: parsed.sheetsFound,
      userId: req.user!.id,
      createdAt: Date.now(),
    };
    pending.set(entry.planId, entry);

    res.json({
      preview: {
        planId: entry.planId,
        fileName: entry.fileName,
        sheetsFound: entry.sheetsFound,
        totalRows: entry.rows.length,
        matchedToRig: entry.rows.filter((r) => r.rigId).length,
        matchedToEquipment: entry.rows.filter((r) => r.equipmentId).length,
        toCreateEquipment: new Set(entry.rows.filter((r) => r.pendingGroupKey).map((r) => r.pendingGroupKey)).size,
        withPlace: entry.rows.filter((r) => r.place).length,
        issues: entry.issues,
        rows: entry.rows,
      },
    });
  }));

/**
 * Creates a machine straight from a health check-up row when its rig has no
 * matching equipment — normally a mechanical log upload is what creates
 * equipment, but a rig can have a health check-up on record before it has
 * ever had one. Uses the same category guess (excel/ingest.ts's guessCategory)
 * a mechanical log import would use, so a machine created this way and one
 * created from a workbook land in the same category from the same name.
 * Running hours and service interval are left at their defaults (0 / 500):
 * the health check-up carries neither, and both should be corrected once a
 * mechanical log for this rig exists — the audit entry says so explicitly.
 */
/**
 * Routed through the one shared createEquipment() (server/src/routes/equipment.ts)
 * — the same function manual Add Equipment and bulk Equipment Master import
 * already use — so a machine created from an unmatched health check-up row
 * is identical in shape to one created anywhere else in the app, and picks
 * up any future change to that function automatically.
 */
function createEquipmentFromNarrative(
  row: MatchedRow, fileName: string, ctx: { user: string; ip: string | null },
): string {
  // Only ever called when row.pendingGroupKey is set, which planNarrativeRows
  // only sets once a rig has actually resolved (spec: "rig && !equipment").
  if (!row.rigId) throw new Error('createEquipmentFromNarrative called for a row with no resolved rig.');
  const name = row.application ?? 'Unnamed component';
  const category = guessCategory(name, 'diesel');
  const section = category === 'DG Set' || category === 'Generator' ? 'generator' : 'diesel';

  const record = createEquipment(row.rigId, {
    name, category, section,
    manufacturer: row.make, model: row.model, serialNumber: row.serialNumber,
  }, ctx.user, ctx.ip);

  audit({
    user: ctx.user, ip: ctx.ip, action: 'equipment.createdFromHealthNarrative',
    entity: 'equipment', entityId: record.id,
    detail: `Created from the health check-up workbook ${fileName} on ${row.rigNumber} — no mechanical log ` +
      'has created this machine yet; verify its running hours and service interval once one is uploaded.',
  });

  return record.id;
}

export interface NarrativeCommitResult {
  uploadId: string;
  recordsImported: number;
  matchedToEquipment: number;
  equipmentCreated: number;
}

/**
 * Writes a resolved plan's rows: the upload record, every health_narratives
 * row, a newly-created machine for each distinct pendingGroupKey (see
 * planNarrativeRows), and each touched machine's countdown advance — all in
 * one transaction, so a failure partway through leaves nothing written.
 *
 * Extracted from the route handler (matching how routes/rigs.ts exports
 * createRig) so the whole import can be unit-tested without an HTTP layer.
 */
export function commitNarrativeRows(
  rows: MatchedRow[],
  fileName: string,
  storedFileName: string | null,
  ctx: { user: string; ip: string | null },
): NarrativeCommitResult {
  if (rows.length === 0) throw badRequest('There is nothing in this workbook to import.');

  return transact(() => {
    const uploadId = newId('hnupl');
    db.prepare(`
      INSERT INTO health_narrative_uploads (id, fileName, storedFileName, uploadDate, uploadedBy, recordsImported)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uploadId, fileName, storedFileName, nowIso(), ctx.user, rows.length);

    const insertRow = db.prepare(`
      INSERT INTO health_narratives
        (id, uploadId, equipmentId, sourceSheet, category, rigId, rigText, place, application, make,
         details, serialNumber, previousDate, previousDateRaw, lastDate, lastDateRaw, problem, action,
         outcomeNotes, createdAt)
      VALUES (@id, @uploadId, @equipmentId, @sourceSheet, @category, @rigId, @rigText, @place, @application,
              @make, @details, @serialNumber, @previousDate, @previousDateRaw, @lastDate, @lastDateRaw,
              @problem, @action, @outcomeNotes, @createdAt)
    `);

    const createdAt = nowIso();
    // A machine can appear on more than one row (e.g. it shows up under both
    // a "Previous" and a fresh "Last" reading); the candidate offered to the
    // countdown is the latest lastDate this upload has for that machine.
    const latestByEquipment = new Map<string, string>();
    // A never-seen machine mentioned on several rows must become exactly one
    // new equipment record, not one per row — see narrativeGroupKey.
    const pendingEquipmentIds = new Map<string, string>();
    let equipmentCreated = 0;
    for (const row of rows) {
      let equipmentId = row.equipmentId;
      if (!equipmentId && row.pendingGroupKey) {
        equipmentId = pendingEquipmentIds.get(row.pendingGroupKey) ?? null;
        if (!equipmentId) {
          equipmentId = createEquipmentFromNarrative(row, fileName, ctx);
          pendingEquipmentIds.set(row.pendingGroupKey, equipmentId);
          equipmentCreated++;
        }
      }
      insertRow.run({ id: newId('hn'), uploadId, createdAt, ...row, equipmentId });
      if (equipmentId && row.lastDate) {
        const current = latestByEquipment.get(equipmentId);
        if (!current || row.lastDate > current) latestByEquipment.set(equipmentId, row.lastDate);
      }
    }

    audit({
      user: ctx.user, ip: ctx.ip, action: 'healthnarrative.import',
      entity: 'health_narrative_uploads', entityId: uploadId,
      detail: `${fileName}: ${rows.length} engineering health check-up entries, ` +
        `${latestByEquipment.size} matched to tracked equipment (${equipmentCreated} newly created)`,
    });

    // Only ever advances a machine's countdown forward — see advanceHealthCountdown.
    for (const [equipmentId, candidateDate] of latestByEquipment) {
      advanceHealthCountdown(equipmentId, candidateDate, ctx);
    }

    return {
      uploadId, recordsImported: rows.length,
      matchedToEquipment: latestByEquipment.size, equipmentCreated,
    };
  });
}

healthNarrativesRouter.post('/import/:planId', requireAuth, requirePage('PMS','healthcheckup','create'), wrap((req, res) => {
  const entry = pending.get(req.params.planId);
  if (!entry) throw notFound('That preview has expired. Upload the workbook again.');
  if (entry.userId !== req.user!.id) throw new HttpError(403, 'That preview belongs to another user.');

  const result = commitNarrativeRows(
    entry.rows, entry.fileName, entry.storedFileName,
    { user: req.user!.username, ip: req.clientIp ?? null },
  );

  pending.delete(entry.planId);
  res.json({ result });
}));

/* ---------------------------- countdown ---------------------------- */

interface EquipmentCountdownRow {
  id: string; lastHealthCheckDate: string | null; currentRunningHours: number;
  lastServiceHours: number; serviceInterval: number; isBreakdown: number;
}

const SELECT_COUNTDOWN_ROW = `
  SELECT id, lastHealthCheckDate, currentRunningHours, lastServiceHours, serviceInterval, isBreakdown
  FROM equipment WHERE id = ?
`;

function writeCountdown(equipment: EquipmentCountdownRow, nextDate: string | null, ctx: { user: string; ip: string | null }, detail: string): void {
  db.prepare('UPDATE equipment SET lastHealthCheckDate = ?, status = ?, updatedAt = ? WHERE id = ?').run(
    nextDate,
    equipmentStatus({
      currentRunningHours: equipment.currentRunningHours,
      lastServiceHours: equipment.lastServiceHours,
      serviceInterval: equipment.serviceInterval,
      isBreakdown: !!equipment.isBreakdown,
    }),
    nowIso(),
    equipment.id,
  );
  audit({
    user: ctx.user, ip: ctx.ip, action: 'healthnarrative.countdown',
    entity: 'equipment', entityId: equipment.id,
    field: 'lastHealthCheckDate', oldValue: equipment.lastHealthCheckDate, newValue: nextDate,
    detail,
  });
}

/**
 * A new checkup (manual, or a bulk-imported row matched to this machine) only
 * ever moves the countdown forward — a back-dated entry, or an older workbook
 * row, must never undo a more recent checkup already on record, however that
 * later one was set (another log entry, or a hand-edited date on the machine
 * itself, which this must also respect).
 */
export function advanceHealthCountdown(equipmentId: string, candidateDate: string, ctx: { user: string; ip: string | null }): void {
  const equipment = db.prepare<[string], EquipmentCountdownRow>(SELECT_COUNTDOWN_ROW).get(equipmentId);
  if (!equipment) return;
  const nextDate = !equipment.lastHealthCheckDate || candidateDate > equipment.lastHealthCheckDate
    ? candidateDate : equipment.lastHealthCheckDate;
  // A checkup was logged for this machine either way, so any pending overdue
  // notification is resolved even when this particular entry is not the
  // newest date on file.
  resolveEquipmentHealthCheckupPending(equipmentId);
  resolveHealthCheckDueSoon(equipmentId);
  if (nextDate === equipment.lastHealthCheckDate) return;
  writeCountdown(equipment, nextDate, ctx, `Health countdown advanced to ${nextDate} from the health log`);
}

/**
 * Called after deleting a batch of narrative rows for one machine. Walks the
 * countdown back only when the date currently shown was actually justified by
 * one of the rows just removed — deletedMaxDate is the latest lastDate among
 * exactly those rows. If the machine's current date does not match that (some
 * other entry, or a hand-edited date, set it), it is left alone: deleting
 * older history must never disturb a still-valid, independently-set value.
 * When it does match, the machine falls back to whatever the remaining log
 * entries justify — all the way to "never checked" if none are left.
 */
export function walkBackHealthCountdown(
  equipmentId: string,
  deletedMaxDate: string | null,
  ctx: { user: string; ip: string | null },
): void {
  if (!deletedMaxDate) return;
  const equipment = db.prepare<[string], EquipmentCountdownRow>(SELECT_COUNTDOWN_ROW).get(equipmentId);
  if (!equipment || equipment.lastHealthCheckDate !== deletedMaxDate) return;

  const remaining = db.prepare<[string], { lastDate: string | null }>(
    'SELECT MAX(lastDate) AS lastDate FROM health_narratives WHERE equipmentId = ?',
  ).get(equipmentId)!;
  const nextDate = remaining.lastDate ?? null;
  if (nextDate === equipment.lastHealthCheckDate) return;

  writeCountdown(equipment, nextDate, ctx, nextDate
    ? `Health countdown reverted to ${nextDate} after a log entry was deleted`
    : 'Health countdown cleared: the only checkup on record for this machine was deleted');
}

/* ---------------------------- manual entry ---------------------------- */

export interface ManualCheckupInput {
  equipmentId: string;
  date?: string;
  problem?: string;
  action?: string;
  remarks?: string;
}

/**
 * Logged from one machine's own record (the health checkup button in the
 * Equipment Directory / Equipment Detail), so unlike a bulk import this row
 * always carries equipmentId — the machine is not in question here, the user
 * opened its own page to log it. The same fields as the workbook: date,
 * problem, action, remarks. Logging a checkup resets the 90-day countdown
 * exactly as the old health_check_records flow did, and resolves any pending
 * "checkup overdue" notification for this machine.
 *
 * Extracted from the route handler (matching how routes/rigs.ts exports
 * createRig) so this rule can be unit-tested without an HTTP layer.
 */
export function logManualCheckup(input: ManualCheckupInput, ctx: { user: string; ip: string | null }) {
  const equipment = db.prepare<[string], {
    id: string; rigId: string; name: string; category: string; manufacturer: string | null;
    model: string | null; serialNumber: string | null; currentPlace: string | null;
    lastHealthCheckDate: string | null; currentRunningHours: number; lastServiceHours: number;
    serviceInterval: number; isBreakdown: number;
  }>('SELECT * FROM equipment WHERE id = ?').get(input.equipmentId);
  if (!equipment) throw badRequest('Choose the machine this checkup applies to.');

  const rig = db.prepare<[string], { rigNumber: string }>('SELECT rigNumber FROM rigs WHERE id = ?').get(equipment.rigId);
  const date = isIsoDate(input.date) ? input.date! : today();
  const problem = cleanText(input.problem);
  const action = cleanText(input.action);
  const remarks = cleanText(input.remarks);

  return transact(() => {
    const uploadId = newId('hnupl');
    db.prepare(`
      INSERT INTO health_narrative_uploads (id, fileName, storedFileName, uploadDate, uploadedBy, recordsImported)
      VALUES (?, 'Manual entry', NULL, ?, ?, 1)
    `).run(uploadId, nowIso(), ctx.user);

    const narrativeId = newId('hn');
    db.prepare(`
      INSERT INTO health_narratives
        (id, uploadId, equipmentId, sourceSheet, category, rigId, rigText, place, application, make,
         details, serialNumber, previousDate, lastDate, problem, action, outcomeNotes, createdAt)
      VALUES (@id, @uploadId, @equipmentId, 'Manual Entry', @category, @rigId, @rigText, @place,
              @application, @make, @details, @serialNumber, @previousDate, @lastDate, @problem, @action,
              @outcomeNotes, @createdAt)
    `).run({
      id: narrativeId,
      uploadId,
      equipmentId: equipment.id,
      category: equipment.category,
      rigId: equipment.rigId,
      rigText: rig?.rigNumber ?? null,
      place: equipment.currentPlace,
      application: equipment.name,
      make: equipment.manufacturer,
      details: equipment.model ? `Model : ${equipment.model}` : null,
      serialNumber: equipment.serialNumber,
      previousDate: equipment.lastHealthCheckDate,
      lastDate: date,
      problem,
      action,
      outcomeNotes: remarks,
      createdAt: nowIso(),
    });

    audit({
      user: ctx.user, ip: ctx.ip, action: 'healthnarrative.manual',
      entity: 'equipment', entityId: equipment.id,
      detail: problem ? `Checkup logged: ${problem}` : 'Checkup logged: no issues found',
    });

    // Only ever advances the countdown forward — see advanceHealthCountdown.
    advanceHealthCountdown(equipment.id, date, ctx);
    return db.prepare('SELECT * FROM health_narratives WHERE id = ?').get(narrativeId);
  });
}

healthNarrativesRouter.post('/manual', requireAuth, requirePage('PMS','healthcheckup','create'), wrap((req, res) => {
  const body = req.body ?? {};
  const equipment = db.prepare<[string], { rigId: string }>('SELECT rigId FROM equipment WHERE id = ?')
    .get(String(body.equipmentId ?? ''));
  if (!equipment) throw badRequest('Choose the machine this checkup applies to.');
  assertRigAllowed(req, equipment.rigId);

  const narrative = logManualCheckup(body as ManualCheckupInput, { user: req.user!.username, ip: req.clientIp ?? null });
  res.status(201).json({ narrative });
}));

/* ---------------------------- reads ---------------------------- */

healthNarrativesRouter.get('/', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  const filters: string[] = [];
  const params: unknown[] = [];
  if (req.query.equipmentId) {
    // A specific machine's own history (Equipment Detail): scoping is already
    // enforced by that page having loaded the machine via GET /equipment/:id,
    // which itself calls assertRigAllowed.
    filters.push('n.equipmentId = ?');
    params.push(req.query.equipmentId);
  } else if (scope) {
    // A rig-scoped user sees entries for their own rig(s) only. Off-rig
    // entries (yard/central store, no rig) carry no rig identity to scope by,
    // so they are excluded rather than shown to every rig-scoped account.
    if (scope.length === 0) filters.push('1 = 0');
    else { filters.push(`n.rigId IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
  } else {
    if (req.query.rigId) { filters.push('n.rigId = ?'); params.push(req.query.rigId); }
    if (req.query.unassigned === 'true') filters.push('n.rigId IS NULL');
  }
  if (req.query.category) { filters.push('n.category = ?'); params.push(req.query.category); }
  if (req.query.place === 'true') filters.push('n.place IS NOT NULL');
  if (req.query.search) {
    filters.push('(n.application LIKE ? OR n.make LIKE ? OR n.problem LIKE ? OR n.details LIKE ? OR n.place LIKE ?)');
    const needle = `%${req.query.search}%`;
    params.push(needle, needle, needle, needle, needle);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT n.*, r.rigNumber AS rigNumber, r.name AS rigName
    FROM health_narratives n
    LEFT JOIN rigs r ON r.id = n.rigId
    ${where}
    ORDER BY COALESCE(n.lastDate, n.previousDate) DESC, n.createdAt DESC
    LIMIT 1000
  `).all(...params);
  res.json({ narratives: rows });
}));

healthNarrativesRouter.get('/uploads', requireAuth, requirePage('PMS','healthcheckup','view'), wrap((_req, res) => {
  const uploads = db.prepare(
    'SELECT * FROM health_narrative_uploads ORDER BY uploadDate DESC',
  ).all();
  res.json({ uploads });
}));

/**
 * Deletes one upload's worth of health_narratives rows and walks back the
 * countdown of every machine those rows were linked to — the fix for a
 * deleted checkup otherwise leaving its effect on the machine in place.
 *
 * Extracted from the route handler (matching how routes/rigs.ts exports
 * createRig) so this rule can be unit-tested without an HTTP layer.
 */
export function deleteNarrativeUpload(uploadId: string, ctx: { user: string; ip: string | null }): void {
  const row = db.prepare<[string], { id: string; fileName: string; recordsImported: number }>(
    'SELECT id, fileName, recordsImported FROM health_narrative_uploads WHERE id = ?',
  ).get(uploadId);
  if (!row) throw notFound('That upload does not exist.');

  transact(() => {
    // For every machine this upload's rows were linked to, the latest lastDate
    // among exactly the rows being deleted — the value walkBackHealthCountdown
    // checks the machine's current date against, so a still-valid date set by
    // some other entry (or a hand-edit) is never disturbed by this delete.
    const deletedRows = db.prepare<[string], { equipmentId: string; lastDate: string | null }>(
      'SELECT equipmentId, lastDate FROM health_narratives WHERE uploadId = ? AND equipmentId IS NOT NULL',
    ).all(row.id);
    const deletedMaxByEquipment = new Map<string, string>();
    for (const r of deletedRows) {
      if (!r.lastDate) continue;
      const current = deletedMaxByEquipment.get(r.equipmentId);
      if (!current || r.lastDate > current) deletedMaxByEquipment.set(r.equipmentId, r.lastDate);
    }

    db.prepare('DELETE FROM health_narratives WHERE uploadId = ?').run(row.id);
    db.prepare('DELETE FROM health_narrative_uploads WHERE id = ?').run(row.id);
    audit({
      user: ctx.user, ip: ctx.ip, action: 'healthnarrative.delete',
      entity: 'health_narrative_uploads', entityId: row.id,
      detail: `Deleted ${row.fileName} and its ${row.recordsImported} entries`,
    });

    for (const [equipmentId, deletedMaxDate] of deletedMaxByEquipment) {
      walkBackHealthCountdown(equipmentId, deletedMaxDate, ctx);
    }
  });
}

healthNarrativesRouter.delete('/uploads/:id', requireAuth, requirePage('PMS','healthcheckup','delete'), wrap((req, res) => {
  deleteNarrativeUpload(req.params.id, { user: req.user!.username, ip: req.clientIp ?? null });
  res.json({ ok: true });
}));
