import { db } from '../db/index.js';

/**
 * The fully-automated Crane Summary dashboard: every ilm_cranes row (one row
 * per crane per shift-day), joined to its owning Crane Round (for the
 * round's Old/New Location snapshot) and ILM transaction (for rig, date,
 * Active/Completed status), for the filtered scope. Nothing here is
 * fabricated or duplicated — every figure is a live aggregate over the same
 * rows the ILM form itself writes (services/ilmLifecycle.ts's
 * addCraneRecord/updateCraneRecord), so editing a Crane Record in ILM is
 * reflected here on the next fetch with no separate data store involved.
 *
 * A "crane" is identified by its Equipment Master link (equipmentId) when
 * the record was added via that picker, falling back to its recorded name
 * (craneNo) otherwise — matching the same identity rule the ILM form itself
 * uses when it resolves a linked equipment's name at write time
 * (routes/ilm.ts's resolveLinkedIlmEquipment). This is what lets one crane's
 * work across several ILMs (and several rigs, if it was moved) roll up into
 * a single Crane-wise Performance row without merging two different
 * physical cranes that just happen to share a free-typed label at different
 * rigs into one — that only happens if a Crane record itself supplies no
 * distinguishing rigId scoping via the Detailed Table's per-ILM rows.
 */

export interface CraneDashboardQuery {
  rigId?: string;
  dateFrom?: string;
  dateTo?: string;
  craneNo?: string;
  transporterName?: string;
  status?: 'Active' | 'Completed';
}

function pickStr(query: Record<string, unknown>, key: string): string | undefined {
  const v = query[key];
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s;
}

export function normaliseCraneDashboardQuery(query: Record<string, unknown>): CraneDashboardQuery {
  const status = pickStr(query, 'status');
  return {
    rigId: pickStr(query, 'rigId'),
    dateFrom: pickStr(query, 'dateFrom'),
    dateTo: pickStr(query, 'dateTo'),
    craneNo: pickStr(query, 'craneNo'),
    transporterName: pickStr(query, 'transporterName'),
    status: status === 'Active' || status === 'Completed' ? status : undefined,
  };
}

interface FlatCraneRow {
  craneRowId: string;
  transactionId: string; ilmNumber: string; ilmDate: string; ilmStatus: string;
  rigId: string; rigNumber: string; rigName: string;
  roundId: string | null; roundNo: number | null; oldLocation: string | null; newLocation: string | null;
  craneNo: string; equipmentId: string | null; capacityTon: number | null; registrationNo: string | null;
  transporterName: string | null;
  shiftDate: string | null; dayShiftHrs: number | null; nightShiftHrs: number | null;
  breakdownHrs: number | null; issuedHsdLtrs: number | null; totalWorkingHrs: number | null;
}

const BASE_SELECT = `
  SELECT
    c.id AS craneRowId,
    t.id AS transactionId, t.ilmNumber, t.date AS ilmDate, t.status AS ilmStatus,
    t.rigId, r.rigNumber, r.name AS rigName,
    rnd.id AS roundId, rnd.roundNo, rnd.oldLocation, rnd.newLocation,
    c.craneNo, c.equipmentId, c.capacityTon, c.registrationNo, c.transporterName,
    c.shiftDate, c.dayShiftHrs, c.nightShiftHrs, c.breakdownHrs, c.issuedHsdLtrs, c.totalWorkingHrs
  FROM ilm_cranes c
  JOIN ilm_transactions t ON t.id = c.transactionId
  JOIN ilm_rigs r ON r.id = t.rigId
  LEFT JOIN ilm_crane_rounds rnd ON rnd.id = c.roundId
`;

function buildWhere(q: CraneDashboardQuery): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = ["c.craneNo IS NOT NULL", "trim(c.craneNo) <> ''"];
  const params: Record<string, unknown> = {};
  if (q.rigId) { clauses.push('t.rigId = @rigId'); params.rigId = q.rigId; }
  if (q.dateFrom) { clauses.push('t.date >= @dateFrom'); params.dateFrom = q.dateFrom; }
  if (q.dateTo) { clauses.push('t.date <= @dateTo'); params.dateTo = q.dateTo; }
  if (q.craneNo) { clauses.push('c.craneNo = @craneNo'); params.craneNo = q.craneNo; }
  if (q.transporterName) { clauses.push('c.transporterName = @transporterName'); params.transporterName = q.transporterName; }
  if (q.status) { clauses.push('t.status = @status'); params.status = q.status; }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

function craneKey(row: { equipmentId: string | null; craneNo: string }): string {
  return row.equipmentId ? `eq:${row.equipmentId}` : `name:${row.craneNo.trim().toLowerCase()}`;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function sumN(n: number | null): number { return n ?? 0; }
function breakdownPct(workingHours: number, breakdownHours: number): number {
  const denom = workingHours + breakdownHours;
  return denom > 0 ? round2((breakdownHours / denom) * 100) : 0;
}

export interface CraneDashboardRow {
  key: string;
  transactionId: string; ilmNumber: string; status: 'Active' | 'Completed';
  craneNo: string; equipmentId: string | null;
  rigId: string; rigNumber: string; rigName: string;
  capacityTon: number | null; registrationNo: string | null; transporterName: string | null;
  oldLocation: string | null; newLocation: string | null;
  workingHours: number; fuelLtrs: number; breakdownHours: number; breakdownPct: number; trips: number;
}

export interface CraneWiseRow { craneNo: string; workingHours: number; fuelLtrs: number; breakdownHours: number; breakdownPct: number; trips: number }
export interface RigWiseRow { rigId: string; rigNumber: string; rigName: string; totalCranes: number; workingHours: number; fuelLtrs: number; breakdownHours: number }
export interface TransporterWiseRow { transporterName: string; craneCount: number; workingHours: number; breakdownHours: number; breakdownPct: number }
export interface TrendPoint { date: string; workingHours: number; fuelLtrs: number; breakdownHours: number }

export interface CraneDashboardResponse {
  kpis: {
    totalCranes: number; activeCranes: number; totalWorkingHours: number;
    totalFuelConsumed: number; totalTrips: number; totalBreakdownHours: number;
  };
  rigWise: RigWiseRow[];
  craneWise: CraneWiseRow[];
  transporterWise: TransporterWiseRow[];
  trend: TrendPoint[];
  rows: CraneDashboardRow[];
}

export function getCraneDashboard(rawQuery: Record<string, unknown>): CraneDashboardResponse {
  const q = normaliseCraneDashboardQuery(rawQuery);
  const { where, params } = buildWhere(q);
  const flat = db.prepare(`${BASE_SELECT} ${where} ORDER BY t.date, rnd.roundNo, c.id`).all(params) as FlatCraneRow[];

  // --- Detailed table: one row per crane identity per ILM transaction. ---
  const byTxnCrane = new Map<string, FlatCraneRow[]>();
  for (const r of flat) {
    const k = `${r.transactionId}|${craneKey(r)}`;
    const list = byTxnCrane.get(k) ?? [];
    list.push(r);
    byTxnCrane.set(k, list);
  }
  const rows: CraneDashboardRow[] = [];
  for (const [key, group] of byTxnCrane) {
    const last = group[group.length - 1];
    const workingHours = round2(group.reduce((s, r) => s + sumN(r.totalWorkingHrs), 0));
    const fuelLtrs = round2(group.reduce((s, r) => s + sumN(r.issuedHsdLtrs), 0));
    const breakdownHours = round2(group.reduce((s, r) => s + sumN(r.breakdownHrs), 0));
    const trips = new Set(group.map((r) => r.roundId).filter((v): v is string => !!v)).size || 1;
    rows.push({
      key,
      transactionId: last.transactionId, ilmNumber: last.ilmNumber, status: last.ilmStatus === 'Active' ? 'Active' : 'Completed',
      craneNo: last.craneNo, equipmentId: last.equipmentId,
      rigId: last.rigId, rigNumber: last.rigNumber, rigName: last.rigName,
      capacityTon: last.capacityTon, registrationNo: last.registrationNo, transporterName: last.transporterName,
      oldLocation: last.oldLocation, newLocation: last.newLocation,
      workingHours, fuelLtrs, breakdownHours, breakdownPct: breakdownPct(workingHours, breakdownHours), trips,
    });
  }
  rows.sort((a, b) => a.rigNumber.localeCompare(b.rigNumber) || a.craneNo.localeCompare(b.craneNo));

  // --- Crane-wise performance: same identity, aggregated across every ILM/rig it appeared in. ---
  const byCrane = new Map<string, FlatCraneRow[]>();
  for (const r of flat) {
    const k = craneKey(r);
    const list = byCrane.get(k) ?? [];
    list.push(r);
    byCrane.set(k, list);
  }
  const craneWise: CraneWiseRow[] = [...byCrane.values()].map((group) => {
    const last = group[group.length - 1];
    const workingHours = round2(group.reduce((s, r) => s + sumN(r.totalWorkingHrs), 0));
    const fuelLtrs = round2(group.reduce((s, r) => s + sumN(r.issuedHsdLtrs), 0));
    const breakdownHours = round2(group.reduce((s, r) => s + sumN(r.breakdownHrs), 0));
    const trips = new Set(group.map((r) => `${r.transactionId}|${r.roundId ?? ''}`)).size;
    return { craneNo: last.craneNo, workingHours, fuelLtrs, breakdownHours, breakdownPct: breakdownPct(workingHours, breakdownHours), trips };
  }).sort((a, b) => b.workingHours - a.workingHours);

  // --- Rig-wise comparison. ---
  const byRig = new Map<string, { rigNumber: string; rigName: string; rows: FlatCraneRow[] }>();
  for (const r of flat) {
    const entry = byRig.get(r.rigId) ?? { rigNumber: r.rigNumber, rigName: r.rigName, rows: [] };
    entry.rows.push(r);
    byRig.set(r.rigId, entry);
  }
  const rigWise: RigWiseRow[] = [...byRig.entries()].map(([rigId, { rigNumber, rigName, rows: rigRows }]) => ({
    rigId, rigNumber, rigName,
    totalCranes: new Set(rigRows.map((r) => craneKey(r))).size,
    workingHours: round2(rigRows.reduce((s, r) => s + sumN(r.totalWorkingHrs), 0)),
    fuelLtrs: round2(rigRows.reduce((s, r) => s + sumN(r.issuedHsdLtrs), 0)),
    breakdownHours: round2(rigRows.reduce((s, r) => s + sumN(r.breakdownHrs), 0)),
  })).sort((a, b) => a.rigNumber.localeCompare(b.rigNumber));

  // --- Transporter-wise comparison. ---
  const byTransporter = new Map<string, FlatCraneRow[]>();
  for (const r of flat) {
    if (!r.transporterName) continue;
    const list = byTransporter.get(r.transporterName) ?? [];
    list.push(r);
    byTransporter.set(r.transporterName, list);
  }
  const transporterWise: TransporterWiseRow[] = [...byTransporter.entries()].map(([transporterName, tRows]) => {
    const workingHours = round2(tRows.reduce((s, r) => s + sumN(r.totalWorkingHrs), 0));
    const breakdownHours = round2(tRows.reduce((s, r) => s + sumN(r.breakdownHrs), 0));
    return {
      transporterName, craneCount: new Set(tRows.map((r) => craneKey(r))).size,
      workingHours, breakdownHours, breakdownPct: breakdownPct(workingHours, breakdownHours),
    };
  }).sort((a, b) => b.workingHours - a.workingHours);

  // --- Daily trend: keyed by the crane record's own shift date, falling back to the ILM's date when unset. ---
  const byDate = new Map<string, FlatCraneRow[]>();
  for (const r of flat) {
    const d = r.shiftDate ?? r.ilmDate;
    const list = byDate.get(d) ?? [];
    list.push(r);
    byDate.set(d, list);
  }
  const trend: TrendPoint[] = [...byDate.entries()].map(([date, dRows]) => ({
    date,
    workingHours: round2(dRows.reduce((s, r) => s + sumN(r.totalWorkingHrs), 0)),
    fuelLtrs: round2(dRows.reduce((s, r) => s + sumN(r.issuedHsdLtrs), 0)),
    breakdownHours: round2(dRows.reduce((s, r) => s + sumN(r.breakdownHrs), 0)),
  })).sort((a, b) => a.date.localeCompare(b.date));

  const allCraneKeys = new Set(flat.map((r) => craneKey(r)));
  const activeCraneKeys = new Set(flat.filter((r) => r.ilmStatus === 'Active').map((r) => craneKey(r)));
  const totalTrips = new Set(flat.map((r) => `${r.transactionId}|${r.roundId ?? r.craneRowId}`)).size;

  const kpis = {
    totalCranes: allCraneKeys.size,
    activeCranes: activeCraneKeys.size,
    totalWorkingHours: round2(flat.reduce((s, r) => s + sumN(r.totalWorkingHrs), 0)),
    totalFuelConsumed: round2(flat.reduce((s, r) => s + sumN(r.issuedHsdLtrs), 0)),
    totalTrips,
    totalBreakdownHours: round2(flat.reduce((s, r) => s + sumN(r.breakdownHrs), 0)),
  };

  return { kpis, rigWise, craneWise, transporterWise, trend, rows };
}

export interface CraneFilterOptions { cranes: string[]; transporters: string[] }

/** Independent of the dashboard's own filters (crane/transporter/date/status) — only rig-scoped — so the filter dropdowns always offer every choice the user has access to. */
export function getCraneFilterOptions(rigScopeQuery: Record<string, unknown>): CraneFilterOptions {
  const rigId = pickStr(rigScopeQuery, 'rigId');
  const where = rigId ? 'WHERE t.rigId = @rigId AND c.craneNo IS NOT NULL AND trim(c.craneNo) <> \'\'' : "WHERE c.craneNo IS NOT NULL AND trim(c.craneNo) <> ''";
  const cranes = db.prepare(`
    SELECT DISTINCT c.craneNo FROM ilm_cranes c JOIN ilm_transactions t ON t.id = c.transactionId ${where} ORDER BY c.craneNo
  `).all(rigId ? { rigId } : {}) as { craneNo: string }[];
  const transWhere = rigId
    ? 'WHERE t.rigId = @rigId AND c.transporterName IS NOT NULL AND trim(c.transporterName) <> \'\''
    : "WHERE c.transporterName IS NOT NULL AND trim(c.transporterName) <> ''";
  const transporters = db.prepare(`
    SELECT DISTINCT c.transporterName FROM ilm_cranes c JOIN ilm_transactions t ON t.id = c.transactionId ${transWhere} ORDER BY c.transporterName
  `).all(rigId ? { rigId } : {}) as { transporterName: string }[];
  return { cranes: cranes.map((r) => r.craneNo), transporters: transporters.map((r) => r.transporterName) };
}
