import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { notFound, wrap } from '../middleware/http.js';
import {
  getNotificationSettings, listForUser, markAllRead, markRead, openCountsForUser,
  runDailyNotificationChecks, unreadCountForUser, updateNotificationSettings,
} from '../services/notifications.js';

export const notificationsRouter = Router();

/**
 * Every route here is scoped to req.user.id by construction — there is no path
 * that accepts a userId from the client, so one user's notifications can never
 * be read or modified through another user's session (auth still gates every
 * route, same as everywhere else in the API).
 */

notificationsRouter.get('/', requireAuth, wrap((req, res) => {
  res.json({ notifications: listForUser(req.user!.id) });
}));

notificationsRouter.get('/unread-count', requireAuth, wrap((req, res) => {
  res.json({ count: unreadCountForUser(req.user!.id) });
}));

/** Open (unresolved) counts by type for the current user — the Notification Center's / every dashboard's box counts (section 8 of the notification brief). */
notificationsRouter.get('/counts', requireAuth, wrap((req, res) => {
  res.json({ counts: openCountsForUser(req.user!.id) });
}));

/** Admin > Notification Settings — read (any authenticated user, so the client can show non-Admin-relevant thresholds e.g. "warning at 250h" without an extra Admin check) / write (Admin only). */
notificationsRouter.get('/settings', requireAuth, wrap((_req, res) => {
  res.json({ settings: getNotificationSettings() });
}));

notificationsRouter.put('/settings/:type', requireAuth, wrap((req, res) => {
  if (req.user!.role !== 'Admin') {
    res.status(403).json({ error: 'Only an administrator can change notification settings.' });
    return;
  }
  const body = req.body ?? {};
  const settings = updateNotificationSettings(req.params.type, {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    warningThreshold: 'warningThreshold' in body ? (body.warningThreshold === null ? null : Number(body.warningThreshold)) : undefined,
    criticalThreshold: 'criticalThreshold' in body ? (body.criticalThreshold === null ? null : Number(body.criticalThreshold)) : undefined,
    escalationHours: 'escalationHours' in body ? (body.escalationHours === null ? null : Number(body.escalationHours)) : undefined,
    reminderHours: 'reminderHours' in body ? (body.reminderHours === null ? null : Number(body.reminderHours)) : undefined,
    inApp: typeof body.inApp === 'boolean' ? body.inApp : undefined,
    email: typeof body.email === 'boolean' ? body.email : undefined,
  }, req.user!.username);
  res.json({ settings });
}));

notificationsRouter.post('/:id/read', requireAuth, wrap((req, res) => {
  const owned = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM notifications WHERE id = ? AND userId = ?',
  ).get(req.params.id, req.user!.id);
  if (!owned) throw notFound('That notification does not exist.');
  markRead(req.user!.id, req.params.id);
  res.json({ ok: true });
}));

notificationsRouter.post('/read-all', requireAuth, wrap((req, res) => {
  const updated = markAllRead(req.user!.id);
  res.json({ ok: true, updated });
}));

/**
 * Manual trigger for the daily check — useful for verifying the system without
 * waiting for 12:00, and as an operational escape hatch. Restricted to Admin:
 * this runs a system-wide job affecting every user's notifications, which is a
 * different kind of action than any single permission flag in the rights
 * matrix covers, so it is gated on the role directly rather than adding a
 * flag that would only ever apply to this one diagnostic endpoint.
 */
notificationsRouter.post('/generate', requireAuth, wrap((req, res) => {
  if (req.user!.role !== 'Admin') {
    res.status(403).json({ error: 'Only an administrator can trigger the notification check manually.' });
    return;
  }
  const summary = runDailyNotificationChecks();
  res.json({ summary });
}));
