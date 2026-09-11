import { db } from '../db/index.js';

/**
 * "Yesterday's closing becomes today's opening" for every cumulative balance
 * the Daily Rig Report form shows as read-only Opening fields (spec 10).
 *
 * None of DPR/HSD/Mechanical Log had a "read the previous calendar day's row"
 * query before this — each was self-contained per import. These are the
 * first such queries in the app, added here rather than in each module's own
 * service so the carry-forward policy (which statuses count, which table is
 * authoritative for which balance) lives in one place.
 *
 * Only real, submitted data is ever read: a Daily Rig Report only reaches
 * hsd_reports/mechanical_log_rows/drr_oil_lines/drr_hydraulic_lines once it
 * is Submitted (see routes/dailyRigReport.ts) — a Draft's entries live only
 * in drr_reports.draftPayload, which none of these queries touch. So "does a
 * prior row exist" already means "was it submitted", with no extra status
 * filter needed here.
 */

export interface EquipmentOpeningHours {
  equipmentId: string;
  openingRunningHours: number;
  source: 'previous-day' | 'equipment-master';
}

/**
 * Latest `mechanical_log_rows.closingHours` for this equipment strictly
 * before `date`. Falls back to `equipment.currentRunningHours` — which is
 * already the admin-maintained baseline the Mechanical Log importer itself
 * writes back after each commit — when no prior day-row exists at all,
 * satisfying spec 10's "if there is no previous record, allow an authorized
 * user/admin to enter an initial opening value" without a new field.
 */
export function getPreviousEquipmentHours(equipmentId: string, beforeDate: string): EquipmentOpeningHours {
  const row = db.prepare<[string, string], { closingHours: number | null }>(`
    SELECT closingHours FROM mechanical_log_rows
    WHERE equipmentId = ? AND logDate < ? AND closingHours IS NOT NULL
    ORDER BY logDate DESC LIMIT 1
  `).get(equipmentId, beforeDate);
  if (row) return { equipmentId, openingRunningHours: row.closingHours!, source: 'previous-day' };

  const eq = db.prepare<[string], { currentRunningHours: number }>(
    'SELECT currentRunningHours FROM equipment WHERE id = ?',
  ).get(equipmentId);
  return { equipmentId, openingRunningHours: eq?.currentRunningHours ?? 0, source: 'equipment-master' };
}

export interface HsdOpening {
  /** Keyed by the free-text equipment label, matching hsd_equipment_lines.equipment. */
  byEquipment: Record<string, number>;
  siteDieselClosing: number | null;
}

/** The most recent HSD day strictly before `date` for this DPR-side rig, if any. */
export function getPreviousHsdOpening(dprRigId: string, beforeDate: string): HsdOpening {
  const report = db.prepare<[string, string], { id: string }>(`
    SELECT id FROM hsd_reports WHERE rigId = ? AND hsdDate < ? ORDER BY hsdDate DESC LIMIT 1
  `).get(dprRigId, beforeDate);
  if (!report) return { byEquipment: {}, siteDieselClosing: null };

  const equipmentRows = db.prepare<[string], { equipment: string | null; closingStock: number | null }>(
    'SELECT equipment, closingStock FROM hsd_equipment_lines WHERE reportId = ?',
  ).all(report.id);
  const byEquipment: Record<string, number> = {};
  for (const r of equipmentRows) if (r.equipment && r.closingStock !== null) byEquipment[r.equipment] = r.closingStock;

  const site = db.prepare<[string], { closingBalance: number | null }>(
    "SELECT closingBalance FROM hsd_site_lines WHERE reportId = ? AND label = 'Rig Site Diesel'",
  ).get(report.id);

  return { byEquipment, siteDieselClosing: site?.closingBalance ?? null };
}

/** Latest lubricating-oil closing balance for this equipment+oilType strictly before `date`. */
export function getPreviousOilBalance(equipmentId: string | null, oilType: string, rigId: string, beforeDate: string): number | null {
  const row = db.prepare<[string, string, string | null, string], { closingBalance: number | null }>(`
    SELECT ol.closingBalance FROM drr_oil_lines ol
    JOIN drr_reports r ON r.id = ol.reportId
    WHERE r.rigId = ? AND r.reportDate < ? AND ol.equipmentId IS ? AND ol.oilType = ?
    ORDER BY r.reportDate DESC LIMIT 1
  `).get(rigId, beforeDate, equipmentId, oilType);
  return row?.closingBalance ?? null;
}

/** Latest hydraulic tank closing level for this rig+tank strictly before `date`. */
export function getPreviousHydraulicLevel(rigId: string, tankName: string, beforeDate: string): number | null {
  const row = db.prepare<[string, string, string], { closingLevel: number | null }>(`
    SELECT hl.closingLevel FROM drr_hydraulic_lines hl
    JOIN drr_reports r ON r.id = hl.reportId
    WHERE r.rigId = ? AND r.reportDate < ? AND hl.tankName = ?
    ORDER BY r.reportDate DESC LIMIT 1
  `).get(rigId, beforeDate, tankName);
  return row?.closingLevel ?? null;
}
