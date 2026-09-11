import type { Request } from 'express';
import { db } from '../db/index.js';
import { rigScope as pmsRigScope } from '../middleware/auth.js';
import { HttpError } from '../middleware/http.js';

/**
 * DPR and ILM keep their own independent rig tables (dpr_rigs/ilm_rigs), not
 * a FK to PMS's `rigs`. A user's rig assignment now lives in `user_rig_access`
 * (Admin > Users > Add/Edit User's "Assigned Rigs"), falling back to the
 * legacy single `users.rigId` (middleware/auth.ts's rigScope()). To scope a
 * rig-assigned user's DPR/ILM data server-side without a schema change, we
 * bridge each assigned PMS rigId -> its dpr_rigs/ilm_rigs id by the same
 * normalized rigKey match every other cross-module lookup in this app
 * already uses (equipmentForDprRig(), getRigTypes(), etc.).
 *
 * `restricted: false` means unrestricted (Admin, or a user with no rig
 * assigned at all). `restricted: true, rigIds: []` means every assigned PMS
 * rig has no matching DPR/ILM rig yet (or the account has zero rig
 * assignments) — every scoped query must then return nothing, not everything.
 */
export interface ModuleRigScope {
  restricted: boolean;
  rigIds: string[];
}

const UNRESTRICTED: ModuleRigScope = { restricted: false, rigIds: [] };

/** A rigId value that can never match a real row, used to force zero results when a scoped user has no bridged rig. */
export const NO_RIG_ACCESS = '__no_rig_access__';

/** Bridges PMS rig id(s) to their DPR/ILM rig counterpart(s) by rigKey — exported for the Admin Dashboard's cross-module Rig filter (Admin Dashboard's rigId query param is a PMS rig id; DPR/ILM's own dashboards key off their own rig ids). */
export function resolveModuleRigIds(pmsRigIds: string[], table: 'dpr_rigs' | 'ilm_rigs'): string[] {
  if (pmsRigIds.length === 0) return [];
  const placeholders = pmsRigIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT m.id AS id FROM ${table} m JOIN rigs r ON r.rigKey = m.rigKey WHERE r.id IN (${placeholders})`,
  ).all(...pmsRigIds) as { id: string }[];
  return rows.map((r) => r.id);
}

export function getDprRigScope(req: Request): ModuleRigScope {
  const pms = pmsRigScope(req);
  if (pms === null) return UNRESTRICTED;
  return { restricted: true, rigIds: resolveModuleRigIds(pms, 'dpr_rigs') };
}

export function getIlmRigScope(req: Request): ModuleRigScope {
  const pms = pmsRigScope(req);
  if (pms === null) return UNRESTRICTED;
  return { restricted: true, rigIds: resolveModuleRigIds(pms, 'ilm_rigs') };
}

/**
 * For list/dashboard/report endpoints that already accept an optional
 * single `rigId` filter: force it to the user's scope, overriding whatever
 * the client sent. Unrestricted callers pass the query through unchanged.
 *
 * A scope of exactly one rig (still the overwhelming common case — the
 * classic single-rig account) forces that one id, identical to this app's
 * behavior before multi-rig assignment existed. A scope of SEVERAL rigs
 * (a Storekeeper/Operational Manager covering multiple rigs) has no single
 * value these `rigId`-shaped queries can safely take, so — to fail safe
 * rather than silently under- or over-scope — it forces NO_RIG_ACCESS
 * (sees nothing) until each such endpoint is individually upgraded to an
 * `IN (...)` filter; scope.rigIds is also attached so an upgraded caller can
 * read the full list without recomputing it.
 */
export function scopedQuery(scope: ModuleRigScope, query: Record<string, unknown>): Record<string, unknown> {
  if (!scope.restricted) return query;
  const rigId = scope.rigIds.length === 1 ? scope.rigIds[0] : NO_RIG_ACCESS;
  return { ...query, rigId, rigIds: scope.rigIds };
}

/** For single-record fetch/mutation/import endpoints: reject a rigId outside the caller's scope. */
export function assertModuleRigAllowed(scope: ModuleRigScope, rigId: string | null | undefined): void {
  if (!scope.restricted) return;
  if (!rigId || !scope.rigIds.includes(rigId)) {
    throw new HttpError(403, 'This account is limited to its assigned rig(s).');
  }
}
