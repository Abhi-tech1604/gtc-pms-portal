import { db } from '../db/index.js';
import {
  equipmentStatus, healthStatus, remainingHealthCheckDays,
  remainingServiceHours, runningSinceLastService,
} from './calc.js';
import { today } from '../util/date.js';

/**
 * The single place where an equipment row is turned into the shape the portal
 * displays. Every derived figure comes from section 9 and is a whole number,
 * so no decimal can reach the interface (defect D12, D15).
 */

export interface EquipmentView {
  id: string;
  rigId: string;
  rigName: string;
  rigNumber: string;
  name: string;
  category: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  assetNumber: string | null;
  engineNumber: string | null;
  installationDate: string | null;
  section: string;
  currentRunningHours: number;
  lastServiceHours: number;
  serviceInterval: number;
  runningSinceLastService: number;
  remainingServiceHours: number;
  lastHealthCheckDate: string | null;
  healthCheckInterval: number;
  remainingHealthCheckDays: number | null;
  healthStatus: 'Normal' | 'Upcoming' | 'Overdue';
  isBreakdown: boolean;
  isActive: boolean;
  status: 'Normal' | 'Upcoming' | 'Overdue' | 'Breakdown';
  lastReportedDate: string | null;
  currentPlace: string | null;
  currentPlaceSince: string | null;
  ecmPresent: boolean | null;
  etToolApplicable: boolean | null;
  linkedEngineId: string | null;
  linkedTransmissionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Left-joins in the linked Engine/Transmission Material Master records (if
 * any) so toView() can always prefer their *current* name/make/model/serial
 * over whatever was last snapshotted onto the equipment row — editing a
 * Material Master record must be reflected immediately on every equipment row
 * linked to it, never leaving a stale duplicate on display.
 */
const BASE_SELECT = `
  SELECT e.*, r.name AS rigName, r.rigNumber AS rigNumber,
         (SELECT MAX(l.logDate) FROM mechanical_log_rows l WHERE l.equipmentId = e.id) AS lastReportedDate,
         me.name AS meName, me.make AS meMake, me.model AS meModel, me.serialNumber AS meSerialNumber,
         mt.name AS mtName, mt.make AS mtMake, mt.model AS mtModel, mt.serialNumber AS mtSerialNumber
  FROM equipment e
  JOIN rigs r ON r.id = e.rigId
  LEFT JOIN material_master me ON me.id = e.linkedEngineId
  LEFT JOIN material_master mt ON mt.id = e.linkedTransmissionId
`;

interface Raw {
  id: string; rigId: string; rigName: string; rigNumber: string; name: string;
  category: string; manufacturer: string | null; model: string | null;
  serialNumber: string | null; assetNumber: string | null; engineNumber: string | null;
  installationDate: string | null; section: string; currentRunningHours: number;
  lastServiceHours: number; serviceInterval: number; lastHealthCheckDate: string | null;
  healthCheckInterval: number; isBreakdown: number; isActive: number; lastReportedDate: string | null;
  currentPlace: string | null; currentPlaceSince: string | null;
  ecmPresent: number | null; etToolApplicable: number | null;
  linkedEngineId: string | null; linkedTransmissionId: string | null;
  meName: string | null; meMake: string | null; meModel: string | null; meSerialNumber: string | null;
  mtName: string | null; mtMake: string | null; mtModel: string | null; mtSerialNumber: string | null;
  createdAt: string; updatedAt: string;
}

export function toView(raw: Raw, asOf: string = today()): EquipmentView {
  const status = equipmentStatus({
    currentRunningHours: raw.currentRunningHours,
    lastServiceHours: raw.lastServiceHours,
    serviceInterval: raw.serviceInterval,
    isBreakdown: !!raw.isBreakdown,
  });
  // Engine link wins over Transmission link wins over the equipment row's own
  // stored snapshot — an equipment row only ever has one of the two links set
  // in practice, but this order is the deliberate tie-break if both are.
  const name = raw.meName ?? raw.mtName ?? raw.name;
  const manufacturer = raw.meMake ?? raw.mtMake ?? raw.manufacturer;
  const model = raw.meModel ?? raw.mtModel ?? raw.model;
  const serialNumber = raw.meSerialNumber ?? raw.mtSerialNumber ?? raw.serialNumber;
  return {
    id: raw.id,
    rigId: raw.rigId,
    rigName: raw.rigName,
    rigNumber: raw.rigNumber,
    name,
    category: raw.category,
    manufacturer,
    model,
    serialNumber,
    assetNumber: raw.assetNumber,
    engineNumber: raw.engineNumber,
    installationDate: raw.installationDate,
    section: raw.section,
    currentRunningHours: Math.round(raw.currentRunningHours),
    lastServiceHours: Math.round(raw.lastServiceHours),
    serviceInterval: Math.round(raw.serviceInterval),
    runningSinceLastService: runningSinceLastService(raw.currentRunningHours, raw.lastServiceHours),
    remainingServiceHours: remainingServiceHours(
      raw.currentRunningHours, raw.lastServiceHours, raw.serviceInterval,
    ),
    lastHealthCheckDate: raw.lastHealthCheckDate,
    healthCheckInterval: raw.healthCheckInterval,
    remainingHealthCheckDays: remainingHealthCheckDays(
      raw.lastHealthCheckDate, raw.healthCheckInterval, asOf,
    ),
    healthStatus: healthStatus(raw.lastHealthCheckDate, raw.healthCheckInterval, asOf),
    isBreakdown: !!raw.isBreakdown,
    isActive: !!raw.isActive,
    status,
    lastReportedDate: raw.lastReportedDate,
    currentPlace: raw.currentPlace,
    currentPlaceSince: raw.currentPlaceSince,
    ecmPresent: raw.ecmPresent === null ? null : !!raw.ecmPresent,
    etToolApplicable: raw.etToolApplicable === null ? null : !!raw.etToolApplicable,
    linkedEngineId: raw.linkedEngineId,
    linkedTransmissionId: raw.linkedTransmissionId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/** rigScope is applied here so a rig-scoped user can never widen their view. */
/** `rigScope`: a single rig id (one specific rig), an array (a multi-rig account scope), or null (unrestricted). */
export function listEquipment(rigScope: string | string[] | null): EquipmentView[] {
  const ids = rigScope === null ? null : Array.isArray(rigScope) ? rigScope : [rigScope];
  let rows: Raw[];
  if (ids === null) {
    rows = db.prepare(`${BASE_SELECT} ORDER BY r.rigNumber, e.section, e.name`).all() as Raw[];
  } else if (ids.length === 0) {
    rows = [];
  } else {
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(`${BASE_SELECT} WHERE e.rigId IN (${placeholders}) ORDER BY r.rigNumber, e.section, e.name`).all(...ids) as Raw[];
  }
  const asOf = today();
  return rows.map((r) => toView(r, asOf));
}

export function getEquipment(id: string): EquipmentView | null {
  const raw = db.prepare(`${BASE_SELECT} WHERE e.id = ?`).get(id) as Raw | undefined;
  return raw ? toView(raw) : null;
}
