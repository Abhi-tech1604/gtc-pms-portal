import { Router } from 'express';
import { requireAuth, requirePage } from '../middleware/auth.js';
import { notFound, wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { internalFollowupModel } from '../services/internalFollowup.js';
import { resolveInternalFollowupOverdue } from '../services/notifications.js';

/**
 * Internal Follow-up: weekly office review meeting log. Admin-only for now,
 * matching the brief's "ADMIN SIDEBAR" framing and "Admin should have fleet-
 * wide visibility. Rig users should only see their permitted Rig data if this
 * module is later enabled for them" -- there is no rig-user-facing surface
 * yet, so every route here is gated requireAdmin rather than a rig scope.
 */
export const internalFollowupRouter = Router();

internalFollowupRouter.get('/', requireAuth, requirePage('FOLLOWUP','dashboard','view'), wrap((req, res) => {
  const q = req.query;
  const rows = internalFollowupModel.list({
    rigId: q.rigId as string | undefined,
    equipmentId: q.equipmentId as string | undefined,
    status: q.status as string | undefined,
    priority: q.priority as string | undefined,
    responsiblePersonId: q.responsiblePersonId as string | undefined,
    dateFrom: q.dateFrom as string | undefined,
    dateTo: q.dateTo as string | undefined,
  });
  res.json({ followups: rows });
}));

internalFollowupRouter.get('/dashboard', requireAuth, requirePage('FOLLOWUP','dashboard','view'), wrap((_req, res) => {
  res.json({ dashboard: internalFollowupModel.dashboard() });
}));

internalFollowupRouter.get('/rig-wise', requireAuth, requirePage('FOLLOWUP','dashboard','view'), wrap((req, res) => {
  const rigId = req.query.rigId as string | undefined;
  if (!rigId) { res.json({ followups: [] }); return; }
  res.json({ followups: internalFollowupModel.rigWise(rigId) });
}));

internalFollowupRouter.get('/:id', requireAuth, requirePage('FOLLOWUP','history','view'), wrap((req, res) => {
  const row = internalFollowupModel.get(req.params.id);
  if (!row) throw notFound('That follow-up entry does not exist.');
  res.json({ followup: row });
}));

internalFollowupRouter.post('/', requireAuth, requirePage('FOLLOWUP','new','create'), wrap((req, res) => {
  const body = req.body ?? {};
  const record = internalFollowupModel.create({
    meetingDate: String(body.meetingDate ?? ''),
    rigId: String(body.rigId ?? ''),
    equipmentId: String(body.equipmentId ?? ''),
    equipmentStatus: String(body.equipmentStatus ?? ''),
    issue: body.issue ?? null,
    discussionNote: body.discussionNote ?? null,
    requiredAction: body.requiredAction ?? null,
    responsiblePersonId: body.responsiblePersonId || null,
    priority: body.priority ?? 'Medium',
    targetDate: body.targetDate || null,
    status: body.status ?? 'Open',
    remarks: body.remarks ?? null,
  }, req.user!.username);

  audit({ user: req.user!.username, ip: req.clientIp, action: 'internalFollowup.create', entity: 'internal_followups', entityId: record.id, newValue: record });
  res.status(201).json({ followup: record });
}));

internalFollowupRouter.put('/:id', requireAuth, requirePage('FOLLOWUP','history','edit'), wrap((req, res) => {
  const existing = internalFollowupModel.get(req.params.id);
  if (!existing) throw notFound('That follow-up entry does not exist.');

  const body = req.body ?? {};
  const record = internalFollowupModel.update(req.params.id, {
    meetingDate: body.meetingDate, rigId: body.rigId, equipmentId: body.equipmentId,
    equipmentStatus: body.equipmentStatus,
    issue: body.issue !== undefined ? body.issue : undefined,
    discussionNote: body.discussionNote !== undefined ? body.discussionNote : undefined,
    requiredAction: body.requiredAction !== undefined ? body.requiredAction : undefined,
    responsiblePersonId: body.responsiblePersonId !== undefined ? (body.responsiblePersonId || null) : undefined,
    priority: body.priority, targetDate: body.targetDate !== undefined ? (body.targetDate || null) : undefined,
    status: body.status, remarks: body.remarks !== undefined ? body.remarks : undefined,
  }, req.user!.username);

  // A real edit is a "decision" event the same way DRR approve/reject is --
  // whatever was open about the OLD state of this row (an old target date, a
  // now-Completed/On-Hold status, a since-changed responsible person) is
  // stale the moment this save lands; the daily generator recreates a fresh,
  // correct notification on its next pass if the row is still genuinely
  // overdue after the edit.
  resolveInternalFollowupOverdue(record.id);

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'internalFollowup.update', entity: 'internal_followups', entityId: existing.id },
    existing as unknown as Record<string, unknown>,
    record as unknown as Record<string, unknown>,
  );
  res.json({ followup: record });
}));
