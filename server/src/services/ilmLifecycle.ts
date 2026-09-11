import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { badRequest, notFound, HttpError } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { resolveContractDuration } from './ilmContractDuration.js';

/**
 * An ILM is a long-lived rig-relocation project (Active -> Completed), not a
 * single day's movement. This module owns everything about that lifecycle:
 * starting one, appending Trailer Movement rounds / Crane Rounds / Delay-Fuel
 * lines to it over however many weeks or months it runs, and ending it.
 *
 * Every child table still carries `transactionId` directly (the ILM's id),
 * exactly as before this redesign — only a new grouping id (`movementId` /
 * `roundId`) was added on top, so every existing fleet/rig-wide report that
 * already reads "every row for this ILM" keeps working unchanged and now
 * correctly includes every round instead of just one.
 */

export interface IlmHeaderInput {
  area: string | null;
  operatorName: string | null;
  wellNo: string | null;
  movementFromWell: string | null;
  movementToWell: string | null;
  releaseDate: string | null;
  releaseTime: string | null;
  spudDate: string | null;
  spudTime: string | null;
  ilmRatePerDay: number | null;
  ilmExpenses: number | null;
  /** Optional so every pre-existing caller (tests, demo data, Excel import) that predates the Contract Date fields keeps compiling unchanged; createIlm()/updateIlmHeader() both default a missing value to null. */
  contractDateFrom?: string | null;
  contractDateTo?: string | null;
  /** Header-level ILM Contract Duration Rules preview input — separate from any Trailer Movement round's own leadDistanceKm. Optional for the same reason as the Contract Date fields above. */
  movementDistanceKm?: number | null;
}

export interface Ctx { user: string; ip: string | null }

interface TransactionRow { id: string; rigId: string; status: string; ilmNumber: string }

function getTransaction(id: string): TransactionRow {
  const row = db.prepare<[string], TransactionRow>(
    'SELECT id, rigId, status, ilmNumber FROM ilm_transactions WHERE id = ?',
  ).get(id);
  if (!row) throw notFound('That ILM does not exist.');
  return row;
}

/** Every mutation below (except createIlm/endIlm/reopenIlm themselves) goes through this guard. */
export function assertIlmEditable(transactionId: string): TransactionRow {
  const row = getTransaction(transactionId);
  if (row.status !== 'Active') {
    throw new HttpError(403, 'This ILM is completed and locked. Reopen it (Admin) before adding to it.');
  }
  return row;
}

function nextIlmNumber(): string {
  const year = new Date().getFullYear();
  const prefix = `ILM-${year}-`;
  const row = db.prepare<[string], { maxNum: string | null }>(
    'SELECT MAX(ilmNumber) AS maxNum FROM ilm_transactions WHERE ilmNumber LIKE ?',
  ).get(`${prefix}%`);
  const lastSeq = row?.maxNum ? Number(row.maxNum.slice(prefix.length)) : 0;
  return `${prefix}${String(lastSeq + 1).padStart(5, '0')}`;
}

export function findActiveIlm(rigId: string): { id: string; ilmNumber: string } | null {
  return db.prepare<[string], { id: string; ilmNumber: string }>(
    "SELECT id, ilmNumber FROM ilm_transactions WHERE rigId = ? AND status = 'Active'",
  ).get(rigId) ?? null;
}

/** Requirement 9: block a second Active ILM for the same rig, pointing at the existing one. */
function assertNoActiveIlm(rigId: string): void {
  const existing = findActiveIlm(rigId);
  if (existing) {
    throw new HttpError(409,
      'An active ILM already exists for this Rig. Please continue the existing ILM.',
      { activeTransactionId: existing.id, activeIlmNumber: existing.ilmNumber });
  }
}

/**
 * ILM Contract Duration Rules, resolved for the ILM header itself (below
 * Release Date/Time on ILM Add) — separate from a Trailer Movement round's
 * own resolution in addTrailerMovement(), but the exact same resolver
 * function, never a second implementation of the math. Called every time the
 * header is saved (create or a later edit) with a distance present, and the
 * result is frozen onto ilm_individual — a passive rule change elsewhere
 * never recalculates an already-saved header; only the user's own next save
 * (with a still-present distance) does.
 */
function resolveHeaderContract(rigId: string, movementDistanceKm: number | null | undefined): {
  contractAllowedHours: number | null; contractAllowedDays: number | null; contractRuleId: string | null;
} {
  if (movementDistanceKm === null || movementDistanceKm === undefined) {
    return { contractAllowedHours: null, contractAllowedDays: null, contractRuleId: null };
  }
  const resolved = resolveContractDuration(rigId, movementDistanceKm);
  return {
    contractAllowedHours: resolved.allowedHours, contractAllowedDays: resolved.contractDays,
    contractRuleId: resolved.rule?.id ?? null,
  };
}

export function createIlm(input: {
  rigId: string; date: string; source: 'excel' | 'manual'; importBatchId: string | null;
  individual: IlmHeaderInput; ctx: Ctx;
}): string {
  assertNoActiveIlm(input.rigId);
  return transact(() => {
    const stamp = nowIso();
    const id = newId('ilm');
    db.prepare(`
      INSERT INTO ilm_transactions (id, ilmNumber, rigId, date, source, status, importBatchId, createdBy, createdAt, updatedBy, updatedAt)
      VALUES (@id, @ilmNumber, @rigId, @date, @source, 'Active', @importBatchId, @createdBy, @createdAt, @createdBy, @createdAt)
    `).run({
      id, ilmNumber: nextIlmNumber(), rigId: input.rigId, date: input.date, source: input.source,
      importBatchId: input.importBatchId, createdBy: input.ctx.user, createdAt: stamp,
    });
    const contract = resolveHeaderContract(input.rigId, input.individual.movementDistanceKm);
    db.prepare(`
      INSERT INTO ilm_individual (transactionId, area, operatorName, wellNo, movementFromWell, movementToWell,
        releaseDate, releaseTime, spudDate, spudTime, ilmRatePerDay, ilmExpenses, contractDateFrom, contractDateTo,
        movementDistanceKm, contractAllowedHours, contractAllowedDays, contractRuleId)
      VALUES (@transactionId, @area, @operatorName, @wellNo, @movementFromWell, @movementToWell,
        @releaseDate, @releaseTime, @spudDate, @spudTime, @ilmRatePerDay, @ilmExpenses, @contractDateFrom, @contractDateTo,
        @movementDistanceKm, @contractAllowedHours, @contractAllowedDays, @contractRuleId)
    `).run({
      transactionId: id, ...input.individual,
      contractDateFrom: input.individual.contractDateFrom ?? null, contractDateTo: input.individual.contractDateTo ?? null,
      movementDistanceKm: input.individual.movementDistanceKm ?? null, ...contract,
    });

    audit({
      user: input.ctx.user, ip: input.ctx.ip, action: 'ilm.create',
      entity: 'ilm_transactions', entityId: id, detail: `Started, source ${input.source}`,
    });
    return id;
  });
}

export function updateIlmHeader(transactionId: string, individual: IlmHeaderInput, ctx: Ctx): void {
  assertIlmEditable(transactionId);
  const txn = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(transactionId)!;
  const contract = resolveHeaderContract(txn.rigId, individual.movementDistanceKm);
  db.prepare(`
    UPDATE ilm_individual SET area=@area, operatorName=@operatorName, wellNo=@wellNo,
      movementFromWell=@movementFromWell, movementToWell=@movementToWell,
      releaseDate=@releaseDate, releaseTime=@releaseTime, spudDate=@spudDate, spudTime=@spudTime,
      ilmRatePerDay=@ilmRatePerDay, ilmExpenses=@ilmExpenses,
      contractDateFrom=@contractDateFrom, contractDateTo=@contractDateTo,
      movementDistanceKm=@movementDistanceKm, contractAllowedHours=@contractAllowedHours,
      contractAllowedDays=@contractAllowedDays, contractRuleId=@contractRuleId
    WHERE transactionId=@transactionId
  `).run({
    transactionId, ...individual,
    contractDateFrom: individual.contractDateFrom ?? null, contractDateTo: individual.contractDateTo ?? null,
    movementDistanceKm: individual.movementDistanceKm ?? null, ...contract,
  });
  db.prepare('UPDATE ilm_transactions SET updatedBy=?, updatedAt=? WHERE id=?').run(ctx.user, nowIso(), transactionId);
  audit({ user: ctx.user, ip: ctx.ip, action: 'ilm.update', entity: 'ilm_transactions', entityId: transactionId });
}

/* ---------------------------- delay / fuel lines ---------------------------- */

export interface DelayLineInput {
  reasonForDelay: string | null; totalDelayHours: number | null;
  hsdStockAccession: number | null; receivedQtyDuringIlm: number | null; hsdStockShiftEnd: number | null;
  ilmDistanceKm: number | null; totalLoadsMoved: number | null; cumulativeTrailerKm: number | null;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Delay/Fuel is the one child list that stays a whole-list replace while
 * Active (like before this redesign) — it was already many-per-ILM, and
 * isn't part of the "never overwrite a round's history" requirement, which
 * applies only to Trailer Movements and Crane Rounds.
 */
export function setDelayLines(transactionId: string, lines: DelayLineInput[], ctx: Ctx): void {
  assertIlmEditable(transactionId);
  transact(() => {
    db.prepare('DELETE FROM ilm_individual_lines WHERE transactionId = ?').run(transactionId);
    const insert = db.prepare(`
      INSERT INTO ilm_individual_lines (id, transactionId, lineNo, reasonForDelay, totalDelayHours, hsdStockAccession,
        receivedQtyDuringIlm, hsdStockShiftEnd, totalHsdConsumption, ilmDistanceKm, totalLoadsMoved, cumulativeTrailerKm, avgConsumptionPerKm)
      VALUES (@id, @transactionId, @lineNo, @reasonForDelay, @totalDelayHours, @hsdStockAccession,
        @receivedQtyDuringIlm, @hsdStockShiftEnd, @totalHsdConsumption, @ilmDistanceKm, @totalLoadsMoved, @cumulativeTrailerKm, @avgConsumptionPerKm)
    `);
    lines.forEach((l, i) => {
      const totalHsdConsumption = l.hsdStockAccession !== null && l.receivedQtyDuringIlm !== null && l.hsdStockShiftEnd !== null
        ? round2(l.hsdStockAccession + l.receivedQtyDuringIlm - l.hsdStockShiftEnd) : null;
      const avgConsumptionPerKm = totalHsdConsumption !== null && l.ilmDistanceKm !== null && l.ilmDistanceKm !== 0
        ? round2(totalHsdConsumption / l.ilmDistanceKm) : null;
      insert.run({ id: newId('ilmindl'), transactionId, lineNo: i + 1, ...l, totalHsdConsumption, avgConsumptionPerKm });
    });
    db.prepare('UPDATE ilm_transactions SET updatedBy=?, updatedAt=? WHERE id=?').run(ctx.user, nowIso(), transactionId);
    audit({
      user: ctx.user, ip: ctx.ip, action: 'ilm.delayLines.set', entity: 'ilm_transactions', entityId: transactionId,
      detail: `${lines.length} delay/fuel line(s)`,
    });
  });
}

/**
 * Excel import always appends new delay/fuel rows (never replaces existing
 * ones) — each import represents new activity added to the ongoing ILM, not
 * a correction of what's already there.
 */
export function appendDelayLines(transactionId: string, lines: DelayLineInput[], ctx: Ctx): void {
  assertIlmEditable(transactionId);
  const countRow = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM ilm_individual_lines WHERE transactionId = ?',
  ).get(transactionId)!;
  const insert = db.prepare(`
    INSERT INTO ilm_individual_lines (id, transactionId, lineNo, reasonForDelay, totalDelayHours, hsdStockAccession,
      receivedQtyDuringIlm, hsdStockShiftEnd, totalHsdConsumption, ilmDistanceKm, totalLoadsMoved, cumulativeTrailerKm, avgConsumptionPerKm)
    VALUES (@id, @transactionId, @lineNo, @reasonForDelay, @totalDelayHours, @hsdStockAccession,
      @receivedQtyDuringIlm, @hsdStockShiftEnd, @totalHsdConsumption, @ilmDistanceKm, @totalLoadsMoved, @cumulativeTrailerKm, @avgConsumptionPerKm)
  `);
  lines.forEach((l, i) => {
    const totalHsdConsumption = l.hsdStockAccession !== null && l.receivedQtyDuringIlm !== null && l.hsdStockShiftEnd !== null
      ? round2(l.hsdStockAccession + l.receivedQtyDuringIlm - l.hsdStockShiftEnd) : null;
    const avgConsumptionPerKm = totalHsdConsumption !== null && l.ilmDistanceKm !== null && l.ilmDistanceKm !== 0
      ? round2(totalHsdConsumption / l.ilmDistanceKm) : null;
    insert.run({ id: newId('ilmindl'), transactionId, lineNo: countRow.n + i + 1, ...l, totalHsdConsumption, avgConsumptionPerKm });
  });
  audit({
    user: ctx.user, ip: ctx.ip, action: 'ilm.delayLines.append', entity: 'ilm_transactions', entityId: transactionId,
    detail: `${lines.length} delay/fuel line(s) appended`,
  });
}

/* ---------------------------- trailer movements ---------------------------- */

export interface TrailerMovementInput {
  fleetReportAt: string | null;
  leadDistanceKm: number | null;
  allowedDurationHrs: number | null;
  /** Only used by Excel import, which supplies its own explicit header rather than snapshotting from ilm_individual. */
  explicitHeader?: { rigName: string | null; oldLocation: string | null; newLocation: string | null; rigReleaseAt: string | null };
}

export interface AddTrailerMovementResult {
  id: string;
  /** True when a distance was given but this rig has no matching Active Contract Duration Rule — the caller entered/kept Allowed Duration manually. */
  contractWarning: boolean;
}

/**
 * Requirement 1: Old/New Location and Rig Release Date&Time are snapshotted
 * from the ILM header at creation time — never a live reference.
 *
 * ILM Contract Duration Rules: for a manually-entered movement (no
 * explicitHeader — that path is Excel import, which supplies its own
 * imported Allowed Duration and is left untouched), the rig's matching
 * Active distance-band rule is resolved ONCE here from leadDistanceKm and
 * frozen onto allowedDurationHrs/contractDays/contractRuleId. Editing or
 * deactivating that rule afterward never recalculates this row — the same
 * freeze discipline as the header snapshot above. No rule ever means no
 * calculation is attempted; the caller's own allowedDurationHrs (or null)
 * is kept as-is and a warning is surfaced instead.
 */
export function addTrailerMovement(transactionId: string, input: TrailerMovementInput, ctx: Ctx): AddTrailerMovementResult {
  assertIlmEditable(transactionId);
  return transact(() => {
    const header = input.explicitHeader ?? (() => {
      const ind = db.prepare<[string], {
        movementFromWell: string | null; movementToWell: string | null; releaseDate: string | null; releaseTime: string | null;
      }>('SELECT movementFromWell, movementToWell, releaseDate, releaseTime FROM ilm_individual WHERE transactionId = ?').get(transactionId);
      const rigReleaseAt = ind?.releaseDate
        ? `${ind.releaseDate}${ind.releaseTime ? ` ${ind.releaseTime}` : ''}`
        : null;
      return { rigName: null, oldLocation: ind?.movementFromWell ?? null, newLocation: ind?.movementToWell ?? null, rigReleaseAt };
    })();

    let allowedDurationHrs = input.allowedDurationHrs;
    let contractDays: number | null = null;
    let contractRuleId: string | null = null;
    let contractWarning = false;
    if (!input.explicitHeader) {
      const txn = db.prepare<[string], { rigId: string }>('SELECT rigId FROM ilm_transactions WHERE id = ?').get(transactionId)!;
      const resolved = resolveContractDuration(txn.rigId, input.leadDistanceKm);
      if (resolved.rule) {
        allowedDurationHrs = resolved.allowedHours;
        contractDays = resolved.contractDays;
        contractRuleId = resolved.rule.id;
      } else if (input.leadDistanceKm !== null) {
        contractWarning = true;
      }
    }

    const countRow = db.prepare<[string], { n: number }>(
      'SELECT COUNT(*) AS n FROM ilm_trailer_movements WHERE transactionId = ?',
    ).get(transactionId)!;
    const id = newId('ilmmvt');
    const stamp = nowIso();
    db.prepare(`
      INSERT INTO ilm_trailer_movements (id, transactionId, movementNo, rigName, oldLocation, newLocation,
        leadDistanceKm, rigReleaseAt, fleetReportAt, allowedDurationHrs, contractDays, contractRuleId, createdBy, createdAt)
      VALUES (@id, @transactionId, @movementNo, @rigName, @oldLocation, @newLocation,
        @leadDistanceKm, @rigReleaseAt, @fleetReportAt, @allowedDurationHrs, @contractDays, @contractRuleId, @createdBy, @createdAt)
    `).run({
      id, transactionId, movementNo: countRow.n + 1, ...header,
      leadDistanceKm: input.leadDistanceKm, fleetReportAt: input.fleetReportAt, allowedDurationHrs, contractDays, contractRuleId,
      createdBy: ctx.user, createdAt: stamp,
    });
    audit({
      user: ctx.user, ip: ctx.ip, action: 'ilm.trailerMovement.create',
      entity: 'ilm_trailer_movements', entityId: id, detail: `Movement #${countRow.n + 1} on ILM ${transactionId}`,
    });
    return { id, contractWarning };
  });
}

function getMovementOwner(movementId: string): { transactionId: string } {
  const row = db.prepare<[string], { transactionId: string }>(
    'SELECT transactionId FROM ilm_trailer_movements WHERE id = ?',
  ).get(movementId);
  if (!row) throw notFound('That Trailer Movement does not exist.');
  return row;
}

export interface TrailerLoadInput {
  mtGatePassNo: string | null; trailerNo: string | null; equipmentId: string | null; trailerType: string | null; capacityTon: number | null;
  arrivalDate: string | null; arrivalTime: string | null; loadingDate: string | null; loadingTime: string | null;
  loadDescription: string | null; totalPackages: number | null; unloadingDate: string | null; unloadingTime: string | null;
  driverName: string | null; driverContact: string | null;
}

/** Requirement 2: Sr No is always server-assigned (1, 2, 3…), scoped to the movement — never accepted from the client. */
export function addTrailerLoad(movementId: string, input: TrailerLoadInput, ctx: Ctx): string {
  const { transactionId } = getMovementOwner(movementId);
  assertIlmEditable(transactionId);
  const countRow = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM ilm_trailer_loads WHERE movementId = ?',
  ).get(movementId)!;
  const nextNo = countRow.n + 1;
  const id = newId('ilmtrl');
  db.prepare(`
    INSERT INTO ilm_trailer_loads (id, transactionId, movementId, lineNo, srNo, mtGatePassNo, trailerNo, equipmentId, trailerType,
      capacityTon, arrivalDate, arrivalTime, loadingDate, loadingTime, loadDescription, totalPackages,
      unloadingDate, unloadingTime, driverName, driverContact)
    VALUES (@id, @transactionId, @movementId, @lineNo, @srNo, @mtGatePassNo, @trailerNo, @equipmentId, @trailerType,
      @capacityTon, @arrivalDate, @arrivalTime, @loadingDate, @loadingTime, @loadDescription, @totalPackages,
      @unloadingDate, @unloadingTime, @driverName, @driverContact)
  `).run({
    // Spread first, then force id/transactionId/movementId/lineNo/srNo — even
    // an input object smuggling its own srNo (bypassing the type) can never
    // win, so "always server-assigned" holds regardless of the caller.
    ...input, id, transactionId, movementId, lineNo: nextNo, srNo: String(nextNo),
  });
  audit({ user: ctx.user, ip: ctx.ip, action: 'ilm.trailerLoad.create', entity: 'ilm_trailer_loads', entityId: id });
  return id;
}

export function updateTrailerLoad(loadId: string, patch: TrailerLoadInput, ctx: Ctx): void {
  const row = db.prepare<[string], { transactionId: string }>(
    'SELECT transactionId FROM ilm_trailer_loads WHERE id = ?',
  ).get(loadId);
  if (!row) throw notFound('That trailer load does not exist.');
  assertIlmEditable(row.transactionId);
  db.prepare(`
    UPDATE ilm_trailer_loads SET mtGatePassNo=@mtGatePassNo, trailerNo=@trailerNo, equipmentId=@equipmentId, trailerType=@trailerType,
      capacityTon=@capacityTon, arrivalDate=@arrivalDate, arrivalTime=@arrivalTime, loadingDate=@loadingDate,
      loadingTime=@loadingTime, loadDescription=@loadDescription, totalPackages=@totalPackages,
      unloadingDate=@unloadingDate, unloadingTime=@unloadingTime, driverName=@driverName, driverContact=@driverContact
    WHERE id=@id
  `).run({ id: loadId, ...patch });
  audit({ user: ctx.user, ip: ctx.ip, action: 'ilm.trailerLoad.update', entity: 'ilm_trailer_loads', entityId: loadId });
}

export function deleteTrailerLoad(loadId: string, ctx: Ctx): void {
  const row = db.prepare<[string], { transactionId: string }>(
    'SELECT transactionId FROM ilm_trailer_loads WHERE id = ?',
  ).get(loadId);
  if (!row) throw notFound('That trailer load does not exist.');
  assertIlmEditable(row.transactionId);
  db.prepare('DELETE FROM ilm_trailer_loads WHERE id = ?').run(loadId);
  audit({ user: ctx.user, ip: ctx.ip, action: 'ilm.trailerLoad.delete', entity: 'ilm_trailer_loads', entityId: loadId });
}

/* ---------------------------- crane rounds ---------------------------- */

export interface CraneRoundInput {
  /** User-entered, editable at Add-Round time. Prefilled from the ILM header's Current/Next Well as a starting suggestion, but the Rig User can overwrite either before saving. */
  oldLocation: string | null;
  newLocation: string | null;
  /**
   * The Add Crane Round form's "Location" dropdown — 'Old Location' (no
   * change; newLocation is not required) or 'New Location' (the Rig User
   * must type where it moved to, via "Enter New Location"). Purely a record
   * of which the form had selected; oldLocation's own value/prefill logic is
   * untouched by this.
   */
  locationType?: string | null;
}

/** Old/New Location default from the ILM header (Current/Next Well) but the Rig User can type over either before saving — once saved, a round's value is fixed and never changes if the header is edited later. */
export function addCraneRound(transactionId: string, input: CraneRoundInput, ctx: Ctx): string {
  assertIlmEditable(transactionId);
  if (input.locationType === 'New Location' && !input.newLocation?.trim()) {
    throw badRequest('Enter the new location.');
  }
  const countRow = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM ilm_crane_rounds WHERE transactionId = ?',
  ).get(transactionId)!;
  let oldLocation = input.oldLocation;
  let newLocation = input.newLocation;
  if (oldLocation === null || newLocation === null) {
    const ind = db.prepare<[string], { movementFromWell: string | null; movementToWell: string | null }>(
      'SELECT movementFromWell, movementToWell FROM ilm_individual WHERE transactionId = ?',
    ).get(transactionId);
    oldLocation = oldLocation ?? ind?.movementFromWell ?? null;
    newLocation = newLocation ?? ind?.movementToWell ?? null;
  }
  const id = newId('ilmrnd');
  db.prepare(`
    INSERT INTO ilm_crane_rounds (id, transactionId, roundNo, oldLocation, newLocation, locationType, createdBy, createdAt)
    VALUES (@id, @transactionId, @roundNo, @oldLocation, @newLocation, @locationType, @createdBy, @createdAt)
  `).run({
    id, transactionId, roundNo: countRow.n + 1, oldLocation, newLocation,
    locationType: input.locationType || null, createdBy: ctx.user, createdAt: nowIso(),
  });
  audit({
    user: ctx.user, ip: ctx.ip, action: 'ilm.craneRound.create',
    entity: 'ilm_crane_rounds', entityId: id, detail: `Round #${countRow.n + 1} on ILM ${transactionId}`,
  });
  return id;
}

function getRoundOwner(roundId: string): { transactionId: string } {
  const row = db.prepare<[string], { transactionId: string }>(
    'SELECT transactionId FROM ilm_crane_rounds WHERE id = ?',
  ).get(roundId);
  if (!row) throw notFound('That Crane Round does not exist.');
  return row;
}

export interface CraneRecordInput {
  craneNo: string | null; equipmentId: string | null; capacityTon: number | null; reportingDate: string | null; rigOrHired: string | null;
  registrationNo: string | null; arrivedDate: string | null; arrivedTime: string | null;
  releaseDate: string | null; releaseTime: string | null; transporterName: string | null;
  dayNo: number | null; shiftDate: string | null; dayShiftHrs: number | null; detailsJobDay: string | null;
  nightShiftHrs: number | null; detailsJobNight: string | null; breakdownHrs: number | null;
  cumulativeHrs: number | null; issuedHsdLtrs: number | null; totalWorkingHrs: number | null;
}

export function addCraneRecord(roundId: string, input: CraneRecordInput, ctx: Ctx): string {
  const { transactionId } = getRoundOwner(roundId);
  assertIlmEditable(transactionId);
  const countRow = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) AS n FROM ilm_cranes WHERE roundId = ?',
  ).get(roundId)!;
  const id = newId('ilmcrn');
  db.prepare(`
    INSERT INTO ilm_cranes (id, transactionId, roundId, lineNo, craneNo, equipmentId, capacityTon, reportingDate, rigOrHired,
      registrationNo, arrivedDate, arrivedTime, releaseDate, releaseTime, transporterName, dayNo, shiftDate,
      dayShiftHrs, detailsJobDay, nightShiftHrs, detailsJobNight, breakdownHrs, cumulativeHrs, issuedHsdLtrs, totalWorkingHrs)
    VALUES (@id, @transactionId, @roundId, @lineNo, @craneNo, @equipmentId, @capacityTon, @reportingDate, @rigOrHired,
      @registrationNo, @arrivedDate, @arrivedTime, @releaseDate, @releaseTime, @transporterName, @dayNo, @shiftDate,
      @dayShiftHrs, @detailsJobDay, @nightShiftHrs, @detailsJobNight, @breakdownHrs, @cumulativeHrs, @issuedHsdLtrs, @totalWorkingHrs)
  `).run({ ...input, id, transactionId, roundId, lineNo: countRow.n + 1 });
  audit({ user: ctx.user, ip: ctx.ip, action: 'ilm.craneRecord.create', entity: 'ilm_cranes', entityId: id });
  return id;
}

export function updateCraneRecord(craneId: string, patch: CraneRecordInput, ctx: Ctx): void {
  const row = db.prepare<[string], { transactionId: string }>(
    'SELECT transactionId FROM ilm_cranes WHERE id = ?',
  ).get(craneId);
  if (!row) throw notFound('That crane record does not exist.');
  assertIlmEditable(row.transactionId);
  db.prepare(`
    UPDATE ilm_cranes SET craneNo=@craneNo, equipmentId=@equipmentId, capacityTon=@capacityTon, reportingDate=@reportingDate, rigOrHired=@rigOrHired,
      registrationNo=@registrationNo, arrivedDate=@arrivedDate, arrivedTime=@arrivedTime, releaseDate=@releaseDate,
      releaseTime=@releaseTime, transporterName=@transporterName, dayNo=@dayNo, shiftDate=@shiftDate,
      dayShiftHrs=@dayShiftHrs, detailsJobDay=@detailsJobDay, nightShiftHrs=@nightShiftHrs, detailsJobNight=@detailsJobNight,
      breakdownHrs=@breakdownHrs, cumulativeHrs=@cumulativeHrs, issuedHsdLtrs=@issuedHsdLtrs, totalWorkingHrs=@totalWorkingHrs
    WHERE id=@id
  `).run({ id: craneId, ...patch });
  audit({ user: ctx.user, ip: ctx.ip, action: 'ilm.craneRecord.update', entity: 'ilm_cranes', entityId: craneId });
}

export function deleteCraneRecord(craneId: string, ctx: Ctx): void {
  const row = db.prepare<[string], { transactionId: string }>(
    'SELECT transactionId FROM ilm_cranes WHERE id = ?',
  ).get(craneId);
  if (!row) throw notFound('That crane record does not exist.');
  assertIlmEditable(row.transactionId);
  db.prepare('DELETE FROM ilm_cranes WHERE id = ?').run(craneId);
  audit({ user: ctx.user, ip: ctx.ip, action: 'ilm.craneRecord.delete', entity: 'ilm_cranes', entityId: craneId });
}

/* ---------------------------- delay records ---------------------------- */

/**
 * The automatic Delay popup's submission — kept entirely separate from
 * ilm_individual_lines (Fuel Log), which no longer collects Reason for
 * Delay/Delay Hours from the UI. Append-only: every popup submission is
 * its own permanent record, never overwriting a previous one.
 */
export interface DelayRecordInput {
  reasonForDelay: string;
  otherReason: string | null;
  delayHours: number | null;
  remarks: string | null;
}

export function addDelayRecord(transactionId: string, input: DelayRecordInput, ctx: Ctx): string {
  assertIlmEditable(transactionId);
  if (!input.reasonForDelay?.trim()) throw badRequest('Select a reason for the delay.');
  const id = newId('ilmdly');
  db.prepare(`
    INSERT INTO ilm_delay_records (id, transactionId, reasonForDelay, otherReason, delayHours, remarks, createdBy, createdAt)
    VALUES (@id, @transactionId, @reasonForDelay, @otherReason, @delayHours, @remarks, @createdBy, @createdAt)
  `).run({ id, transactionId, ...input, createdBy: ctx.user, createdAt: nowIso() });
  audit({ user: ctx.user, ip: ctx.ip, action: 'ilm.delayRecord.create', entity: 'ilm_delay_records', entityId: id });
  return id;
}

/* ---------------------------- end / reopen ---------------------------- */

/** Requirement 7: locks the ILM, stamping end date/time and total duration. Every historical round/record is untouched. */
export function endIlm(transactionId: string, ctx: Ctx): void {
  const row = assertIlmEditable(transactionId);
  const created = db.prepare<[string], { createdAt: string }>(
    'SELECT createdAt FROM ilm_transactions WHERE id = ?',
  ).get(transactionId)!;
  const now = new Date();
  const completedAt = now.toISOString();
  const durationHours = round2((now.getTime() - new Date(created.createdAt).getTime()) / 3600000);
  const endDate = completedAt.slice(0, 10);
  const endTime = completedAt.slice(11, 16);
  db.prepare(`
    UPDATE ilm_transactions SET status='Completed', endDate=@endDate, endTime=@endTime,
      completedBy=@completedBy, completedAt=@completedAt, durationHours=@durationHours,
      updatedBy=@completedBy, updatedAt=@completedAt
    WHERE id=@id
  `).run({ id: transactionId, endDate, endTime, completedBy: ctx.user, completedAt, durationHours });
  audit({
    user: ctx.user, ip: ctx.ip, action: 'ilm.end', entity: 'ilm_transactions', entityId: transactionId,
    detail: `Completed after ${durationHours}h (ILM ${row.ilmNumber})`,
  });
}

/** Admin-only escape hatch (requirement 8). Re-checks the one-Active-ILM-per-rig rule before reopening. */
export function reopenIlm(transactionId: string, ctx: Ctx): void {
  const row = getTransaction(transactionId);
  if (row.status !== 'Completed') throw badRequest('Only a completed ILM can be reopened.');
  assertNoActiveIlm(row.rigId);
  db.prepare(`
    UPDATE ilm_transactions SET status='Active', endDate=NULL, endTime=NULL, completedBy=NULL, completedAt=NULL,
      durationHours=NULL, updatedBy=@user, updatedAt=@now
    WHERE id=@id
  `).run({ id: transactionId, user: ctx.user, now: nowIso() });
  audit({ user: ctx.user, ip: ctx.ip, action: 'ilm.reopen', entity: 'ilm_transactions', entityId: transactionId });
}
