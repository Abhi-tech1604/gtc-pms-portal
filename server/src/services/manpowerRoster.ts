import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso, daysBetween } from '../util/date.js';
import { badRequest, notFound } from '../middleware/http.js';

/**
 * Manpower Roster: which employees are assigned to a rig on an ON/OFF
 * rotation cycle (e.g. 4 ON / 6 OFF). `getScheduledEmployees(rigId, date)`
 * is the one function DRR's prefill imports directly (mirrors how
 * dailyRigReport.ts already imports getScopedOilRows()) -- it only ever
 * *reads* the roster to answer "who's scheduled today"; nothing here writes
 * to drr_attendance_lines, so a later roster edit can never retroactively
 * change an already-saved attendance snapshot.
 */

export interface ManpowerRosterRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  rigId: string;
  designation: string;
  rotationType: string;
  onDays: number;
  offDays: number;
  rotationStartDate: string;
  shift: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'Active' | 'Inactive';
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface ScheduledEmployee {
  rosterId: string;
  employeeId: string;
  employeeName: string;
  designation: string;
  shift: string;
  rosterStatus: 'ON' | 'OFF';
}

const BASE_SELECT = `
  SELECT r.id, r.employeeId, e.name AS employeeName, r.rigId, r.designation, r.rotationType,
         r.onDays, r.offDays, r.rotationStartDate, r.shift, r.effectiveFrom, r.effectiveTo,
         r.status, r.createdBy, r.createdAt, r.updatedBy, r.updatedAt
  FROM manpower_roster r
  JOIN employees e ON e.id = r.employeeId
`;

/**
 * ON if `date` falls in the working portion of the ON/OFF cycle anchored at
 * rotationStartDate. A date before the anchor (the assignment is Active and
 * in its effective range, but the rotation cycle itself hasn't reached day 0
 * yet) counts as OFF rather than a third state — the assignment must still
 * surface in DRR's "Scheduled OFF" list so the Rig User can see and, if
 * needed, override it, instead of silently vanishing.
 */
export function computeRosterStatus(
  row: { onDays: number; offDays: number; rotationStartDate: string },
  date: string,
): 'ON' | 'OFF' {
  if (date < row.rotationStartDate) return 'OFF';
  const cycle = row.onDays + row.offDays;
  if (cycle <= 0) return 'OFF';
  const daysSinceStart = daysBetween(row.rotationStartDate, date);
  return (daysSinceStart % cycle) < row.onDays ? 'ON' : 'OFF';
}

/** Every Active roster row for this rig whose effective range covers `date`, with today's computed status. */
export function getScheduledEmployees(rigId: string, date: string): ScheduledEmployee[] {
  const rows = db.prepare<[string, string, string], ManpowerRosterRecord>(`
    ${BASE_SELECT}
    WHERE r.rigId = ? AND r.status = 'Active' AND r.effectiveFrom <= ? AND (r.effectiveTo IS NULL OR r.effectiveTo >= ?)
    ORDER BY e.name
  `).all(rigId, date, date);

  return rows.map((row) => ({
    rosterId: row.id, employeeId: row.employeeId, employeeName: row.employeeName,
    designation: row.designation, shift: row.shift, rosterStatus: computeRosterStatus(row, date),
  }));
}

function list(filters: { rigId?: string; status?: string }): ManpowerRosterRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.rigId) { where.push('r.rigId = ?'); params.push(filters.rigId); }
  if (filters.status) { where.push('r.status = ?'); params.push(filters.status); }
  const sql = `${BASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.name`;
  return db.prepare<unknown[], ManpowerRosterRecord>(sql).all(...params);
}

function get(id: string): ManpowerRosterRecord | undefined {
  return db.prepare<[string], ManpowerRosterRecord>(`${BASE_SELECT} WHERE r.id = ?`).get(id);
}

export interface RosterInput {
  employeeId: string; rigId: string; designation: string; rotationType: string;
  onDays: number; offDays: number; rotationStartDate: string; shift: string;
  effectiveFrom: string; effectiveTo?: string | null; status?: 'Active' | 'Inactive';
}

function validateInput(input: Partial<RosterInput>): void {
  if (!input.employeeId) throw badRequest('Select an employee.');
  if (!input.rigId) throw badRequest('Select a rig.');
  if (!input.designation?.trim()) throw badRequest('Designation is required.');
  if (!input.onDays || input.onDays < 1) throw badRequest('ON days must be at least 1.');
  if (!input.offDays || input.offDays < 1) throw badRequest('OFF days must be at least 1.');
  if (!input.rotationStartDate) throw badRequest('Rotation start date is required.');
  if (!input.effectiveFrom) throw badRequest('Effective From date is required.');
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw badRequest('Effective To cannot be before Effective From.');
  }
}

function create(input: RosterInput, user: string): ManpowerRosterRecord {
  validateInput(input);
  const employee = db.prepare<[string], { id: string }>("SELECT id FROM employees WHERE id = ? AND status = 'Active'").get(input.employeeId);
  if (!employee) throw badRequest('That employee does not exist or is inactive.');

  const id = newId('roster');
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO manpower_roster (id, employeeId, rigId, designation, rotationType, onDays, offDays,
      rotationStartDate, shift, effectiveFrom, effectiveTo, status, createdBy, createdAt, updatedBy, updatedAt)
    VALUES (@id, @employeeId, @rigId, @designation, @rotationType, @onDays, @offDays,
      @rotationStartDate, @shift, @effectiveFrom, @effectiveTo, @status, @user, @stamp, NULL, @stamp)
  `).run({
    id, employeeId: input.employeeId, rigId: input.rigId, designation: input.designation.trim(),
    rotationType: input.rotationType || 'Custom', onDays: input.onDays, offDays: input.offDays,
    rotationStartDate: input.rotationStartDate, shift: input.shift, effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo || null, status: input.status === 'Inactive' ? 'Inactive' : 'Active',
    user, stamp,
  });
  return get(id)!;
}

function update(id: string, input: Partial<RosterInput>, user: string): ManpowerRosterRecord {
  const existing = get(id);
  if (!existing) throw notFound('That roster assignment does not exist.');
  const merged: RosterInput = {
    employeeId: input.employeeId ?? existing.employeeId,
    rigId: input.rigId ?? existing.rigId,
    designation: input.designation ?? existing.designation,
    rotationType: input.rotationType ?? existing.rotationType,
    onDays: input.onDays ?? existing.onDays,
    offDays: input.offDays ?? existing.offDays,
    rotationStartDate: input.rotationStartDate ?? existing.rotationStartDate,
    shift: input.shift ?? existing.shift,
    effectiveFrom: input.effectiveFrom ?? existing.effectiveFrom,
    effectiveTo: input.effectiveTo !== undefined ? input.effectiveTo : existing.effectiveTo,
    status: input.status ?? existing.status,
  };
  validateInput(merged);

  const stamp = nowIso();
  db.prepare(`
    UPDATE manpower_roster SET employeeId=@employeeId, rigId=@rigId, designation=@designation,
      rotationType=@rotationType, onDays=@onDays, offDays=@offDays, rotationStartDate=@rotationStartDate,
      shift=@shift, effectiveFrom=@effectiveFrom, effectiveTo=@effectiveTo, status=@status,
      updatedBy=@updatedBy, updatedAt=@stamp
    WHERE id=@id
  `).run({
    id, ...merged, designation: merged.designation.trim(), effectiveTo: merged.effectiveTo || null,
    updatedBy: user, stamp,
  });
  return get(id)!;
}

export const manpowerRosterModel = { list, get, create, update };
