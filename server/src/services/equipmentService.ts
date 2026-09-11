import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { notFound } from '../middleware/http.js';
import { resolveServiceNotifications } from './notifications.js';

/**
 * Equipment service history — mirrors health_check_records exactly: an
 * append-only log (mirrors health_check_uploads/health_check_records'
 * "log history AND move the live pointer forward" pattern for
 * lastHealthCheckDate) that never overwrites a previous entry, plus a single
 * mutable "current" pointer on the equipment row itself (lastServiceHours,
 * already existed — used everywhere remainingServiceHours is computed).
 */

export interface EquipmentServiceRecordRow {
  id: string;
  equipmentId: string;
  rigId: string;
  rigNumber: string;
  date: string;
  serviceHours: number;
  remarks: string | null;
  method: 'DRR' | 'Manual';
  recordedBy: string;
  createdAt: string;
}

export function recordService(input: {
  equipmentId: string;
  rigId: string;
  date: string;
  serviceHours: number;
  remarks: string | null;
  method: 'DRR' | 'Manual';
  user: string;
}): string {
  const equipment = db.prepare<[string], { id: string }>('SELECT id FROM equipment WHERE id = ?').get(input.equipmentId);
  if (!equipment) throw notFound('That machine does not exist.');

  const id = newId('svc');
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO equipment_service_records (id, equipmentId, rigId, date, serviceHours, remarks, method, recordedBy, createdAt)
    VALUES (@id, @equipmentId, @rigId, @date, @serviceHours, @remarks, @method, @user, @createdAt)
  `).run({
    id, equipmentId: input.equipmentId, rigId: input.rigId, date: input.date,
    serviceHours: input.serviceHours, remarks: input.remarks, method: input.method,
    user: input.user, createdAt: stamp,
  });

  db.prepare('UPDATE equipment SET lastServiceHours = ?, updatedAt = ? WHERE id = ?')
    .run(input.serviceHours, stamp, input.equipmentId);

  // "When service is completed -> notification automatically resolves" — this
  // is the one place both call sites (DRR's Service Done Today, and the
  // manual Service History form) funnel through.
  resolveServiceNotifications(input.equipmentId);

  return id;
}

export function listServiceHistory(equipmentId: string): EquipmentServiceRecordRow[] {
  return db.prepare<[string], EquipmentServiceRecordRow>(`
    SELECT s.id, s.equipmentId, s.rigId, r.rigNumber, s.date, s.serviceHours, s.remarks, s.method, s.recordedBy, s.createdAt
    FROM equipment_service_records s
    JOIN rigs r ON r.id = s.rigId
    WHERE s.equipmentId = ?
    ORDER BY s.date DESC, s.createdAt DESC
  `).all(equipmentId);
}

export interface FleetServiceRecordRow extends EquipmentServiceRecordRow {
  equipmentName: string;
}

/** The fleet-wide counterpart to listServiceHistory() — backs PMS's Service History page. */
export function listServiceHistoryFleet(filters: {
  rigId?: string; rigIds?: string[]; equipmentId?: string; dateFrom?: string; dateTo?: string;
}): FleetServiceRecordRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.rigId) { where.push('s.rigId = @rigId'); params.rigId = filters.rigId; }
  else if (filters.rigIds) {
    // A multi-rig account scope with zero assigned rigs must return nothing —
    // `1 = 0` rather than an empty `IN ()`, which SQLite rejects as invalid syntax.
    if (filters.rigIds.length === 0) { where.push('1 = 0'); }
    else {
      filters.rigIds.forEach((rid, i) => { params[`rig${i}`] = rid; });
      where.push(`s.rigId IN (${filters.rigIds.map((_, i) => `@rig${i}`).join(',')})`);
    }
  }
  if (filters.equipmentId) { where.push('s.equipmentId = @equipmentId'); params.equipmentId = filters.equipmentId; }
  if (filters.dateFrom) { where.push('s.date >= @dateFrom'); params.dateFrom = filters.dateFrom; }
  if (filters.dateTo) { where.push('s.date <= @dateTo'); params.dateTo = filters.dateTo; }

  return db.prepare<Record<string, unknown>, FleetServiceRecordRow>(`
    SELECT s.id, s.equipmentId, e.name AS equipmentName, s.rigId, r.rigNumber,
           s.date, s.serviceHours, s.remarks, s.method, s.recordedBy, s.createdAt
    FROM equipment_service_records s
    JOIN rigs r ON r.id = s.rigId
    JOIN equipment e ON e.id = s.equipmentId
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY s.date DESC, s.createdAt DESC
    LIMIT 1000
  `).all(params);
}
