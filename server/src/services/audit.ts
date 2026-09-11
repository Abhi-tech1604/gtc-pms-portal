import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';

export interface AuditEntry {
  user?: string | null;
  ip?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  detail?: string | null;
}

const insert = db.prepare(`
  INSERT INTO audit_logs (id, user, time, ip, action, entity, entityId, field, oldValue, newValue, detail)
  VALUES (@id, @user, @time, @ip, @action, @entity, @entityId, @field, @oldValue, @newValue, @detail)
`);

/** Audit rows are append-only; nothing in the API ever updates or deletes them. */
export function audit(entry: AuditEntry): void {
  insert.run({
    id: newId('aud'),
    user: entry.user ?? null,
    time: nowIso(),
    ip: entry.ip ?? null,
    action: entry.action,
    entity: entry.entity ?? null,
    entityId: entry.entityId ?? null,
    field: entry.field ?? null,
    oldValue: stringify(entry.oldValue),
    newValue: stringify(entry.newValue),
    detail: entry.detail ?? null,
  });
}

/** Writes one audit row per field that actually changed. */
export function auditDiff(
  base: Omit<AuditEntry, 'field' | 'oldValue' | 'newValue'>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): number {
  let count = 0;
  for (const key of Object.keys(after)) {
    const oldValue = before[key];
    const newValue = after[key];
    if (oldValue === newValue) continue;
    if (oldValue === null && newValue === undefined) continue;
    audit({ ...base, field: key, oldValue, newValue });
    count++;
  }
  return count;
}

function stringify(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}
