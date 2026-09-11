import type { Request } from 'express';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { badRequest, notFound } from '../middleware/http.js';
import { rigScope } from '../middleware/auth.js';

/**
 * Admin > DRR > Rig Responsibility: which Storekeeper(s) and Operational
 * Manager(s) are assigned to each rig (drr_rig_responsibility, schema.sql).
 * This is what "the system automatically sends the DRR to the assigned
 * Operational Manager" actually means here: there is no push/notification
 * layer, so routing is a live query — a manager's dashboard/list only ever
 * shows PendingApproval reports for the rigs this table says they cover,
 * and approve/reject is refused for any other rig (assertCanDecide below).
 */

export type ResponsibilityRoleType = 'Storekeeper' | 'OperationalManager';
export const RESPONSIBILITY_ROLE_TYPES: ResponsibilityRoleType[] = ['Storekeeper', 'OperationalManager'];
export type ResponsibilityTier = 'Primary' | 'Backup';
export const RESPONSIBILITY_TIERS: ResponsibilityTier[] = ['Primary', 'Backup'];

export interface ResponsibilityRow {
  id: string; rigId: string; rigNumber: string; rigName: string;
  roleType: ResponsibilityRoleType; tier: ResponsibilityTier;
  userId: string; userName: string; username: string;
  status: 'Active' | 'Inactive';
  createdBy: string; createdAt: string; updatedAt: string;
}

const BASE_SELECT = `
  SELECT rr.id, rr.rigId, r.rigNumber, r.name AS rigName, rr.roleType, rr.tier,
         rr.userId, u.name AS userName, u.username,
         rr.status, rr.createdBy, rr.createdAt, rr.updatedAt
  FROM drr_rig_responsibility rr
  JOIN rigs r ON r.id = rr.rigId
  JOIN users u ON u.id = rr.userId
`;

function list(filters: { rigId?: string }): ResponsibilityRow[] {
  let rows = db.prepare<[], ResponsibilityRow>(`${BASE_SELECT} ORDER BY r.name, rr.roleType, rr.tier`).all();
  if (filters.rigId) rows = rows.filter((r) => r.rigId === filters.rigId);
  return rows;
}

/**
 * Assigns (or reassigns) the Primary/Backup Storekeeper/Operational Manager
 * for a rig. Exactly one row per rig+roleType+tier slot (unique index) — this
 * replaces whoever held that slot rather than creating a second, so "One Rig
 * can have a Primary + Backup Storekeeper" (never three) is a structural
 * guarantee, not just a UI convention.
 */
function assign(input: { rigId: string; roleType: string; tier: string; userId: string }, admin: string): ResponsibilityRow {
  if (!RESPONSIBILITY_ROLE_TYPES.includes(input.roleType as ResponsibilityRoleType)) {
    throw badRequest('Role must be Storekeeper or Operational Manager.');
  }
  if (!RESPONSIBILITY_TIERS.includes(input.tier as ResponsibilityTier)) {
    throw badRequest('Tier must be Primary or Backup.');
  }
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE id = ?').get(input.rigId);
  if (!rig) throw badRequest('That rig does not exist.');
  const user = db.prepare<[string], { id: string; status: string }>('SELECT id, status FROM users WHERE id = ?').get(input.userId);
  if (!user) throw badRequest('That user does not exist.');
  if (user.status !== 'Active') throw badRequest('Only an Active user can be assigned rig responsibility.');

  const stamp = nowIso();
  const existing = db.prepare<[string, string, string], { id: string }>(
    'SELECT id FROM drr_rig_responsibility WHERE rigId = ? AND roleType = ? AND tier = ?',
  ).get(input.rigId, input.roleType, input.tier);

  if (existing) {
    db.prepare("UPDATE drr_rig_responsibility SET userId = @userId, status = 'Active', updatedAt = @updatedAt WHERE id = @id")
      .run({ id: existing.id, userId: input.userId, updatedAt: stamp });
    return db.prepare<[string], ResponsibilityRow>(`${BASE_SELECT} WHERE rr.id = ?`).get(existing.id)!;
  }
  const id = newId('drrresp');
  db.prepare(`
    INSERT INTO drr_rig_responsibility (id, rigId, roleType, tier, userId, status, createdBy, createdAt, updatedAt)
    VALUES (@id, @rigId, @roleType, @tier, @userId, 'Active', @createdBy, @createdAt, @updatedAt)
  `).run({
    id, rigId: input.rigId, roleType: input.roleType, tier: input.tier, userId: input.userId,
    createdBy: admin, createdAt: stamp, updatedAt: stamp,
  });
  return db.prepare<[string], ResponsibilityRow>(`${BASE_SELECT} WHERE rr.id = ?`).get(id)!;
}

function remove(id: string): void {
  const existing = db.prepare<[string], { id: string }>('SELECT id FROM drr_rig_responsibility WHERE id = ?').get(id);
  if (!existing) throw notFound('That assignment does not exist.');
  db.prepare('DELETE FROM drr_rig_responsibility WHERE id = ?').run(id);
}

export interface MyRigRoles {
  storekeeperRigIds: string[];
  managerRigIds: string[];
}

/** Every rig this user is an ACTIVE Storekeeper/Operational Manager for (either tier). */
function getUserRigRoles(userId: string): MyRigRoles {
  const rows = db.prepare<[string], { rigId: string; roleType: ResponsibilityRoleType }>(
    "SELECT rigId, roleType FROM drr_rig_responsibility WHERE userId = ? AND status = 'Active'",
  ).all(userId);
  return {
    storekeeperRigIds: [...new Set(rows.filter((r) => r.roleType === 'Storekeeper').map((r) => r.rigId))],
    managerRigIds: [...new Set(rows.filter((r) => r.roleType === 'OperationalManager').map((r) => r.rigId))],
  };
}

function isActiveManagerForRig(userId: string, rigId: string): boolean {
  return !!db.prepare<[string, string], { id: string }>(
    "SELECT id FROM drr_rig_responsibility WHERE userId = ? AND rigId = ? AND roleType = 'OperationalManager' AND status = 'Active'",
  ).get(userId, rigId);
}

/**
 * Which rig ids this request may see/act on in DRR. `null` means
 * unrestricted (Admin, or — unchanged from before this feature — a
 * globally-scoped account with no single rig and no rig responsibility rows
 * at all). Once a user has ANY responsibility row, they are hard-limited to
 * exactly those rigs: this is what stops one Storekeeper reaching another
 * Storekeeper's rig, and a Manager reaching a rig they were never assigned
 * (spec section 6 — enforced here, not just in the UI).
 */
export function drrRigIds(req: Request): string[] | null {
  if (!req.user) return [];
  if (req.user.role === 'Admin') return null;
  const roles = getUserRigRoles(req.user.id);
  const assigned = [...new Set([...roles.storekeeperRigIds, ...roles.managerRigIds])];
  if (assigned.length > 0) return assigned;
  return rigScope(req);
}

/** Throws 403 unless the request may act on this rig's DRR data at all (any responsibility role, or legacy/unrestricted access). */
export function assertDrrRigVisible(req: Request, rigId: string | null | undefined): void {
  const ids = drrRigIds(req);
  if (ids === null) return;
  if (!rigId || !ids.includes(rigId)) {
    const err = new Error('This account is not assigned to that rig in DRR.') as Error & { status?: number };
    err.status = 403;
    throw err;
  }
}

/** Throws 403 unless this request may Approve/Reject a PendingApproval report for this rig — Admin, or the rig's Active Primary/Backup Operational Manager. Nothing else qualifies, per spec section 6. */
export function assertCanDecide(req: Request, rigId: string): void {
  if (req.user?.role === 'Admin') return;
  if (req.user && isActiveManagerForRig(req.user.id, rigId)) return;
  const err = new Error('Only the Operational Manager assigned to this rig can approve or reject its Daily Rig Reports.') as Error & { status?: number };
  err.status = 403;
  throw err;
}

export const drrResponsibilityModel = { list, assign, remove, getUserRigRoles, isActiveManagerForRig };
