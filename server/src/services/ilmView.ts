import { db } from '../db/index.js';

/**
 * The single place an ILM transaction (and its individual/trailer/crane
 * children) becomes the shape the API returns — mirrors services/dprView.ts.
 * Used identically whether the transaction came from an Excel import or
 * manual entry; nothing downstream can tell the difference except `source`.
 */

export interface IlmIndividualView {
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
  contractDateFrom: string | null;
  contractDateTo: string | null;
  /** ILM Contract Duration Rules preview, frozen at the moment this header was last saved with a distance present. */
  movementDistanceKm: number | null;
  contractAllowedHours: number | null;
  contractAllowedDays: number | null;
  contractRuleId: string | null;
}

export interface IlmDelayRecordView {
  id: string;
  reasonForDelay: string;
  otherReason: string | null;
  delayHours: number | null;
  remarks: string | null;
  createdBy: string;
  createdAt: string;
}

export interface IlmIndividualLineView {
  id: string;
  lineNo: number;
  reasonForDelay: string | null;
  totalDelayHours: number | null;
  hsdStockAccession: number | null;
  receivedQtyDuringIlm: number | null;
  hsdStockShiftEnd: number | null;
  totalHsdConsumption: number | null;
  ilmDistanceKm: number | null;
  totalLoadsMoved: number | null;
  cumulativeTrailerKm: number | null;
  avgConsumptionPerKm: number | null;
}

export interface IlmTrailerHeaderView {
  rigName: string | null;
  oldLocation: string | null;
  newLocation: string | null;
  leadDistanceKm: number | null;
  rigReleaseAt: string | null;
  fleetReportAt: string | null;
  allowedDurationHrs: number | null;
  /** Both frozen at movement-creation time from the rig's matching Contract Duration Rule — null when none matched (manual Allowed Duration was used instead). */
  contractDays: number | null;
  contractRuleId: string | null;
}

export interface IlmTrailerMovementView extends IlmTrailerHeaderView {
  id: string;
  movementNo: number;
  createdBy: string;
  createdAt: string;
  loads: IlmTrailerLoadView[];
}

export interface IlmCraneRoundView {
  id: string;
  roundNo: number;
  oldLocation: string | null;
  newLocation: string | null;
  /** Which the Add Crane Round form's "Location" dropdown had selected — 'Old Location' | 'New Location' | null (rows predating the dropdown). */
  locationType: string | null;
  createdBy: string;
  createdAt: string;
  records: IlmCraneView[];
}

export interface IlmTrailerLoadView {
  id: string;
  lineNo: number;
  srNo: string | null;
  mtGatePassNo: string | null;
  trailerNo: string | null;
  /** Optional link to the central Equipment Master (category 'Trailer'); null when trailerNo is a free-text/historical label instead. */
  equipmentId: string | null;
  trailerType: string | null;
  capacityTon: number | null;
  arrivalDate: string | null;
  arrivalTime: string | null;
  loadingDate: string | null;
  loadingTime: string | null;
  loadDescription: string | null;
  totalPackages: number | null;
  unloadingDate: string | null;
  unloadingTime: string | null;
  driverName: string | null;
  driverContact: string | null;
}

export interface IlmCraneView {
  id: string;
  lineNo: number;
  craneNo: string | null;
  /** Optional link to the central Equipment Master (category 'Crane'); null when craneNo is a free-text/historical label instead. */
  equipmentId: string | null;
  capacityTon: number | null;
  reportingDate: string | null;
  rigOrHired: string | null;
  registrationNo: string | null;
  arrivedDate: string | null;
  arrivedTime: string | null;
  transporterName: string | null;
  dayNo: number | null;
  shiftDate: string | null;
  dayShiftHrs: number | null;
  detailsJobDay: string | null;
  nightShiftHrs: number | null;
  detailsJobNight: string | null;
  breakdownHrs: number | null;
  cumulativeHrs: number | null;
  issuedHsdLtrs: number | null;
  totalWorkingHrs: number | null;
}

export interface IlmTransactionSummary {
  id: string;
  ilmNumber: string;
  rigId: string;
  rigNumber: string;
  rigName: string;
  date: string;
  source: string;
  /** 'Active' | 'Completed' — an ILM can run for months before someone ends it. */
  status: string;
  importBatchId: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  endDate: string | null;
  endTime: string | null;
  completedBy: string | null;
  completedAt: string | null;
  durationHours: number | null;
  movementFromWell: string | null;
  movementToWell: string | null;
  totalDistanceKm: number;
  totalLoadsMoved: number;
  totalHsdConsumption: number;
  trailerCount: number;
  craneCount: number;
}

export interface IlmTransactionView extends IlmTransactionSummary {
  individual: IlmIndividualView | null;
  individualLines: IlmIndividualLineView[];
  /** Every Trailer Movement round, oldest first, each with its own snapshot header and loads. */
  trailerMovements: IlmTrailerMovementView[];
  /** Every Crane Round, oldest first, each with its own records. */
  craneRounds: IlmCraneRoundView[];
  /** All rounds' loads/cranes combined, flat — unchanged shape so existing aggregation (ilmSummaryReport.ts) needs no changes. */
  trailerLoads: IlmTrailerLoadView[];
  cranes: IlmCraneView[];
  /** Every automatic Delay popup submission, oldest first. */
  delayRecords: IlmDelayRecordView[];
}

interface TxnRow {
  id: string; ilmNumber: string; rigId: string; rigNumber: string; rigName: string; date: string;
  source: string; status: string; importBatchId: string | null;
  createdBy: string; createdAt: string; updatedBy: string | null; updatedAt: string;
  endDate: string | null; endTime: string | null; completedBy: string | null; completedAt: string | null; durationHours: number | null;
}

const SELECT_TXN = `
  SELECT t.*, r.rigNumber, r.name AS rigName
  FROM ilm_transactions t
  JOIN ilm_rigs r ON r.id = t.rigId
`;

const selectIndividual = db.prepare<[string], IlmIndividualView>(
  `SELECT area, operatorName, wellNo, movementFromWell, movementToWell, releaseDate, releaseTime, spudDate, spudTime,
          ilmRatePerDay, ilmExpenses, contractDateFrom, contractDateTo,
          movementDistanceKm, contractAllowedHours, contractAllowedDays, contractRuleId
   FROM ilm_individual WHERE transactionId = ?`,
);
const selectDelayRecords = db.prepare<[string], IlmDelayRecordView>(
  'SELECT * FROM ilm_delay_records WHERE transactionId = ? ORDER BY createdAt',
);
const selectIndividualLines = db.prepare<[string], IlmIndividualLineView>(
  'SELECT * FROM ilm_individual_lines WHERE transactionId = ? ORDER BY lineNo',
);
const selectTrailerLoads = db.prepare<[string], IlmTrailerLoadView>(
  'SELECT * FROM ilm_trailer_loads WHERE transactionId = ? ORDER BY lineNo',
);
const selectCranes = db.prepare<[string], IlmCraneView>(
  'SELECT * FROM ilm_cranes WHERE transactionId = ? ORDER BY lineNo',
);
interface MovementRow extends IlmTrailerHeaderView { id: string; movementNo: number; createdBy: string; createdAt: string }
const selectTrailerMovements = db.prepare<[string], MovementRow>(
  'SELECT id, movementNo, rigName, oldLocation, newLocation, leadDistanceKm, rigReleaseAt, fleetReportAt, allowedDurationHrs, contractDays, contractRuleId, createdBy, createdAt FROM ilm_trailer_movements WHERE transactionId = ? ORDER BY movementNo',
);
const selectLoadsForMovement = db.prepare<[string], IlmTrailerLoadView>(
  'SELECT * FROM ilm_trailer_loads WHERE movementId = ? ORDER BY lineNo',
);
interface CraneRoundRow {
  id: string; roundNo: number; oldLocation: string | null; newLocation: string | null; locationType: string | null;
  createdBy: string; createdAt: string;
}
const selectCraneRounds = db.prepare<[string], CraneRoundRow>(
  'SELECT id, roundNo, oldLocation, newLocation, locationType, createdBy, createdAt FROM ilm_crane_rounds WHERE transactionId = ? ORDER BY roundNo',
);
const selectRecordsForRound = db.prepare<[string], IlmCraneView>(
  'SELECT * FROM ilm_cranes WHERE roundId = ? ORDER BY lineNo',
);

export function getIlmTransaction(id: string): IlmTransactionView | null {
  const row = db.prepare<[string], TxnRow>(`${SELECT_TXN} WHERE t.id = ?`).get(id);
  if (!row) return null;
  const individual = selectIndividual.get(id) ?? null;
  const individualLines = selectIndividualLines.all(id);
  const trailerLoads = selectTrailerLoads.all(id);
  const cranes = selectCranes.all(id);
  const trailerMovements = selectTrailerMovements.all(id).map((m) => ({ ...m, loads: selectLoadsForMovement.all(m.id) }));
  const craneRounds = selectCraneRounds.all(id).map((r) => ({ ...r, records: selectRecordsForRound.all(r.id) }));
  return {
    ...row,
    movementFromWell: individual?.movementFromWell ?? null,
    movementToWell: individual?.movementToWell ?? null,
    ...aggregates(individualLines, trailerLoads, cranes),
    individual, individualLines, trailerMovements, craneRounds, trailerLoads, cranes,
    delayRecords: selectDelayRecords.all(id),
  };
}

export interface IlmTransactionFilters {
  rigId?: string;
  dateFrom?: string;
  dateTo?: string;
  ilmNumber?: string;
  movementFrom?: string;
  movementTo?: string;
  status?: string;
  search?: string;
}

export function listIlmTransactions(filters: IlmTransactionFilters): IlmTransactionSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.rigId) { where.push('t.rigId = ?'); params.push(filters.rigId); }
  if (filters.dateFrom) { where.push('t.date >= ?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('t.date <= ?'); params.push(filters.dateTo); }
  if (filters.status) { where.push('t.status = ?'); params.push(filters.status); }
  if (filters.ilmNumber) { where.push('t.ilmNumber LIKE ?'); params.push(`%${filters.ilmNumber.trim()}%`); }
  if (filters.movementFrom) {
    where.push('EXISTS (SELECT 1 FROM ilm_individual i WHERE i.transactionId = t.id AND lower(i.movementFromWell) LIKE ?)');
    params.push(`%${filters.movementFrom.trim().toLowerCase()}%`);
  }
  if (filters.movementTo) {
    where.push('EXISTS (SELECT 1 FROM ilm_individual i WHERE i.transactionId = t.id AND lower(i.movementToWell) LIKE ?)');
    params.push(`%${filters.movementTo.trim().toLowerCase()}%`);
  }
  if (filters.search) {
    const needle = `%${filters.search.trim().toLowerCase()}%`;
    where.push(`(
      lower(t.ilmNumber) LIKE ? OR lower(r.rigNumber) LIKE ? OR
      EXISTS (SELECT 1 FROM ilm_individual i WHERE i.transactionId = t.id AND (
        lower(i.movementFromWell) LIKE ? OR lower(i.movementToWell) LIKE ? OR lower(i.area) LIKE ?
      ))
    )`);
    params.push(needle, needle, needle, needle, needle);
  }

  const sql = `${SELECT_TXN} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.date DESC, t.createdAt DESC LIMIT 500`;
  const rows = db.prepare(sql).all(...params) as TxnRow[];

  return rows.map((row) => {
    const individual = selectIndividual.get(row.id) ?? null;
    const individualLines = selectIndividualLines.all(row.id);
    const trailerLoads = selectTrailerLoads.all(row.id);
    const cranes = selectCranes.all(row.id);
    return {
      ...row,
      movementFromWell: individual?.movementFromWell ?? null,
      movementToWell: individual?.movementToWell ?? null,
      ...aggregates(individualLines, trailerLoads, cranes),
    };
  });
}

function aggregates(
  individualLines: IlmIndividualLineView[],
  trailerLoads: IlmTrailerLoadView[],
  cranes: IlmCraneView[],
): { totalDistanceKm: number; totalLoadsMoved: number; totalHsdConsumption: number; trailerCount: number; craneCount: number } {
  const sum = (values: (number | null)[]) => round2(values.reduce((n: number, v) => n + (v ?? 0), 0));
  return {
    totalDistanceKm: sum(individualLines.map((l) => l.ilmDistanceKm)),
    totalLoadsMoved: sum(individualLines.map((l) => l.totalLoadsMoved)),
    totalHsdConsumption: sum(individualLines.map((l) => l.totalHsdConsumption)),
    trailerCount: trailerLoads.length,
    craneCount: cranes.length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
