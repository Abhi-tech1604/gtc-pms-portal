import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { dateFromMonthDay, monthOf, nowIso, today, yesterday } from '../util/date.js';
import { nameKey as toNameKey, rigKey as toRigKey, serialKey as _serialKey } from './normalize.js';
import type { MachineGroup, ParseIssue, ParsedWorkbook, RawDayRow } from './parseWorkbook.js';
import { audit, auditDiff } from '../services/audit.js';
import { equipmentStatus } from '../services/calc.js';
import { resolveRigSheetPending } from '../services/notifications.js';

/**
 * Steps 5 to 7 of the ingestion engine (spec 8.5 - 8.7).
 *
 * planIngestion reads the database but never writes: it resolves the rig,
 * matches each machine group to the equipment register, builds the log rows and
 * works out which confirmation gates apply. commitIngestion then writes the
 * whole plan inside one transaction, so a failure part way through leaves the
 * database exactly as it was.
 */

export interface RigRow {
  id: string;
  name: string;
  rigNumber: string;
  rigKey: string;
}

export interface EquipmentRow {
  id: string;
  rigId: string;
  name: string;
  nameKey: string;
  serialNumber: string | null;
  serialKey: string | null;
  model: string | null;
  manufacturer: string | null;
  category: string;
  currentRunningHours: number;
  lastServiceHours: number;
  serviceInterval: number;
  isBreakdown: number;
  section: string;
}

export interface PlannedLogRow {
  sheetDay: number;
  logDate: string;
  isInUse: string | null;
  hoursRunDay: number | null;
  hoursRunNight: number | null;
  lubeOilPressure: string | null;
  lubeOilAdded: number | null;
  openingRunningHours: number | null;
  totalRunHours: number | null;
  closingHours: number | null;
  lastServiceHours: number | null;
  runningHoursAfterLastService: number | null;
  defineHours: number | null;
  hoursRemainingForNextService: number | null;
  preventiveMaintenanceDetails: string | null;
  remarks: string | null;
  lastServiceDate: string | null;
  makeModel: string | null;
  serialNumber: string | null;
}

export interface PlannedMachine {
  groupKey: string;
  name: string;
  serial: string | null;
  makeModel: string | null;
  section: 'diesel' | 'generator';
  /** Existing equipment id, or null when the import will create the record. */
  equipmentId: string | null;
  isNew: boolean;
  matchedBy: 'serial' | 'name' | 'new';
  rows: PlannedLogRow[];
  /** Values the equipment register will be set to, from the latest real day. */
  update: {
    currentRunningHours: number | null;
    lastServiceHours: number | null;
    serviceInterval: number | null;
    latestDay: number;
    latestDate: string;
  } | null;
}

export type GateKind = 'rigMismatch' | 'lastFilledDay' | 'duplicateUpload';

export interface Gate {
  kind: GateKind;
  message: string;
  details: Record<string, unknown>;
  /** Present on duplicateUpload: the single upload that would be replaced. */
  supersedesUploadId?: string;
}

export interface IngestPlan {
  planId: string;
  fileName: string;
  storedFileName: string;
  rig: RigRow | null;
  rigResolvedFrom: 'workbook' | 'user' | 'unresolved';
  rigNumberInFile: string | null;
  logMonth: string | null;
  lastFilledDay: number | null;
  lastFilledDate: string | null;
  /** Every sheet day that carried at least one real row, regardless of the
   *  override below — the full menu a user can choose "data through" from. */
  availableDays: number[];
  /** Set when the user has explicitly chosen which day to import through,
   *  overriding the workbook's own last real day. */
  lastFilledDayOverride: number | null;
  machines: PlannedMachine[];
  issues: ParseIssue[];
  gates: Gate[];
  totals: { machines: number; newMachines: number; rows: number; days: number[] };
}

export interface PlanInput {
  parsed: ParsedWorkbook;
  fileName: string;
  storedFileName: string;
  /** Rig chosen in the upload form; only used when the workbook does not declare one. */
  selectedRigId?: string | null;
  /** Rig the user explicitly picked in response to the rig-mismatch gate. */
  confirmedRigId?: string | null;
  logMonthOverride?: string | null;
  acknowledged?: Partial<Record<GateKind, boolean>>;
  /** User-chosen cutoff: only days up to and including this sheet day are
   *  imported, even if the workbook has real-looking rows past it. */
  lastFilledDayOverride?: number | null;
}

const selectRigs = db.prepare<[], RigRow>('SELECT id, name, rigNumber, rigKey FROM rigs');
const selectEquipmentForRig = db.prepare<[string], EquipmentRow>(`
  SELECT id, rigId, name, nameKey, serialNumber, serialKey, model, manufacturer, category,
         currentRunningHours, lastServiceHours, serviceInterval, isBreakdown, section
  FROM equipment WHERE rigId = ?
`);

/** Step 1 resolution (spec 8.1): the workbook's own declaration is authoritative. */
export function resolveRig(parsed: ParsedWorkbook, input: PlanInput): {
  rig: RigRow | null;
  from: 'workbook' | 'user' | 'unresolved';
} {
  const rigs = selectRigs.all();

  if (parsed.rigKeyInFile) {
    const match = rigs.find(
      (r) => r.rigKey === parsed.rigKeyInFile || toRigKey(r.name) === parsed.rigKeyInFile,
    );
    // A match found in the workbook is used unconditionally and overrides the form.
    if (match) return { rig: match, from: 'workbook' };
  }

  // No match, or no rig number at all: only an explicit user choice resolves it.
  if (input.confirmedRigId) {
    const chosen = rigs.find((r) => r.id === input.confirmedRigId);
    if (chosen) return { rig: chosen, from: 'user' };
  }
  return { rig: null, from: 'unresolved' };
}

/**
 * Step 4 matching (spec 8.4), always scoped to one rig. Identical machine names
 * across rigs are the norm, and matching without the rig filter is defect D11.
 */
export function matchEquipment(
  group: MachineGroup,
  candidates: EquipmentRow[],
  claimed: Set<string>,
): { equipment: EquipmentRow | null; matchedBy: 'serial' | 'name' | 'new' } {
  const free = candidates.filter((c) => !claimed.has(c.id));

  if (group.serialKey) {
    // Rule 1: both sides declare a serial and they agree.
    const bySerial = free.find((c) => c.serialKey && c.serialKey === group.serialKey);
    if (bySerial) return { equipment: bySerial, matchedBy: 'serial' };

    // Rule 2: both declare a serial and they differ, so it is NOT the same
    // machine no matter what the name says. Only candidates without a serial of
    // their own remain eligible for name matching.
    const nameless = free.filter((c) => !c.serialKey);
    const byName = nameless.find((c) => c.nameKey === group.nameKey);
    if (byName) return { equipment: byName, matchedBy: 'name' };
    return { equipment: null, matchedBy: 'new' };
  }

  // Rule 3: the row declares no serial, so fall through to the name.
  const byName = free.find((c) => c.nameKey === group.nameKey);
  if (byName) return { equipment: byName, matchedBy: 'name' };
  return { equipment: null, matchedBy: 'new' };
}

/**
 * Step 5 (spec 8.5). Walks the days that passed the real-data test, in order.
 * Unfilled days were already dropped upstream and are never synthesised here:
 * a day the crew left blank is a day with no reading (defect D4).
 */
export function buildRows(group: MachineGroup, logMonth: string): PlannedLogRow[] {
  const rows: PlannedLogRow[] = [];
  let carriedClosing: number | null = null;

  for (const day of [...group.days].sort((a, b) => a.sheetDay - b.sheetDay)) {
    const logDate = dateFromMonthDay(logMonth, day.sheetDay);
    if (!logDate) continue; // e.g. sheet "31" in a 30-day month

    const totalRun = totalRunFor(day);

    // Honour the sheet's own meter readings on every day, not only day one.
    let opening: number | null = null;
    if (day.opening !== null) opening = day.opening;
    else if (day.closing !== null) opening = day.closing - totalRun;
    else opening = carriedClosing;

    const closing: number | null =
      day.closing !== null ? day.closing : opening !== null ? opening + totalRun : null;

    // The service baseline is column M, never parsed out of column S (defect D6).
    const lastServiceHours = day.lastServiceHours;
    const runningAfter =
      day.runningAfterService !== null
        ? day.runningAfterService
        : closing !== null && lastServiceHours !== null
          ? closing - lastServiceHours
          : null;

    const defineHours = day.defineHours;
    // Column P as written is authoritative; compute only when it is blank.
    const remaining =
      day.hoursRemaining !== null
        ? day.hoursRemaining
        : defineHours !== null && runningAfter !== null
          ? defineHours - runningAfter
          : null;

    rows.push({
      sheetDay: day.sheetDay,
      logDate,
      isInUse: day.isInUse,
      hoursRunDay: day.hoursRunDay,
      hoursRunNight: day.hoursRunNight,
      lubeOilPressure: day.lubeOilPressure,
      lubeOilAdded: day.lubeOilAdded,
      openingRunningHours: round(opening),
      totalRunHours: round(totalRun),
      closingHours: round(closing),
      lastServiceHours: round(lastServiceHours),
      runningHoursAfterLastService: round(runningAfter),
      defineHours: round(defineHours),
      hoursRemainingForNextService: round(remaining),
      preventiveMaintenanceDetails: day.pmDetails,
      remarks: day.remarks,
      lastServiceDate: day.lastServiceDate,
      makeModel: day.makeModel,
      serialNumber: day.serial,
    });

    if (closing !== null) carriedClosing = closing;
  }
  return rows;
}

function totalRunFor(day: RawDayRow): number {
  if (day.hoursRunDay !== null || day.hoursRunNight !== null) {
    return (day.hoursRunDay ?? 0) + (day.hoursRunNight ?? 0);
  }
  return day.totalRun ?? 0;
}

function round(v: number | null): number | null {
  return v === null || v === undefined ? null : Math.round(v);
}

/**
 * Step 6 (spec 8.6). The latest entry is simply the highest day number among the
 * rows that were created. No extra "hours run must exceed zero" filter, which is
 * what made the previous build fall back to an older, worse day (defect D7).
 */
export function latestUpdate(rows: PlannedLogRow[]): PlannedMachine['update'] {
  if (rows.length === 0) return null;
  const latest = rows.reduce((a, b) => (b.sheetDay > a.sheetDay ? b : a));
  return {
    currentRunningHours: latest.closingHours ?? latest.openingRunningHours,
    lastServiceHours:
      latest.lastServiceHours !== null && latest.lastServiceHours > 0 ? latest.lastServiceHours : null,
    serviceInterval: latest.defineHours !== null && latest.defineHours > 0 ? latest.defineHours : null,
    latestDay: latest.sheetDay,
    latestDate: latest.logDate,
  };
}

const CATEGORY_RULES: { test: RegExp; category: string }[] = [
  { test: /transmission/, category: 'Transmission' },
  { test: /mud\s*pump\s*engine/, category: 'Mud Pump Engine' },
  { test: /mud\s*pump/, category: 'Mud Pump' },
  { test: /(rig\s*(carrier\s*)?engine|carrier)/, category: 'Rig Carrier Engine' },
  { test: /(dg\s*set|d\.?g\.?|generator|genset|kva|tower\s*light)/, category: 'DG Set' },
  { test: /compressor/, category: 'Air Compressor' },
  { test: /fire\s*pump/, category: 'Fire Pump' },
];

/** Best-effort category from the machine name; the user can correct it later. */
export function guessCategory(name: string, section: 'diesel' | 'generator'): string {
  const s = name.toLowerCase();
  for (const rule of CATEGORY_RULES) if (rule.test.test(s)) return rule.category;
  return section === 'generator' ? 'Generator' : 'Others';
}

export function planIngestion(input: PlanInput): IngestPlan {
  const { parsed } = input;
  const { rig, from } = resolveRig(parsed, input);
  const logMonth = input.logMonthOverride || parsed.logMonth || monthOf(today());
  const override = input.lastFilledDayOverride ?? null;

  const availableDays = [...new Set(parsed.groups.flatMap((g) => g.days.map((d) => d.sheetDay)))]
    .sort((a, b) => a - b);

  const issues: ParseIssue[] = [...parsed.issues];
  const machines: PlannedMachine[] = [];

  if (rig) {
    const candidates = selectEquipmentForRig.all(rig.id);
    const claimed = new Set<string>();
    for (const group of parsed.groups) {
      const { equipment, matchedBy } = matchEquipment(group, candidates, claimed);
      if (equipment) claimed.add(equipment.id);
      const truncated = override === null ? group : { ...group, days: group.days.filter((d) => d.sheetDay <= override) };
      const rows = buildRows(truncated, logMonth);
      if (rows.length === 0) {
        issues.push({
          level: 'warning',
          machine: group.name,
          message: `"${group.name}" had no day that maps into ${logMonth} and was skipped.`,
        });
        continue;
      }
      machines.push({
        groupKey: group.key,
        name: group.name,
        serial: group.serial,
        makeModel: group.makeModel,
        section: group.section,
        equipmentId: equipment?.id ?? null,
        isNew: !equipment,
        matchedBy,
        rows,
        update: latestUpdate(rows),
      });
    }
  }

  const days = [...new Set(machines.flatMap((m) => m.rows.map((r) => r.sheetDay)))].sort((a, b) => a - b);
  const lastFilledDay = days.length ? days[days.length - 1] : (override ?? parsed.lastFilledDay);
  const lastFilledDate = lastFilledDay ? dateFromMonthDay(logMonth, lastFilledDay) : null;

  const gates = buildGates({ input, parsed, rig, from, lastFilledDate });

  return {
    planId: newId('plan'),
    fileName: input.fileName,
    storedFileName: input.storedFileName,
    rig,
    rigResolvedFrom: from,
    rigNumberInFile: parsed.rigNumberInFile,
    logMonth,
    lastFilledDay,
    lastFilledDate,
    availableDays,
    lastFilledDayOverride: override,
    machines,
    issues,
    gates,
    totals: {
      machines: machines.length,
      newMachines: machines.filter((m) => m.isNew).length,
      rows: machines.reduce((n, m) => n + m.rows.length, 0),
      days,
    },
  };
}

/** Step 7 (spec 8.7). Three normal situations that require the user to confirm. */
function buildGates(ctx: {
  input: PlanInput;
  parsed: ParsedWorkbook;
  rig: RigRow | null;
  from: 'workbook' | 'user' | 'unresolved';
  lastFilledDate: string | null;
}): Gate[] {
  const { input, parsed, rig, from, lastFilledDate } = ctx;
  const gates: Gate[] = [];
  const ack = input.acknowledged ?? {};

  // Gate 1 - rig mismatch. Never fall back silently to the form's rig (D2).
  if (from !== 'workbook') {
    const selected = input.selectedRigId
      ? selectRigs.all().find((r) => r.id === input.selectedRigId) ?? null
      : null;
    const found = parsed.rigNumberInFile;
    gates.push({
      kind: 'rigMismatch',
      message: found
        ? `The workbook declares rig "${found}", which does not match any registered rig. ` +
          `The upload form has ${selected ? `"${selected.rigNumber}"` : 'no rig'} selected. ` +
          'Choose the rig this workbook belongs to. Filing data against the wrong rig is not easily undone.'
        : 'No rig number could be found in this workbook. ' +
          `The upload form has ${selected ? `"${selected.rigNumber}"` : 'no rig'} selected. ` +
          'Choose the rig this workbook belongs to. Filing data against the wrong rig is not easily undone.',
      details: {
        rigNumberInFile: found,
        selectedRigId: input.selectedRigId ?? null,
        selectedRigNumber: selected?.rigNumber ?? null,
        resolvedRigId: rig?.id ?? null,
        resolvedRigNumber: rig?.rigNumber ?? null,
      },
    });
    if (!rig) return gates; // nothing else can be decided until the rig is known
  }

  // Gate 2 - the last filled day is not yesterday. Choosing an explicit
  // "data through" day is itself the confirmation, so the gate stays quiet.
  const expected = yesterday();
  if (lastFilledDate && lastFilledDate !== expected && !ack.lastFilledDay && input.lastFilledDayOverride == null) {
    gates.push({
      kind: 'lastFilledDay',
      message:
        `The last day filled in this workbook is ${lastFilledDate}, but uploads normally carry data ` +
        `through yesterday, ${expected}. Confirm that this is the correct file before importing.`,
      details: { lastFilledDate, expectedDate: expected },
    });
  }

  // Gate 3 - duplicate upload for the same rig and the same day. Scoped by rig,
  // so one rig's upload never blocks another's (defect D9).
  if (rig && lastFilledDate && !ack.duplicateUpload) {
    const existing = db
      .prepare<[string, string], { id: string; fileName: string; uploadDate: string; uploadedBy: string }>(
        `SELECT id, fileName, uploadDate, uploadedBy
         FROM mechanical_log_uploads
         WHERE rigId = ? AND coverageEndDate = ? AND status = 'Uploaded'
         ORDER BY uploadDate DESC LIMIT 1`,
      )
      .get(rig.id, lastFilledDate);
    if (existing) {
      gates.push({
        kind: 'duplicateUpload',
        message:
          `${rig.rigNumber} already has an upload covering ${lastFilledDate} ` +
          `("${existing.fileName}", uploaded ${existing.uploadDate} by ${existing.uploadedBy}). ` +
          'Continuing replaces that one upload and its log rows. Every other upload for this rig is left untouched.',
        details: {
          rigId: rig.id,
          rigNumber: rig.rigNumber,
          coverageEndDate: lastFilledDate,
          existingFileName: existing.fileName,
          existingUploadDate: existing.uploadDate,
        },
        supersedesUploadId: existing.id,
      });
    }
  }

  return gates;
}

export interface CommitResult {
  uploadId: string;
  rigId: string;
  recordsImported: number;
  equipmentCreated: number;
  equipmentUpdated: number;
  replacedUploadId: string | null;
}

/**
 * Commits a plan. Everything below runs inside a single transaction: if any
 * statement throws, nothing is written (spec 3.2 / 11.1).
 */
export function commitIngestion(
  plan: IngestPlan,
  ctx: { user: string; ip: string | null },
  excludedGroupKeys?: Set<string>,
): CommitResult {
  if (!plan.rig) throw new Error('The rig for this workbook has not been resolved.');
  if (plan.machines.length === 0) throw new Error('This workbook contains no importable rows.');
  // The user may deselect individual machines (e.g. a false "will be created"
  // duplicate) from the preview before committing; everything below imports
  // only what is left.
  const machines = excludedGroupKeys && excludedGroupKeys.size > 0
    ? plan.machines.filter((m) => !excludedGroupKeys.has(m.groupKey))
    : plan.machines;
  if (machines.length === 0) {
    throw new Error('Every machine in this workbook was excluded from the import — nothing left to import.');
  }
  const rig = plan.rig;
  const logMonth = plan.logMonth!;

  const duplicateGate = plan.gates.find((g) => g.kind === 'duplicateUpload');
  const replaceId = duplicateGate?.supersedesUploadId ?? null;

  return transact(() => {
    // Replacement deletes exactly one upload by primary key. Never a predicate
    // over the rig's uploads, which is what wiped whole histories (defect D10).
    if (replaceId) {
      db.prepare('DELETE FROM mechanical_log_rows WHERE uploadId = ?').run(replaceId);
      db.prepare('DELETE FROM mechanical_log_uploads WHERE id = ?').run(replaceId);
      audit({
        user: ctx.user, ip: ctx.ip, action: 'upload.replace',
        entity: 'mechanical_log_uploads', entityId: replaceId,
        detail: `Superseded by a new upload for ${rig.rigNumber} covering ${plan.lastFilledDate}`,
      });
    }

    const uploadId = newId('upl');
    const coverage = machines.flatMap((m) => m.rows.map((r) => r.logDate)).sort();
    db.prepare(`
      INSERT INTO mechanical_log_uploads
        (id, rigId, fileName, storedFileName, uploadDate, logMonth, coverageStartDate, coverageEndDate,
         uploadedBy, status, recordsImported, validationErrorsCount, notes)
      VALUES (@id, @rigId, @fileName, @storedFileName, @uploadDate, @logMonth, @coverageStartDate,
              @coverageEndDate, @uploadedBy, 'Uploaded', @recordsImported, @validationErrorsCount, @notes)
    `).run({
      id: uploadId,
      rigId: rig.id,
      fileName: plan.fileName,
      storedFileName: plan.storedFileName,
      uploadDate: nowIso(),
      logMonth,
      coverageStartDate: coverage[0] ?? null,
      coverageEndDate: coverage[coverage.length - 1] ?? null,
      uploadedBy: ctx.user,
      recordsImported: machines.reduce((n, m) => n + m.rows.length, 0),
      validationErrorsCount: plan.issues.filter((i) => i.level === 'fatal').length,
      notes: plan.rigResolvedFrom === 'user' ? 'Rig confirmed manually by the uploader.' : null,
    });

    const insertRow = db.prepare(`
      INSERT INTO mechanical_log_rows
        (id, uploadId, equipmentId, rigId, sheetDay, logDate, isInUse, hoursRunDay, hoursRunNight,
         lubeOilPressure, lubeOilAdded, openingRunningHours, totalRunHours, closingHours,
         lastServiceHours, runningHoursAfterLastService, defineHours, hoursRemainingForNextService,
         preventiveMaintenanceDetails, remarks, lastServiceDate, makeModel, serialNumber)
      VALUES (@id, @uploadId, @equipmentId, @rigId, @sheetDay, @logDate, @isInUse, @hoursRunDay,
              @hoursRunNight, @lubeOilPressure, @lubeOilAdded, @openingRunningHours, @totalRunHours,
              @closingHours, @lastServiceHours, @runningHoursAfterLastService, @defineHours,
              @hoursRemainingForNextService, @preventiveMaintenanceDetails, @remarks, @lastServiceDate,
              @makeModel, @serialNumber)
    `);

    let equipmentCreated = 0;
    let equipmentUpdated = 0;
    let recordsImported = 0;

    for (const machine of machines) {
      let equipmentId = machine.equipmentId;
      let before: EquipmentRow | undefined;

      if (!equipmentId) {
        equipmentId = newId('eq');
        const stamp = nowIso();
        db.prepare(`
          INSERT INTO equipment
            (id, rigId, name, nameKey, category, manufacturer, model, serialNumber, serialKey,
             currentRunningHours, lastServiceHours, serviceInterval, healthCheckInterval,
             isBreakdown, status, section, createdAt, updatedAt)
          VALUES (@id, @rigId, @name, @nameKey, @category, @manufacturer, @model, @serialNumber,
                  @serialKey, 0, 0, @serviceInterval, 90, 0, 'Normal', @section, @createdAt, @updatedAt)
        `).run({
          id: equipmentId,
          rigId: rig.id,
          name: machine.name,
          nameKey: toNameKey(machine.name),
          category: guessCategory(machine.name, machine.section),
          manufacturer: machine.makeModel,
          model: machine.makeModel,
          serialNumber: machine.serial,
          serialKey: machine.serial ? require_serialKey(machine.serial) : null,
          serviceInterval: machine.update?.serviceInterval ?? 500,
          section: machine.section,
          createdAt: stamp,
          updatedAt: stamp,
        });
        equipmentCreated++;
        audit({
          user: ctx.user, ip: ctx.ip, action: 'equipment.create',
          entity: 'equipment', entityId: equipmentId,
          detail: `Created from workbook ${plan.fileName} on ${rig.rigNumber}`,
          newValue: { name: machine.name, serialNumber: machine.serial },
        });
      } else {
        before = db
          .prepare<[string], EquipmentRow>(`
            SELECT id, rigId, name, nameKey, serialNumber, serialKey, model, manufacturer, category,
                   currentRunningHours, lastServiceHours, serviceInterval, isBreakdown, section
            FROM equipment WHERE id = ?
          `)
          .get(equipmentId);
      }

      for (const row of machine.rows) {
        insertRow.run({
          id: newId('row'),
          uploadId,
          equipmentId,
          rigId: rig.id,
          ...row,
        });
        recordsImported++;
      }

      // Step 6: write the register back from the latest real day.
      const update = machine.update;
      if (update) {
        const current = db
          .prepare<[string], EquipmentRow>(`
            SELECT id, rigId, name, nameKey, serialNumber, serialKey, model, manufacturer, category,
                   currentRunningHours, lastServiceHours, serviceInterval, isBreakdown, section
            FROM equipment WHERE id = ?
          `)
          .get(equipmentId)!;

        const next = {
          currentRunningHours: update.currentRunningHours ?? current.currentRunningHours,
          // Both written back from the workbook, which is what stopped machines
          // measuring against a zero baseline (defect D5).
          lastServiceHours: update.lastServiceHours ?? current.lastServiceHours,
          serviceInterval: update.serviceInterval ?? current.serviceInterval,
          model: machine.makeModel ?? current.model,
          serialNumber: machine.serial ?? current.serialNumber,
        };
        const status = equipmentStatus({
          currentRunningHours: next.currentRunningHours,
          lastServiceHours: next.lastServiceHours,
          serviceInterval: next.serviceInterval,
          isBreakdown: !!current.isBreakdown,
        });

        db.prepare(`
          UPDATE equipment SET currentRunningHours = @currentRunningHours,
                 lastServiceHours = @lastServiceHours, serviceInterval = @serviceInterval,
                 model = @model, serialNumber = @serialNumber, serialKey = @serialKey,
                 status = @status, updatedAt = @updatedAt
          WHERE id = @id
        `).run({
          id: equipmentId,
          ...next,
          serialKey: next.serialNumber ? require_serialKey(next.serialNumber) : null,
          status,
          updatedAt: nowIso(),
        });

        // A machine that has just crossed into Overdue or Upcoming raises a
        // notification, once per machine per day, from real stored figures.
        if (status === 'Overdue' || status === 'Upcoming') {
          const remaining = Math.round(
            next.serviceInterval - (next.currentRunningHours - next.lastServiceHours),
          );
          const existing = db
            .prepare<[string, string, string], { id: string }>(
              'SELECT id FROM notifications WHERE equipmentId = ? AND date = ? AND type = ?',
            )
            .get(equipmentId, update.latestDate, `service.${status.toLowerCase()}`);
          if (!existing) {
            db.prepare(`
              INSERT INTO notifications (id, type, message, equipmentId, rigId, date, isRead, severity)
              VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            `).run(
              newId('ntf'),
              `service.${status.toLowerCase()}`,
              status === 'Overdue'
                ? `${machine.name} on ${rig.rigNumber} is overdue for service by ${Math.abs(remaining)} hours.`
                : `${machine.name} on ${rig.rigNumber} is due for service in ${remaining} hours.`,
              equipmentId,
              rig.id,
              update.latestDate,
              status === 'Overdue' ? 'critical' : 'warning',
            );
          }
        }

        const changed = auditDiff(
          {
            user: ctx.user, ip: ctx.ip, action: 'equipment.update.import',
            entity: 'equipment', entityId: equipmentId,
            detail: `From ${plan.fileName}, day ${update.latestDay}`,
          },
          (before ?? current) as unknown as Record<string, unknown>,
          {
            currentRunningHours: next.currentRunningHours,
            lastServiceHours: next.lastServiceHours,
            serviceInterval: next.serviceInterval,
            status,
          },
        );
        if (changed > 0) equipmentUpdated++;

        db.prepare(`
          INSERT INTO equipment_history
            (id, equipmentId, date, runningHours, addedHours, runningSinceLastService,
             remainingServiceHours, remarks, uploadId, updatedBy)
          VALUES (@id, @equipmentId, @date, @runningHours, @addedHours, @runningSinceLastService,
                  @remainingServiceHours, @remarks, @uploadId, @updatedBy)
        `).run({
          id: newId('hist'),
          equipmentId,
          date: update.latestDate,
          runningHours: next.currentRunningHours,
          addedHours: Math.round(next.currentRunningHours - (current.currentRunningHours ?? 0)),
          runningSinceLastService: Math.round(next.currentRunningHours - next.lastServiceHours),
          remainingServiceHours: Math.round(
            next.serviceInterval - (next.currentRunningHours - next.lastServiceHours),
          ),
          remarks: `Imported from ${plan.fileName} (day ${update.latestDay})`,
          uploadId,
          updatedBy: ctx.user,
        });
      }
    }

    db.prepare('UPDATE mechanical_log_uploads SET recordsImported = ? WHERE id = ?')
      .run(recordsImported, uploadId);

    audit({
      user: ctx.user, ip: ctx.ip, action: 'upload.import',
      entity: 'mechanical_log_uploads', entityId: uploadId,
      detail: `${plan.fileName} -> ${rig.rigNumber}: ${recordsImported} rows, ` +
        `${equipmentCreated} machines created, ${equipmentUpdated} updated`,
    });

    // The Rig Sheet requirement for each date this upload actually covers is
    // now satisfied; resolve (never delete) any pending notification for it.
    resolveRigSheetPending(rig.id, coverage);

    return {
      uploadId,
      rigId: rig.id,
      recordsImported,
      equipmentCreated,
      equipmentUpdated,
      replacedUploadId: replaceId,
    };
  });
}

/** Normalised serial, or null when the workbook left it blank. */
function require_serialKey(v: string): string | null {
  const k = _serialKey(v);
  return k === '' ? null : k;
}
