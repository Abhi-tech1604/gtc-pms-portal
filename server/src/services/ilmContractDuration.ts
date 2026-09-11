import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { badRequest, notFound } from '../middleware/http.js';

/**
 * ILM Contract Duration Rules: per-ILM-rig, distance-banded allowed-hours
 * rules (Admin > Master > ILM Contract Duration Rules). Every rig configures
 * its own bands independently — resolveRule()/computeAllowedHours() are the
 * only functions that read these rules, and they are called ONCE, at the
 * moment a Trailer Movement is created (services/ilmLifecycle.ts's
 * addTrailerMovement()), whose result is then frozen onto that movement row.
 * Nothing here is ever re-read for an existing movement, so editing or
 * deactivating a rule later can never change history — mirrors
 * manpowerRoster.ts's read-only, no-side-effect discipline.
 */

export interface ContractDurationRule {
  id: string;
  ilmRigId: string;
  fromDistanceKm: number;
  toDistanceKm: number | null;
  baseHours: number;
  extraHoursPerKm: number;
  roundPerKm: boolean;
  status: 'Active' | 'Inactive';
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

interface Row {
  id: string; ilmRigId: string; fromDistanceKm: number; toDistanceKm: number | null;
  baseHours: number; extraHoursPerKm: number; roundPerKm: number; status: string;
  createdBy: string; createdAt: string; updatedBy: string | null; updatedAt: string;
}

function toView(row: Row): ContractDurationRule {
  return { ...row, roundPerKm: !!row.roundPerKm, status: row.status === 'Inactive' ? 'Inactive' : 'Active' };
}

function list(filters: { ilmRigId?: string; status?: string }): ContractDurationRule[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.ilmRigId) { where.push('ilmRigId = ?'); params.push(filters.ilmRigId); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  const sql = `SELECT * FROM ilm_contract_duration_rules ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY fromDistanceKm`;
  return (db.prepare<unknown[], Row>(sql).all(...params)).map(toView);
}

function get(id: string): ContractDurationRule | undefined {
  const row = db.prepare<[string], Row>('SELECT * FROM ilm_contract_duration_rules WHERE id = ?').get(id);
  return row ? toView(row) : undefined;
}

export interface ContractDurationRuleInput {
  ilmRigId: string;
  fromDistanceKm: number;
  toDistanceKm?: number | null;
  baseHours: number;
  extraHoursPerKm?: number;
  roundPerKm?: boolean;
  status?: 'Active' | 'Inactive';
}

function validateInput(input: Partial<ContractDurationRuleInput>): void {
  if (!input.ilmRigId) throw badRequest('Select the rig this rule applies to.');
  if (input.fromDistanceKm === undefined || input.fromDistanceKm === null || input.fromDistanceKm < 0) {
    throw badRequest('Distance From (KM) must be zero or more.');
  }
  if (input.toDistanceKm !== undefined && input.toDistanceKm !== null && input.toDistanceKm <= input.fromDistanceKm) {
    throw badRequest('Distance To (KM) must be greater than Distance From, or left blank for "above X KM".');
  }
  if (input.baseHours === undefined || input.baseHours === null || input.baseHours < 0) {
    throw badRequest('Base Allowed Hours must be zero or more.');
  }
  if (input.extraHoursPerKm !== undefined && input.extraHoursPerKm !== null && input.extraHoursPerKm < 0) {
    throw badRequest('Additional Hours per KM cannot be negative.');
  }
}

function create(input: ContractDurationRuleInput, user: string): ContractDurationRule {
  validateInput(input);
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM ilm_rigs WHERE id = ?').get(input.ilmRigId);
  if (!rig) throw badRequest('That ILM rig does not exist.');

  const id = newId('ilmrule');
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO ilm_contract_duration_rules
      (id, ilmRigId, fromDistanceKm, toDistanceKm, baseHours, extraHoursPerKm, roundPerKm, status, createdBy, createdAt, updatedBy, updatedAt)
    VALUES (@id, @ilmRigId, @fromDistanceKm, @toDistanceKm, @baseHours, @extraHoursPerKm, @roundPerKm, @status, @user, @stamp, NULL, @stamp)
  `).run({
    id, ilmRigId: input.ilmRigId, fromDistanceKm: input.fromDistanceKm, toDistanceKm: input.toDistanceKm ?? null,
    baseHours: input.baseHours, extraHoursPerKm: input.extraHoursPerKm ?? 0,
    roundPerKm: input.roundPerKm === false ? 0 : 1, status: input.status === 'Inactive' ? 'Inactive' : 'Active',
    user, stamp,
  });
  return get(id)!;
}

function update(id: string, input: Partial<ContractDurationRuleInput>, user: string): ContractDurationRule {
  const existing = get(id);
  if (!existing) throw notFound('That contract duration rule does not exist.');
  const merged: ContractDurationRuleInput = {
    ilmRigId: input.ilmRigId ?? existing.ilmRigId,
    fromDistanceKm: input.fromDistanceKm ?? existing.fromDistanceKm,
    toDistanceKm: input.toDistanceKm !== undefined ? input.toDistanceKm : existing.toDistanceKm,
    baseHours: input.baseHours ?? existing.baseHours,
    extraHoursPerKm: input.extraHoursPerKm ?? existing.extraHoursPerKm,
    roundPerKm: input.roundPerKm ?? existing.roundPerKm,
    status: input.status ?? existing.status,
  };
  validateInput(merged);

  const stamp = nowIso();
  db.prepare(`
    UPDATE ilm_contract_duration_rules SET ilmRigId=@ilmRigId, fromDistanceKm=@fromDistanceKm, toDistanceKm=@toDistanceKm,
      baseHours=@baseHours, extraHoursPerKm=@extraHoursPerKm, roundPerKm=@roundPerKm, status=@status,
      updatedBy=@updatedBy, updatedAt=@stamp
    WHERE id=@id
  `).run({
    id, ...merged, toDistanceKm: merged.toDistanceKm ?? null, roundPerKm: merged.roundPerKm === false ? 0 : 1,
    updatedBy: user, stamp,
  });
  return get(id)!;
}

/**
 * The single Active band whose [fromDistanceKm, toDistanceKm] covers
 * `distanceKm` for this rig, or undefined if none is configured/matches. If
 * an Admin has misconfigured overlapping bands, the most specific one (the
 * highest fromDistanceKm still <= distanceKm) wins.
 */
function resolveRule(ilmRigId: string, distanceKm: number): ContractDurationRule | undefined {
  const row = db.prepare<[string, number, number], Row>(`
    SELECT * FROM ilm_contract_duration_rules
    WHERE ilmRigId = ? AND status = 'Active' AND fromDistanceKm <= ?
      AND (toDistanceKm IS NULL OR toDistanceKm >= ?)
    ORDER BY fromDistanceKm DESC
    LIMIT 1
  `).get(ilmRigId, distanceKm, distanceKm);
  return row ? toView(row) : undefined;
}

/**
 * Base + (extra distance beyond the band's own start, rounded up to the next
 * whole KM when roundPerKm is set) × extraHoursPerKm. A flat band (Rule 1:
 * extraHoursPerKm = 0) always resolves to exactly baseHours, since the extra
 * term is multiplied by zero regardless of where in the band the distance
 * falls — no special-casing needed. Never a literal 36 or 1.5 here; both
 * numbers always come from the matched rule.
 */
export function computeAllowedHours(rule: ContractDurationRule, distanceKm: number): number {
  const extraDistance = Math.max(0, distanceKm - rule.fromDistanceKm);
  const extraUnits = rule.roundPerKm ? Math.ceil(extraDistance) : extraDistance;
  return round2(rule.baseHours + extraUnits * rule.extraHoursPerKm);
}

export interface ContractDurationResolution {
  rule: ContractDurationRule | null;
  allowedHours: number | null;
  contractDays: number | null;
}

/** Read-only preview/resolve: what rule (if any) applies, and what it computes to, for one rig+distance. */
export function resolveContractDuration(ilmRigId: string, distanceKm: number | null): ContractDurationResolution {
  if (distanceKm === null || !Number.isFinite(distanceKm) || distanceKm < 0) {
    return { rule: null, allowedHours: null, contractDays: null };
  }
  const rule = resolveRule(ilmRigId, distanceKm);
  if (!rule) return { rule: null, allowedHours: null, contractDays: null };
  const allowedHours = computeAllowedHours(rule, distanceKm);
  return { rule, allowedHours, contractDays: round2(allowedHours / 24) };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

export const ilmContractDurationRuleModel = { list, get, create, update, resolveRule };
