import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso, today } from '../util/date.js';
import { badRequest, notFound } from '../middleware/http.js';

/**
 * Internal Follow-up: the weekly office review meeting log. One row per
 * Rig+Equipment issue discussed in a meeting -- "allow multiple equipment/
 * issues in one meeting" is simply multiple rows sharing the same
 * meetingDate+rigId (schema.sql).
 *
 * Equipment must always come from the existing Admin > Master > Equipment
 * Master (no separate equipment master here); equipmentName/Make/Model/Serial
 * and responsiblePerson are frozen at save time so a later edit to Equipment
 * Master, a rig transfer, or a Users record can never rewrite an already-
 * saved follow-up's history -- the read model NEVER re-joins those tables for
 * display, only equipmentId/rigId/responsiblePersonId are kept for linking
 * and filtering.
 */

export const EQUIPMENT_STATUSES = ['Working', 'Stopped', 'Breakdown', 'Under Maintenance'] as const;
export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
export const FOLLOWUP_STATUSES = ['Open', 'In Progress', 'Completed', 'On Hold'] as const;

export type EquipmentStatusValue = (typeof EQUIPMENT_STATUSES)[number];
export type PriorityValue = (typeof PRIORITIES)[number];
export type FollowupStatusValue = (typeof FOLLOWUP_STATUSES)[number];

export interface InternalFollowupRecord {
  id: string;
  meetingDate: string;
  rigId: string;
  rigName: string;
  rigNumber: string;
  equipmentId: string;
  equipmentName: string;
  equipmentMake: string | null;
  equipmentModel: string | null;
  equipmentSerial: string | null;
  equipmentStatus: EquipmentStatusValue;
  issue: string | null;
  discussionNote: string | null;
  requiredAction: string | null;
  responsiblePersonId: string | null;
  responsiblePerson: string | null;
  priority: PriorityValue;
  targetDate: string | null;
  status: FollowupStatusValue;
  remarks: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  closedAt: string | null;
  isOverdue: boolean;
}

interface Raw {
  id: string; meetingDate: string; rigId: string; rigName: string; rigNumber: string;
  equipmentId: string; equipmentName: string; equipmentMake: string | null; equipmentModel: string | null;
  equipmentSerial: string | null; equipmentStatus: string; issue: string | null; discussionNote: string | null;
  requiredAction: string | null; responsiblePersonId: string | null; responsiblePerson: string | null;
  priority: string; targetDate: string | null; status: string; remarks: string | null;
  createdBy: string; createdAt: string; updatedBy: string | null; updatedAt: string; closedAt: string | null;
}

const BASE_SELECT = `
  SELECT f.*, r.name AS rigName, r.rigNumber AS rigNumber
  FROM internal_followups f
  JOIN rigs r ON r.id = f.rigId
`;

function toView(row: Raw, asOf: string): InternalFollowupRecord {
  const isOverdue = row.status !== 'Completed' && !!row.targetDate && row.targetDate < asOf;
  return {
    id: row.id, meetingDate: row.meetingDate, rigId: row.rigId, rigName: row.rigName, rigNumber: row.rigNumber,
    equipmentId: row.equipmentId, equipmentName: row.equipmentName, equipmentMake: row.equipmentMake,
    equipmentModel: row.equipmentModel, equipmentSerial: row.equipmentSerial,
    equipmentStatus: row.equipmentStatus as EquipmentStatusValue,
    issue: row.issue, discussionNote: row.discussionNote, requiredAction: row.requiredAction,
    responsiblePersonId: row.responsiblePersonId, responsiblePerson: row.responsiblePerson,
    priority: row.priority as PriorityValue, targetDate: row.targetDate, status: row.status as FollowupStatusValue,
    remarks: row.remarks, createdBy: row.createdBy, createdAt: row.createdAt,
    updatedBy: row.updatedBy, updatedAt: row.updatedAt, closedAt: row.closedAt,
    isOverdue,
  };
}

export interface FollowupFilters {
  rigId?: string; equipmentId?: string; status?: string; priority?: string;
  responsiblePersonId?: string; dateFrom?: string; dateTo?: string;
}

function list(filters: FollowupFilters, rigIds?: string[] | null): InternalFollowupRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (rigIds) {
    if (rigIds.length === 0) return [];
    where.push(`f.rigId IN (${rigIds.map(() => '?').join(',')})`);
    params.push(...rigIds);
  }
  if (filters.rigId) { where.push('f.rigId = ?'); params.push(filters.rigId); }
  if (filters.equipmentId) { where.push('f.equipmentId = ?'); params.push(filters.equipmentId); }
  if (filters.status) { where.push('f.status = ?'); params.push(filters.status); }
  if (filters.priority) { where.push('f.priority = ?'); params.push(filters.priority); }
  if (filters.responsiblePersonId) { where.push('f.responsiblePersonId = ?'); params.push(filters.responsiblePersonId); }
  if (filters.dateFrom) { where.push('f.meetingDate >= ?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('f.meetingDate <= ?'); params.push(filters.dateTo); }

  const sql = `${BASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.meetingDate DESC, f.createdAt DESC`;
  const rows = db.prepare<unknown[], Raw>(sql).all(...params);
  const asOf = today();
  return rows.map((r) => toView(r, asOf));
}

function get(id: string): InternalFollowupRecord | undefined {
  const row = db.prepare<[string], Raw>(`${BASE_SELECT} WHERE f.id = ?`).get(id);
  return row ? toView(row, today()) : undefined;
}

export interface FollowupInput {
  meetingDate: string;
  rigId: string;
  equipmentId: string;
  equipmentStatus: string;
  issue?: string | null;
  discussionNote?: string | null;
  requiredAction?: string | null;
  responsiblePersonId?: string | null;
  priority?: string;
  targetDate?: string | null;
  status?: string;
  remarks?: string | null;
}

function validateInput(input: Partial<FollowupInput>): void {
  if (!input.meetingDate) throw badRequest('Meeting Date is required.');
  if (!input.rigId) throw badRequest('Select a Rig.');
  if (!input.equipmentId) throw badRequest('Select an Equipment.');
  if (!input.equipmentStatus || !EQUIPMENT_STATUSES.includes(input.equipmentStatus as EquipmentStatusValue)) {
    throw badRequest('Select a valid Equipment Status.');
  }
  if (input.priority && !PRIORITIES.includes(input.priority as PriorityValue)) {
    throw badRequest('Select a valid Priority.');
  }
  if (input.status && !FOLLOWUP_STATUSES.includes(input.status as FollowupStatusValue)) {
    throw badRequest('Select a valid Status.');
  }
}

interface EquipmentSnapshot {
  id: string; rigId: string; name: string; manufacturer: string | null; model: string | null; serialNumber: string | null;
}

/** Equipment must currently belong to the selected Rig -- "select Rig -> automatically load ONLY equipment currently assigned to that Rig." */
function loadEquipmentForRigOr400(equipmentId: string, rigId: string): EquipmentSnapshot {
  const eq = db.prepare<[string], EquipmentSnapshot>(
    'SELECT id, rigId, name, manufacturer, model, serialNumber FROM equipment WHERE id = ?',
  ).get(equipmentId);
  if (!eq) throw badRequest('That equipment does not exist in Equipment Master.');
  if (eq.rigId !== rigId) throw badRequest('That equipment is not currently assigned to the selected Rig.');
  return eq;
}

function loadRigOr400(rigId: string): { id: string } {
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE id = ?').get(rigId);
  if (!rig) throw badRequest('That rig does not exist.');
  return rig;
}

function resolveResponsiblePerson(id: string | null | undefined): { id: string | null; name: string | null } {
  if (!id) return { id: null, name: null };
  const user = db.prepare<[string], { id: string; name: string }>(
    "SELECT id, name FROM users WHERE id = ? AND status = 'Active'",
  ).get(id);
  if (!user) throw badRequest('That responsible person does not exist or is inactive.');
  return { id: user.id, name: user.name };
}

function create(input: FollowupInput, user: string): InternalFollowupRecord {
  validateInput(input);
  loadRigOr400(input.rigId);
  const eq = loadEquipmentForRigOr400(input.equipmentId, input.rigId);
  const responsible = resolveResponsiblePerson(input.responsiblePersonId);

  const id = newId('ifu');
  const stamp = nowIso();
  const status = (input.status as FollowupStatusValue) || 'Open';
  db.prepare(`
    INSERT INTO internal_followups (
      id, meetingDate, rigId, equipmentId, equipmentName, equipmentMake, equipmentModel, equipmentSerial,
      equipmentStatus, issue, discussionNote, requiredAction, responsiblePersonId, responsiblePerson,
      priority, targetDate, status, remarks, createdBy, createdAt, updatedBy, updatedAt, closedAt
    ) VALUES (
      @id, @meetingDate, @rigId, @equipmentId, @equipmentName, @equipmentMake, @equipmentModel, @equipmentSerial,
      @equipmentStatus, @issue, @discussionNote, @requiredAction, @responsiblePersonId, @responsiblePerson,
      @priority, @targetDate, @status, @remarks, @user, @stamp, NULL, @stamp, @closedAt
    )
  `).run({
    id, meetingDate: input.meetingDate, rigId: input.rigId, equipmentId: eq.id,
    equipmentName: eq.name, equipmentMake: eq.manufacturer, equipmentModel: eq.model, equipmentSerial: eq.serialNumber,
    equipmentStatus: input.equipmentStatus, issue: input.issue || null, discussionNote: input.discussionNote || null,
    requiredAction: input.requiredAction || null, responsiblePersonId: responsible.id, responsiblePerson: responsible.name,
    priority: (input.priority as PriorityValue) || 'Medium', targetDate: input.targetDate || null,
    status, remarks: input.remarks || null, user, stamp,
    closedAt: status === 'Completed' ? stamp : null,
  });
  return get(id)!;
}

function update(id: string, input: Partial<FollowupInput>, user: string): InternalFollowupRecord {
  const existing = db.prepare<[string], Raw>(`${BASE_SELECT} WHERE f.id = ?`).get(id);
  if (!existing) throw notFound('That follow-up entry does not exist.');

  const merged: FollowupInput = {
    meetingDate: input.meetingDate ?? existing.meetingDate,
    rigId: input.rigId ?? existing.rigId,
    equipmentId: input.equipmentId ?? existing.equipmentId,
    equipmentStatus: input.equipmentStatus ?? existing.equipmentStatus,
    issue: input.issue !== undefined ? input.issue : existing.issue,
    discussionNote: input.discussionNote !== undefined ? input.discussionNote : existing.discussionNote,
    requiredAction: input.requiredAction !== undefined ? input.requiredAction : existing.requiredAction,
    responsiblePersonId: input.responsiblePersonId !== undefined ? input.responsiblePersonId : existing.responsiblePersonId,
    priority: input.priority ?? existing.priority,
    targetDate: input.targetDate !== undefined ? input.targetDate : existing.targetDate,
    status: input.status ?? existing.status,
    remarks: input.remarks !== undefined ? input.remarks : existing.remarks,
  };
  validateInput(merged);
  loadRigOr400(merged.rigId);

  // Re-snapshotting equipment/responsible-person fields only happens when the
  // admin explicitly changes that selection on this row (a real edit action),
  // never as a side effect of Equipment Master or Users changing elsewhere --
  // the same freeze-at-explicit-save discipline as ILM's header contract
  // fields.
  const equipmentChanged = input.equipmentId !== undefined && input.equipmentId !== existing.equipmentId;
  const rigChanged = input.rigId !== undefined && input.rigId !== existing.rigId;
  let equipmentSnapshot = {
    name: existing.equipmentName, make: existing.equipmentMake, model: existing.equipmentModel, serial: existing.equipmentSerial,
  };
  if (equipmentChanged || rigChanged) {
    const eq = loadEquipmentForRigOr400(merged.equipmentId, merged.rigId);
    equipmentSnapshot = { name: eq.name, make: eq.manufacturer, model: eq.model, serial: eq.serialNumber };
  }

  const responsibleChanged = input.responsiblePersonId !== undefined && input.responsiblePersonId !== existing.responsiblePersonId;
  const responsible = responsibleChanged
    ? resolveResponsiblePerson(merged.responsiblePersonId)
    : { id: existing.responsiblePersonId, name: existing.responsiblePerson };

  const stamp = nowIso();
  const wasOpen = existing.status !== 'Completed';
  const nowCompleted = merged.status === 'Completed';
  const closedAt = nowCompleted ? (wasOpen ? stamp : existing.closedAt) : null;

  db.prepare(`
    UPDATE internal_followups SET
      meetingDate=@meetingDate, rigId=@rigId, equipmentId=@equipmentId,
      equipmentName=@equipmentName, equipmentMake=@equipmentMake, equipmentModel=@equipmentModel, equipmentSerial=@equipmentSerial,
      equipmentStatus=@equipmentStatus, issue=@issue, discussionNote=@discussionNote, requiredAction=@requiredAction,
      responsiblePersonId=@responsiblePersonId, responsiblePerson=@responsiblePerson,
      priority=@priority, targetDate=@targetDate, status=@status, remarks=@remarks,
      updatedBy=@updatedBy, updatedAt=@stamp, closedAt=@closedAt
    WHERE id=@id
  `).run({
    id, meetingDate: merged.meetingDate, rigId: merged.rigId, equipmentId: merged.equipmentId,
    equipmentName: equipmentSnapshot.name, equipmentMake: equipmentSnapshot.make, equipmentModel: equipmentSnapshot.model,
    equipmentSerial: equipmentSnapshot.serial, equipmentStatus: merged.equipmentStatus,
    issue: merged.issue || null, discussionNote: merged.discussionNote || null, requiredAction: merged.requiredAction || null,
    responsiblePersonId: responsible.id, responsiblePerson: responsible.name,
    priority: merged.priority, targetDate: merged.targetDate || null, status: merged.status, remarks: merged.remarks || null,
    updatedBy: user, stamp, closedAt,
  });
  return get(id)!;
}

/* --------------------------------- Dashboard / Rig-wise view --------------------------------- */

export interface FollowupDashboard {
  totalOpen: number;
  highCriticalOpen: number;
  inProgress: number;
  overdue: number;
  completed: number;
  equipmentBreakdown: number;
  equipmentStopped: number;
}

function dashboard(rigIds?: string[] | null): FollowupDashboard {
  const rows = list({}, rigIds);
  return {
    totalOpen: rows.filter((r) => r.status === 'Open').length,
    highCriticalOpen: rows.filter((r) => r.status !== 'Completed' && (r.priority === 'High' || r.priority === 'Critical')).length,
    inProgress: rows.filter((r) => r.status === 'In Progress').length,
    overdue: rows.filter((r) => r.isOverdue).length,
    completed: rows.filter((r) => r.status === 'Completed').length,
    equipmentBreakdown: rows.filter((r) => r.status !== 'Completed' && r.equipmentStatus === 'Breakdown').length,
    equipmentStopped: rows.filter((r) => r.status !== 'Completed' && r.equipmentStatus === 'Stopped').length,
  };
}

export interface RigWiseRow {
  rigId: string; rigName: string; rigNumber: string;
  entries: InternalFollowupRecord[];
}

/** Rig -> Equipment -> Current Status -> Issues -> Follow-up Notes -> Action -> Responsible Person -> Target Date -> Follow-up Status, grouped for one rig. */
function rigWise(rigId: string, rigIds?: string[] | null): InternalFollowupRecord[] {
  return list({ rigId }, rigIds);
}

export const internalFollowupModel = {
  list, get, create, update, dashboard, rigWise,
};
