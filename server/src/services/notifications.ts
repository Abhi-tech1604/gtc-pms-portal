import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { addDays, daysBetween, displayDate, nowIso, today } from '../util/date.js';
import { parseRights, type PermissionFlag, type Role } from './rights.js';
import { complianceFor } from './compliance.js';
import { listEquipment } from './equipmentView.js';
import { sendMail } from './mailer.js';

/**
 * The per-user notification system (as distinct from the older, rig-wide
 * machine service-due rows written directly in excel/ingest.ts, which this
 * does not touch or replace).
 *
 * Every notification type is a small "generator": a pure function of a date
 * that looks at real stored state and calls createNotification for whoever is
 * affected. Adding a new type — DOCUMENT_EXPIRING, MAINTENANCE_DUE, whatever
 * comes next — means writing one more generator and registering it in
 * GENERATORS below; nothing else in this file, the schema, or the API changes.
 */

export const NOTIFICATION_TYPES = {
  RIG_SHEET_PENDING: 'RIG_SHEET_PENDING',
  EQUIPMENT_HEALTH_CHECKUP_PENDING: 'EQUIPMENT_HEALTH_CHECKUP_PENDING',
  // DRR approval workflow (services/drrResponsibility.ts / routes/dailyRigReport.ts)
  DRR_PENDING_APPROVAL: 'DRR_PENDING_APPROVAL',
  DRR_APPROVAL_ESCALATION: 'DRR_APPROVAL_ESCALATION',
  DRR_APPROVED: 'DRR_APPROVED',
  DRR_REJECTED: 'DRR_REJECTED',
  // Equipment Master service interval
  SERVICE_DUE_SOON: 'SERVICE_DUE_SOON',
  SERVICE_OVERDUE: 'SERVICE_OVERDUE',
  SERVICE_OVERDUE_ESCALATION: 'SERVICE_OVERDUE_ESCALATION',
  // Health Check interval — HEALTH_CHECK_DUE_SOON is genuinely new; overdue
  // itself is still EQUIPMENT_HEALTH_CHECKUP_PENDING above (unchanged, so its
  // existing resolve() call sites keep working) — only the Admin escalation
  // on top of that same overdue condition is new.
  HEALTH_CHECK_DUE_SOON: 'HEALTH_CHECK_DUE_SOON',
  HEALTH_CHECK_OVERDUE_ESCALATION: 'HEALTH_CHECK_OVERDUE_ESCALATION',
  // Internal Follow-up (weekly office review meeting)
  INTERNAL_FOLLOWUP_OVERDUE: 'INTERNAL_FOLLOWUP_OVERDUE',
  INTERNAL_FOLLOWUP_OVERDUE_ESCALATION: 'INTERNAL_FOLLOWUP_OVERDUE_ESCALATION',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

/**
 * Admin > Notification Settings' defaults — used whenever a type has no row
 * in notification_settings yet (a fresh database, or a type that shipped
 * after the Admin last saved settings). Matches the brief's stated defaults
 * exactly: 24h DRR escalation, 250h service warning, 70-day health-check
 * warning.
 */
const NOTIFICATION_DEFAULTS: Record<string, {
  enabled: boolean; warningThreshold: number | null; criticalThreshold: number | null;
  escalationHours: number | null; reminderHours: number | null; inApp: boolean; email: boolean;
}> = {
  DRR_PENDING_APPROVAL: { enabled: true, warningThreshold: null, criticalThreshold: null, escalationHours: 24, reminderHours: null, inApp: true, email: false },
  DRR_APPROVAL_ESCALATION: { enabled: true, warningThreshold: null, criticalThreshold: null, escalationHours: 24, reminderHours: null, inApp: true, email: false },
  DRR_APPROVED: { enabled: true, warningThreshold: null, criticalThreshold: null, escalationHours: null, reminderHours: null, inApp: true, email: false },
  DRR_REJECTED: { enabled: true, warningThreshold: null, criticalThreshold: null, escalationHours: null, reminderHours: null, inApp: true, email: false },
  SERVICE_DUE_SOON: { enabled: true, warningThreshold: 250, criticalThreshold: 0, escalationHours: null, reminderHours: null, inApp: true, email: false },
  SERVICE_OVERDUE: { enabled: true, warningThreshold: 250, criticalThreshold: 0, escalationHours: null, reminderHours: null, inApp: true, email: false },
  SERVICE_OVERDUE_ESCALATION: { enabled: true, warningThreshold: null, criticalThreshold: 0, escalationHours: 24, reminderHours: 24, inApp: true, email: false },
  HEALTH_CHECK_DUE_SOON: { enabled: true, warningThreshold: 70, criticalThreshold: 0, escalationHours: null, reminderHours: null, inApp: true, email: false },
  HEALTH_CHECK_OVERDUE_ESCALATION: { enabled: true, warningThreshold: null, criticalThreshold: 0, escalationHours: 24, reminderHours: 24, inApp: true, email: false },
  RIG_SHEET_PENDING: { enabled: true, warningThreshold: null, criticalThreshold: null, escalationHours: null, reminderHours: null, inApp: true, email: false },
  EQUIPMENT_HEALTH_CHECKUP_PENDING: { enabled: true, warningThreshold: null, criticalThreshold: null, escalationHours: null, reminderHours: null, inApp: true, email: false },
  INTERNAL_FOLLOWUP_OVERDUE: { enabled: true, warningThreshold: null, criticalThreshold: null, escalationHours: null, reminderHours: null, inApp: true, email: false },
  INTERNAL_FOLLOWUP_OVERDUE_ESCALATION: { enabled: true, warningThreshold: null, criticalThreshold: null, escalationHours: null, reminderHours: null, inApp: true, email: false },
};

export interface NotificationSettingsRow {
  type: string; enabled: boolean; warningThreshold: number | null; criticalThreshold: number | null;
  escalationHours: number | null; reminderHours: number | null; inApp: boolean; email: boolean;
  updatedBy: string | null; updatedAt: string | null;
}

/** Every type's effective settings — a stored row, or its NOTIFICATION_DEFAULTS. Admin > Notification Settings reads/writes this. */
export function getNotificationSettings(): NotificationSettingsRow[] {
  const stored = new Map(
    db.prepare<[], any>('SELECT * FROM notification_settings').all().map((r: any) => [r.type, r]),
  );
  return Object.keys(NOTIFICATION_DEFAULTS).map((type) => {
    const row = stored.get(type);
    const def = NOTIFICATION_DEFAULTS[type];
    if (!row) return { type, ...def, updatedBy: null, updatedAt: null };
    return {
      type,
      enabled: !!row.enabled,
      warningThreshold: row.warningThreshold ?? def.warningThreshold,
      criticalThreshold: row.criticalThreshold ?? def.criticalThreshold,
      escalationHours: row.escalationHours ?? def.escalationHours,
      reminderHours: row.reminderHours ?? def.reminderHours,
      inApp: !!row.inApp,
      email: !!row.email,
      updatedBy: row.updatedBy ?? null,
      updatedAt: row.updatedAt ?? null,
    };
  });
}

export function settingsFor(type: string): NotificationSettingsRow {
  return getNotificationSettings().find((s) => s.type === type)!;
}

export function updateNotificationSettings(type: string, patch: Partial<{
  enabled: boolean; warningThreshold: number | null; criticalThreshold: number | null;
  escalationHours: number | null; reminderHours: number | null; inApp: boolean; email: boolean;
}>, user: string): NotificationSettingsRow {
  const current = settingsFor(type);
  // A plain `{...current, ...patch}` spread would overwrite a field with
  // `undefined` the moment the caller's patch object merely HAS that key set
  // to undefined (object spread doesn't skip undefined values) — every field
  // here is instead only taken from patch when it was actually provided.
  const next = {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    warningThreshold: patch.warningThreshold !== undefined ? patch.warningThreshold : current.warningThreshold,
    criticalThreshold: patch.criticalThreshold !== undefined ? patch.criticalThreshold : current.criticalThreshold,
    escalationHours: patch.escalationHours !== undefined ? patch.escalationHours : current.escalationHours,
    reminderHours: patch.reminderHours !== undefined ? patch.reminderHours : current.reminderHours,
    inApp: patch.inApp !== undefined ? patch.inApp : current.inApp,
    email: patch.email !== undefined ? patch.email : current.email,
  };
  db.prepare(`
    INSERT INTO notification_settings (type, enabled, warningThreshold, criticalThreshold, escalationHours, reminderHours, inApp, email, updatedBy, updatedAt)
    VALUES (@type, @enabled, @warningThreshold, @criticalThreshold, @escalationHours, @reminderHours, @inApp, @email, @updatedBy, @updatedAt)
    ON CONFLICT(type) DO UPDATE SET enabled=@enabled, warningThreshold=@warningThreshold, criticalThreshold=@criticalThreshold,
      escalationHours=@escalationHours, reminderHours=@reminderHours, inApp=@inApp, email=@email, updatedBy=@updatedBy, updatedAt=@updatedAt
  `).run({
    type, enabled: next.enabled ? 1 : 0, warningThreshold: next.warningThreshold, criticalThreshold: next.criticalThreshold,
    escalationHours: next.escalationHours, reminderHours: next.reminderHours, inApp: next.inApp ? 1 : 0, email: next.email ? 1 : 0,
    updatedBy: user, updatedAt: nowIso(),
  });
  return settingsFor(type);
}

export interface NotificationRow {
  id: string;
  type: string;
  title: string | null;
  message: string;
  userId: string | null;
  equipmentId: string | null;
  rigId: string | null;
  referenceDate: string | null;
  severity: string;
  isRead: number;
  resolvedAt: string | null;
  createdAt: string | null;
  readAt: string | null;
}

interface CreateInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  referenceDate: string;
  rigId?: string | null;
  equipmentId?: string | null;
  entityId?: string | null;
  severity?: 'info' | 'warning' | 'critical';
}

/**
 * The dedupe key is one plain string rather than a multi-column UNIQUE index
 * because SQLite treats every NULL in a unique index as distinct from every
 * other NULL — a multi-column constraint would silently stop deduplicating as
 * soon as any one of its columns (equipmentId for a rig-level notification,
 * rigId for a future non-rig type) is null for that row. Folding the identity
 * into one non-null string sidesteps that entirely, for any shape of key a
 * future generator needs.
 */
function dedupeKey(type: string, userId: string, referenceDate: string, extra: string): string {
  return `${type}:${userId}:${referenceDate}:${extra}`;
}

/**
 * Inserts a notification unless one with the same dedupe key already exists.
 * INSERT OR IGNORE plus the unique index makes this safe even if the generator
 * runs concurrently or is re-triggered manually — the requirement in section
 * "Prevent Duplicate Notifications" of the brief.
 */
function createNotification(input: CreateInput & { key: string }): boolean {
  const settings = settingsFor(input.type);
  if (!settings.enabled) return false;
  if (!settings.inApp && !settings.email) return false;

  let inserted = false;
  if (settings.inApp) {
    const info = db.prepare(`
      INSERT OR IGNORE INTO notifications
        (id, type, title, message, userId, equipmentId, rigId, entityId, date, referenceDate,
         dedupeKey, severity, isRead, createdAt)
      VALUES (@id, @type, @title, @message, @userId, @equipmentId, @rigId, @entityId, @referenceDate, @referenceDate,
              @dedupeKey, @severity, 0, @createdAt)
    `).run({
      id: newId('ntf'),
      type: input.type,
      title: input.title,
      message: input.message,
      userId: input.userId,
      equipmentId: input.equipmentId ?? null,
      rigId: input.rigId ?? null,
      entityId: input.entityId ?? null,
      referenceDate: input.referenceDate,
      dedupeKey: input.key,
      severity: input.severity ?? 'info',
      createdAt: nowIso(),
    });
    inserted = info.changes > 0;
  }
  // One event, one delivery decision, shared by every notification type —
  // "the same event should be able to trigger IN-APP, EMAIL, or BOTH... do
  // not create separate business logic for email alerts." Only fires on a
  // genuinely NEW occurrence (inserted, or email-only with no in-app row to
  // dedupe against), never on a re-run that hit the dedupe key.
  if (settings.email && (inserted || !settings.inApp)) sendEmailStub(input);
  return inserted;
}

/**
 * The single choke point every notification type funnels email delivery
 * through (createNotification above) — wired to the real provider configured
 * at Admin > SMTP Configuration (services/mailer.ts). Fire-and-forget: never
 * awaited and mailer.sendMail itself never throws, so a delivery failure (or
 * SMTP simply not being configured yet) must not block the in-app
 * notification it accompanies.
 */
function sendEmailStub(input: CreateInput): void {
  const to = db.prepare<[string], { email: string | null }>('SELECT email FROM users WHERE id = ?').get(input.userId)?.email;
  if (!to) return;
  void sendMail({ to, subject: input.title, text: input.message });
}

/**
 * Active, non-Admin users who can act on the given rig and hold the given
 * permission. Admin is excluded even though the Admin role carries every
 * permission flag by default (services/rights.ts ROLE_DEFAULTS.Admin) —
 * holding the flag makes an account *able* to upload or inspect, not the
 * operator *responsible* for doing so day to day, and the brief is explicit
 * that administrators should not receive these operational reminders unless
 * the business logic requires it, which it does not here.
 */
/**
 * Same three-way precedence as middleware/auth.ts's rigScope(), expressed as
 * a WHERE fragment: a user WITH user_rig_access rows is eligible only for
 * their assigned rigs (multi-rig, first); a user with NONE of those but a
 * legacy single `rigId` is eligible only for that one rig (second — the
 * three-way precedence collapses to nothing if this fallback is skipped, as
 * an earlier version of this file did); a user with neither is fleet-wide
 * (unrestricted, last).
 */
const RIG_ELIGIBILITY_SQL = `(
  EXISTS (SELECT 1 FROM user_rig_access a WHERE a.userId = u.id AND a.rigId = @rigId)
  OR (
    NOT EXISTS (SELECT 1 FROM user_rig_access a WHERE a.userId = u.id)
    AND (u.rigId IS NULL OR u.rigId = @rigId)
  )
)`;

/**
 * Active, non-Admin users who can act on the given rig and hold the given
 * permission. Admin is excluded even though the Admin role carries every
 * permission flag by default (services/rights.ts ROLE_DEFAULTS.Admin) —
 * holding the flag makes an account *able* to upload or inspect, not the
 * operator *responsible* for doing so day to day, and the brief is explicit
 * that administrators should not receive these operational reminders unless
 * the business logic requires it, which it does not here.
 */
function eligibleUsers(rigId: string, flag: PermissionFlag): { id: string }[] {
  const rows = db.prepare<{ rigId: string }, { id: string; role: string; rights: string }>(
    `SELECT u.id, u.role, u.rights FROM users u WHERE u.status = 'Active' AND u.role != 'Admin' AND ${RIG_ELIGIBILITY_SQL}`,
  ).all({ rigId });
  return rows.filter((r) => parseRights(r.rights, r.role as Role)[flag]).map((r) => ({ id: r.id }));
}

/** Every Active Admin — the fixed recipient list for every escalation type. */
function activeAdmins(): { id: string }[] {
  return db.prepare<[], { id: string }>("SELECT id FROM users WHERE status = 'Active' AND role = 'Admin'").all();
}

/**
 * Active users with PMS module access who are eligible for this rig — same
 * multi-rig precedence as eligibleUsers above, but gated on the DPR/ILM/DRR-
 * style module-access grid (moduleAccess.ts) instead of a PMS rights flag,
 * since "authorized users who have PMS module access for that Rig" is what
 * the brief asks for verbatim, not any one specific permission.
 */
function pmsUsersForRig(rigId: string): { id: string }[] {
  const rows = db.prepare<{ rigId: string }, { id: string; moduleAccess: string | null }>(
    `SELECT u.id, u.moduleAccess FROM users u WHERE u.status = 'Active' AND ${RIG_ELIGIBILITY_SQL}`,
  ).all({ rigId });
  return rows.filter((r) => {
    if (!r.moduleAccess) return false;
    try { return !!JSON.parse(r.moduleAccess)?.PMS?.access; } catch { return false; }
  }).map((r) => ({ id: r.id }));
}

/** This rig's Active Primary/Backup Storekeeper(s)/Operational Manager(s), from drr_rig_responsibility — never Department. */
function drrResponsibleUsers(rigId: string, roleType: 'Storekeeper' | 'OperationalManager'): { id: string }[] {
  return db.prepare<[string, string], { id: string }>(
    "SELECT DISTINCT userId AS id FROM drr_rig_responsibility WHERE rigId = ? AND roleType = ? AND status = 'Active'",
  ).all(rigId, roleType);
}

function rigLabel(rigId: string): { rigNumber: string; name: string } | null {
  return db.prepare<[string], { rigNumber: string; name: string }>(
    'SELECT rigNumber, name FROM rigs WHERE id = ?',
  ).get(rigId) ?? null;
}

function userDisplayName(userId: string): string {
  return db.prepare<[string], { name: string }>('SELECT name FROM users WHERE id = ?').get(userId)?.name ?? 'Unknown';
}

/** Resolves a username (drr_reports.submittedBy/rejectedBy/approvedBy are usernames) back to a user id, for notification recipients. */
function userIdForUsername(username: string): string | null {
  return db.prepare<[string], { id: string }>('SELECT id FROM users WHERE username = ?').get(username)?.id ?? null;
}

/* --------------------------- RIG_SHEET_PENDING --------------------------- */

/**
 * The business rule from the brief, verbatim: requiredDate = today - 1 day.
 * complianceFor() already answers "does this rig have data for that date,
 * accounting for declared holidays" (it is the same logic the dashboard's
 * Upload Status panel uses), so this reuses it rather than re-deriving it.
 */
export function generateRigSheetPendingNotifications(asOf: string = today()): { created: number; rigsPending: number } {
  const requiredDate = addDays(asOf, -1);
  const pendingRigs = complianceFor(requiredDate, null).filter((r) => r.status === 'Pending');

  let created = 0;
  for (const rig of pendingRigs) {
    for (const user of eligibleUsers(rig.rigId, 'canUploadMechanicalLogs')) {
      const inserted = createNotification({
        userId: user.id,
        type: NOTIFICATION_TYPES.RIG_SHEET_PENDING,
        title: 'Rig Sheet Upload Pending',
        message: `You have not uploaded the Rig Sheet data for ${displayDate(requiredDate)}. Please upload it as soon as possible.`,
        referenceDate: requiredDate,
        rigId: rig.rigId,
        severity: 'critical',
        key: dedupeKey(NOTIFICATION_TYPES.RIG_SHEET_PENDING, user.id, requiredDate, rig.rigId),
      });
      if (inserted) created++;
    }
  }
  return { created, rigsPending: pendingRigs.length };
}

/**
 * Called from inside the mechanical-log commit transaction once a rig's data
 * for a given date has actually landed. The notification is not deleted —
 * "prefer keeping notification history" — it is marked resolved, and the UI
 * shows resolved items with a visibly different, completed state.
 */
export function resolveRigSheetPending(rigId: string, coveredDates: string[]): void {
  const dates = [...new Set(coveredDates)];
  if (dates.length === 0) return;
  const stmt = db.prepare(`
    UPDATE notifications SET resolvedAt = ?
    WHERE type = ? AND rigId = ? AND referenceDate = ? AND resolvedAt IS NULL
  `);
  const now = nowIso();
  for (const date of dates) stmt.run(now, NOTIFICATION_TYPES.RIG_SHEET_PENDING, rigId, date);
}

/* ---------------------- EQUIPMENT_HEALTH_CHECKUP_PENDING ---------------------- */

/**
 * A machine's due date is calendar-driven (lastHealthCheckDate + interval),
 * not "yesterday" like the rig sheet, so this fires once when a machine first
 * crosses into Overdue rather than being re-derived as a rolling window. The
 * dedupe key is anchored to that computed due date, so if the same machine is
 * still overdue tomorrow this does not create a second notification — and if
 * a new checkup later moves the due date forward, that is a new requirement
 * with its own key, which is the correct behaviour.
 */
export function generateEquipmentHealthCheckupPendingNotifications(
  asOf: string = today(),
): { created: number; overdue: number } {
  const overdue = listEquipment(null).filter((e) => e.healthStatus === 'Overdue');

  let created = 0;
  for (const eq of overdue) {
    const dueDate = eq.lastHealthCheckDate
      ? addDays(eq.lastHealthCheckDate, eq.healthCheckInterval)
      : eq.createdAt.slice(0, 10);
    if (dueDate > asOf) continue; // defensive: healthStatus said Overdue, so this should not happen

    for (const user of eligibleUsers(eq.rigId, 'canManageHealthcheckup')) {
      const inserted = createNotification({
        userId: user.id,
        type: NOTIFICATION_TYPES.EQUIPMENT_HEALTH_CHECKUP_PENDING,
        title: 'Equipment Health Checkup Pending',
        message: `Health checkup for ${eq.name} on ${eq.rigNumber} is overdue since ${displayDate(dueDate)}. Please complete the inspection.`,
        referenceDate: dueDate,
        rigId: eq.rigId,
        equipmentId: eq.id,
        severity: 'warning',
        key: dedupeKey(NOTIFICATION_TYPES.EQUIPMENT_HEALTH_CHECKUP_PENDING, user.id, dueDate, eq.id),
      });
      if (inserted) created++;
    }
  }
  return { created, overdue: overdue.length };
}

/** Called once a checkup is actually logged for a machine (Excel or manual). */
export function resolveEquipmentHealthCheckupPending(equipmentId: string): void {
  db.prepare(`
    UPDATE notifications SET resolvedAt = ?
    WHERE type = ? AND equipmentId = ? AND resolvedAt IS NULL
  `).run(nowIso(), NOTIFICATION_TYPES.EQUIPMENT_HEALTH_CHECKUP_PENDING, equipmentId);
}

/* ------------------------------- DRR approval ------------------------------- */

/**
 * Fired synchronously the moment a report becomes PendingApproval
 * (routes/dailyRigReport.ts, both the first submission and a post-Rejected
 * resubmit) — "System reads the DRR Rig ID -> finds the Operational Manager
 * assigned to that Rig." Recipients come straight from drr_rig_responsibility
 * (Primary + Backup), never Department. The dedupe key is anchored to
 * `submittedAt`, which changes on every real submission, so a resubmit after
 * rejection correctly creates a fresh notification rather than being silently
 * swallowed by the first submission's now-resolved one.
 */
export function notifyDrrPendingApproval(report: {
  id: string; rigId: string; submittedBy: string; submittedAt: string;
}): void {
  const rig = rigLabel(report.rigId);
  if (!rig) return;
  const submitterName = userDisplayName(userIdForUsername(report.submittedBy) ?? '') || report.submittedBy;
  const time = new Date(report.submittedAt).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

  for (const manager of [...drrResponsibleUsers(report.rigId, 'OperationalManager')]) {
    createNotification({
      userId: manager.id,
      type: NOTIFICATION_TYPES.DRR_PENDING_APPROVAL,
      title: 'DRR Pending Approval',
      message: `Rig: ${rig.name}\nSubmitted by: ${submitterName}\nSubmitted at: ${time}`,
      referenceDate: report.submittedAt.slice(0, 10),
      rigId: report.rigId,
      entityId: report.id,
      severity: 'warning',
      key: dedupeKey(NOTIFICATION_TYPES.DRR_PENDING_APPROVAL, manager.id, report.submittedAt, report.id),
    });
  }
}

/** Manager approved -> notify the Storekeeper(s): the actual submitter, plus every Storekeeper assigned to the rig for visibility. Also resolves the pending/escalation notifications this decision settles. */
export function notifyDrrApproved(report: {
  id: string; rigId: string; submittedBy: string; approvedBy: string; approvedAt: string;
}): void {
  resolveDrrPendingApproval(report.id);
  const rig = rigLabel(report.rigId);
  if (!rig) return;
  const approverName = userDisplayName(userIdForUsername(report.approvedBy) ?? '') || report.approvedBy;
  const recipients = drrStorekeeperRecipients(report.rigId, report.submittedBy);

  for (const userId of recipients) {
    createNotification({
      userId,
      type: NOTIFICATION_TYPES.DRR_APPROVED,
      title: 'All Good — DRR Submitted',
      message: `Rig: ${rig.name}\nApproved by: ${approverName}`,
      referenceDate: report.approvedAt.slice(0, 10),
      rigId: report.rigId,
      entityId: report.id,
      severity: 'info',
      key: dedupeKey(NOTIFICATION_TYPES.DRR_APPROVED, userId, report.approvedAt, report.id),
    });
  }
}

/** Manager rejected -> notify the Storekeeper(s) with the reason; resolves the pending/escalation notifications this decision settles. */
export function notifyDrrRejected(report: {
  id: string; rigId: string; submittedBy: string; rejectedBy: string; rejectedAt: string; rejectionReason: string;
}): void {
  resolveDrrPendingApproval(report.id);
  const rig = rigLabel(report.rigId);
  if (!rig) return;
  const recipients = drrStorekeeperRecipients(report.rigId, report.submittedBy);

  for (const userId of recipients) {
    createNotification({
      userId,
      type: NOTIFICATION_TYPES.DRR_REJECTED,
      title: 'DRR Rejected',
      message: `Rig: ${rig.name}\nReason: ${report.rejectionReason}`,
      referenceDate: report.rejectedAt.slice(0, 10),
      rigId: report.rigId,
      entityId: report.id,
      severity: 'critical',
      key: dedupeKey(NOTIFICATION_TYPES.DRR_REJECTED, userId, report.rejectedAt, report.id),
    });
  }
}

function drrStorekeeperRecipients(rigId: string, submittedByUsername: string): string[] {
  const ids = new Set(drrResponsibleUsers(rigId, 'Storekeeper').map((u) => u.id));
  const submitterId = userIdForUsername(submittedByUsername);
  if (submitterId) ids.add(submitterId);
  return [...ids];
}

/** Approve/Reject both call this — the decision is made, so nothing about this report should still read as "pending" or "escalated" for anyone. */
function resolveDrrPendingApproval(reportId: string): void {
  db.prepare(`
    UPDATE notifications SET resolvedAt = ?
    WHERE entityId = ? AND type IN (?, ?) AND resolvedAt IS NULL
  `).run(nowIso(), reportId, NOTIFICATION_TYPES.DRR_PENDING_APPROVAL, NOTIFICATION_TYPES.DRR_APPROVAL_ESCALATION);
}

/**
 * Cron-only (time-based, no natural write to trigger from): any report still
 * PendingApproval past the configured escalation window (default 24h)
 * escalates to every Active Admin. The dedupe key is anchored to
 * `submittedAt` — exactly one escalation per submission instance, never
 * repeated on every subsequent hourly tick ("Do not send duplicate
 * escalation repeatedly for the same DRR unless configured").
 */
export function generateDrrApprovalEscalations(_asOf: string = today()): { created: number } {
  const settings = settingsFor(NOTIFICATION_TYPES.DRR_APPROVAL_ESCALATION);
  if (!settings.enabled) return { created: 0 };
  const hours = settings.escalationHours ?? 24;
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();

  const pending = db.prepare<[string], {
    id: string; rigId: string; submittedAt: string;
  }>(
    "SELECT id, rigId, submittedAt FROM drr_reports WHERE status = 'PendingApproval' AND submittedAt IS NOT NULL AND submittedAt <= ?",
  ).all(cutoff);

  let created = 0;
  for (const report of pending) {
    const rig = rigLabel(report.rigId);
    if (!rig) continue;
    const overdueHours = Math.round((Date.now() - new Date(report.submittedAt).getTime()) / 3600000);
    const managers = drrResponsibleUsers(report.rigId, 'OperationalManager');
    const managerNames = managers.map((m) => userDisplayName(m.id)).join(', ') || 'Unassigned';

    for (const admin of activeAdmins()) {
      const inserted = createNotification({
        userId: admin.id,
        type: NOTIFICATION_TYPES.DRR_APPROVAL_ESCALATION,
        title: 'DRR Approval Overdue',
        message: `Rig: ${rig.name}\nPending for: ${overdueHours} hours\nManager: ${managerNames}`,
        referenceDate: report.submittedAt.slice(0, 10),
        rigId: report.rigId,
        entityId: report.id,
        severity: 'critical',
        key: dedupeKey(NOTIFICATION_TYPES.DRR_APPROVAL_ESCALATION, admin.id, report.submittedAt, report.id),
      });
      if (inserted) created++;
    }
  }
  return { created };
}

/* --------------------------------- Service Due / Overdue --------------------------------- */

/**
 * One pass over every active machine, using the SAME remainingServiceHours
 * services/equipmentView.ts already computes for Equipment Directory/Reports
 * — no parallel calculation. Warning fires once remaining hours cross the
 * configured threshold (default 250h before due); Overdue fires once
 * remaining reaches the critical threshold (default 0) and additionally
 * escalates to Admin. The dedupe key is anchored to `nextServiceDueHours`
 * (lastServiceHours + serviceInterval) rather than a date, so once the
 * machine is actually serviced (equipmentService.ts's recordService(),
 * called from both DRR and manual Service History entry) that value moves
 * forward and the NEXT cycle's crossing gets its own fresh notification —
 * mirrors exactly how EQUIPMENT_HEALTH_CHECKUP_PENDING anchors to its
 * computed due date for the same reason.
 */
export function generateServiceNotifications(_asOf: string = today()): { created: number } {
  const warnSettings = settingsFor(NOTIFICATION_TYPES.SERVICE_DUE_SOON);
  const overdueSettings = settingsFor(NOTIFICATION_TYPES.SERVICE_OVERDUE);
  const escalationSettings = settingsFor(NOTIFICATION_TYPES.SERVICE_OVERDUE_ESCALATION);
  const warnAt = warnSettings.warningThreshold ?? 250;
  const criticalAt = overdueSettings.criticalThreshold ?? 0;

  let created = 0;
  for (const eq of listEquipment(null).filter((e) => e.isActive)) {
    const nextDue = eq.lastServiceHours + eq.serviceInterval;
    const isOverdue = eq.remainingServiceHours <= criticalAt;
    const isWarning = !isOverdue && eq.remainingServiceHours <= warnAt;
    if (!isOverdue && !isWarning) continue;

    if (isWarning && warnSettings.enabled) {
      for (const user of pmsUsersForRig(eq.rigId)) {
        const inserted = createNotification({
          userId: user.id,
          type: NOTIFICATION_TYPES.SERVICE_DUE_SOON,
          title: 'Service Due Soon',
          message: `Equipment: ${eq.name}\nRig: ${eq.rigNumber}\nRemaining: ${eq.remainingServiceHours} Hours`,
          referenceDate: today(),
          rigId: eq.rigId,
          equipmentId: eq.id,
          severity: 'warning',
          key: dedupeKey(NOTIFICATION_TYPES.SERVICE_DUE_SOON, user.id, String(nextDue), eq.id),
        });
        if (inserted) created++;
      }
    }

    if (isOverdue && overdueSettings.enabled) {
      const overdueBy = Math.abs(eq.remainingServiceHours);
      for (const user of pmsUsersForRig(eq.rigId)) {
        const inserted = createNotification({
          userId: user.id,
          type: NOTIFICATION_TYPES.SERVICE_OVERDUE,
          title: 'CRITICAL — Equipment Service Overdue',
          message: `Rig: ${eq.rigNumber}\nEquipment: ${eq.name}\nOverdue by: ${overdueBy} Hours`,
          referenceDate: today(),
          rigId: eq.rigId,
          equipmentId: eq.id,
          severity: 'critical',
          key: dedupeKey(NOTIFICATION_TYPES.SERVICE_OVERDUE, user.id, String(nextDue), eq.id),
        });
        if (inserted) created++;
      }
      if (escalationSettings.enabled) {
        for (const admin of activeAdmins()) {
          const inserted = createNotification({
            userId: admin.id,
            type: NOTIFICATION_TYPES.SERVICE_OVERDUE_ESCALATION,
            title: 'CRITICAL — Equipment Service Overdue',
            message: `Rig: ${eq.rigNumber}\nEquipment: ${eq.name}\nOverdue by: ${overdueBy} Hours`,
            referenceDate: today(),
            rigId: eq.rigId,
            equipmentId: eq.id,
            severity: 'critical',
            key: dedupeKey(NOTIFICATION_TYPES.SERVICE_OVERDUE_ESCALATION, admin.id, String(nextDue), eq.id),
          });
          if (inserted) created++;
        }
      }
    }
  }
  return { created };
}

/** Called from equipmentService.ts's recordService() — the single choke point every "service completed" write (DRR or manual) already goes through. */
export function resolveServiceNotifications(equipmentId: string): void {
  db.prepare(`
    UPDATE notifications SET resolvedAt = ?
    WHERE equipmentId = ? AND type IN (?, ?, ?) AND resolvedAt IS NULL
  `).run(
    nowIso(), equipmentId,
    NOTIFICATION_TYPES.SERVICE_DUE_SOON, NOTIFICATION_TYPES.SERVICE_OVERDUE, NOTIFICATION_TYPES.SERVICE_OVERDUE_ESCALATION,
  );
}

/* --------------------------------- Health Check Due / Overdue --------------------------------- */

/**
 * The early-warning counterpart to the existing EQUIPMENT_HEALTH_CHECKUP_PENDING
 * generator above (which still owns "overdue", unchanged, including its own
 * resolve() call sites) — this fires once remaining days cross the configured
 * threshold (default 70 days before the computed due date), calculated from
 * the ACTUAL due date (lastHealthCheckDate + healthCheckInterval), never an
 * arbitrary fixed calendar date. Dedupe is anchored to that computed due
 * date, so a completed checkup (which pushes the due date forward) naturally
 * yields a fresh key for the next cycle.
 */
export function generateHealthCheckDueSoonNotifications(asOf: string = today()): { created: number } {
  const settings = settingsFor(NOTIFICATION_TYPES.HEALTH_CHECK_DUE_SOON);
  if (!settings.enabled) return { created: 0 };
  const warnAtDays = settings.warningThreshold ?? 70;

  let created = 0;
  for (const eq of listEquipment(null).filter((e) => e.isActive && e.healthStatus === 'Upcoming')) {
    if (eq.remainingHealthCheckDays === null || eq.remainingHealthCheckDays > warnAtDays) continue;
    const dueDate = eq.lastHealthCheckDate
      ? addDays(eq.lastHealthCheckDate, eq.healthCheckInterval)
      : eq.createdAt.slice(0, 10);

    for (const user of pmsUsersForRig(eq.rigId)) {
      const inserted = createNotification({
        userId: user.id,
        type: NOTIFICATION_TYPES.HEALTH_CHECK_DUE_SOON,
        title: 'Health Check Due Soon',
        message: `Equipment: ${eq.name}\nRig: ${eq.rigNumber}\nDue Date: ${displayDate(dueDate)}`,
        referenceDate: dueDate,
        rigId: eq.rigId,
        equipmentId: eq.id,
        severity: 'warning',
        key: dedupeKey(NOTIFICATION_TYPES.HEALTH_CHECK_DUE_SOON, user.id, dueDate, eq.id),
      });
      if (inserted) created++;
    }
  }
  return { created };
}

/**
 * Reuses the SAME overdue detection the existing EQUIPMENT_HEALTH_CHECKUP_PENDING
 * generator uses (healthStatus === 'Overdue') rather than a parallel
 * calculation — this only adds the Admin escalation that generator does not
 * send, since its recipients are PMS users, not Admin.
 */
export function generateHealthCheckOverdueEscalations(asOf: string = today()): { created: number } {
  const settings = settingsFor(NOTIFICATION_TYPES.HEALTH_CHECK_OVERDUE_ESCALATION);
  if (!settings.enabled) return { created: 0 };

  let created = 0;
  for (const eq of listEquipment(null).filter((e) => e.isActive && e.healthStatus === 'Overdue')) {
    const dueDate = eq.lastHealthCheckDate
      ? addDays(eq.lastHealthCheckDate, eq.healthCheckInterval)
      : eq.createdAt.slice(0, 10);
    if (dueDate > asOf) continue;
    const overdueByDays = daysBetween(dueDate, asOf);

    for (const admin of activeAdmins()) {
      const inserted = createNotification({
        userId: admin.id,
        type: NOTIFICATION_TYPES.HEALTH_CHECK_OVERDUE_ESCALATION,
        title: 'CRITICAL — Health Check Overdue',
        message: `Rig: ${eq.rigNumber}\nEquipment: ${eq.name}\nOverdue by: ${overdueByDays} Days`,
        referenceDate: dueDate,
        rigId: eq.rigId,
        equipmentId: eq.id,
        severity: 'critical',
        key: dedupeKey(NOTIFICATION_TYPES.HEALTH_CHECK_OVERDUE_ESCALATION, admin.id, dueDate, eq.id),
      });
      if (inserted) created++;
    }
  }
  return { created };
}

/** Called alongside the existing resolveEquipmentHealthCheckupPending() at every "checkup logged" site (routes/health.ts, routes/healthNarratives.ts). */
export function resolveHealthCheckDueSoon(equipmentId: string): void {
  db.prepare(`
    UPDATE notifications SET resolvedAt = ?
    WHERE equipmentId = ? AND type IN (?, ?) AND resolvedAt IS NULL
  `).run(
    nowIso(), equipmentId,
    NOTIFICATION_TYPES.HEALTH_CHECK_DUE_SOON, NOTIFICATION_TYPES.HEALTH_CHECK_OVERDUE_ESCALATION,
  );
}

/* --------------------------------- Internal Follow-up Overdue --------------------------------- */

/**
 * A follow-up is overdue once its Target Date has passed and it is not yet
 * Completed (On Hold still counts -- it is unresolved work, just paused).
 * Fires both to the row's Responsible Person (if one is on file) and, as an
 * escalation, to every Active Admin -- "notify the responsible person...
 * notify Admin/appropriate manager." The dedupe key is anchored to
 * targetDate, so editing the target date (a real user action) correctly
 * yields a fresh notification rather than being silently swallowed by the
 * old, now-stale one; routes/internalFollowup.ts's resolveInternalFollowupOverdue()
 * clears the stale one at that same edit.
 */
export function generateInternalFollowupOverdueNotifications(asOf: string = today()): { created: number } {
  const personSettings = settingsFor(NOTIFICATION_TYPES.INTERNAL_FOLLOWUP_OVERDUE);
  const escalationSettings = settingsFor(NOTIFICATION_TYPES.INTERNAL_FOLLOWUP_OVERDUE_ESCALATION);

  const overdue = db.prepare<[string], {
    id: string; rigId: string; equipmentName: string; targetDate: string;
    responsiblePersonId: string | null; rigName: string; rigNumber: string;
  }>(`
    SELECT f.id, f.rigId, f.equipmentName, f.targetDate, f.responsiblePersonId, r.name AS rigName, r.rigNumber AS rigNumber
    FROM internal_followups f
    JOIN rigs r ON r.id = f.rigId
    WHERE f.status != 'Completed' AND f.targetDate IS NOT NULL AND f.targetDate < ?
  `).all(asOf);

  let created = 0;
  for (const row of overdue) {
    const rigDisplay = row.rigName || row.rigNumber;
    if (personSettings.enabled && row.responsiblePersonId) {
      const inserted = createNotification({
        userId: row.responsiblePersonId,
        type: NOTIFICATION_TYPES.INTERNAL_FOLLOWUP_OVERDUE,
        title: 'Internal Follow-up Overdue',
        message: `Rig: ${rigDisplay}\nEquipment: ${row.equipmentName}\nTarget Date: ${displayDate(row.targetDate)}`,
        referenceDate: row.targetDate,
        rigId: row.rigId,
        entityId: row.id,
        severity: 'warning',
        key: dedupeKey(NOTIFICATION_TYPES.INTERNAL_FOLLOWUP_OVERDUE, row.responsiblePersonId, row.targetDate, row.id),
      });
      if (inserted) created++;
    }
    if (escalationSettings.enabled) {
      for (const admin of activeAdmins()) {
        const inserted = createNotification({
          userId: admin.id,
          type: NOTIFICATION_TYPES.INTERNAL_FOLLOWUP_OVERDUE_ESCALATION,
          title: 'Internal Follow-up Overdue',
          message: `Rig: ${rigDisplay}\nEquipment: ${row.equipmentName}\nTarget Date: ${displayDate(row.targetDate)}`,
          referenceDate: row.targetDate,
          rigId: row.rigId,
          entityId: row.id,
          severity: 'warning',
          key: dedupeKey(NOTIFICATION_TYPES.INTERNAL_FOLLOWUP_OVERDUE_ESCALATION, admin.id, row.targetDate, row.id),
        });
        if (inserted) created++;
      }
    }
  }
  return { created };
}

/** Called from routes/internalFollowup.ts whenever a follow-up is explicitly saved -- clears whatever was open about its OLD state; the generator recreates a fresh one next pass if still genuinely overdue. */
export function resolveInternalFollowupOverdue(followupId: string): void {
  db.prepare(`
    UPDATE notifications SET resolvedAt = ?
    WHERE entityId = ? AND type IN (?, ?) AND resolvedAt IS NULL
  `).run(
    nowIso(), followupId,
    NOTIFICATION_TYPES.INTERNAL_FOLLOWUP_OVERDUE, NOTIFICATION_TYPES.INTERNAL_FOLLOWUP_OVERDUE_ESCALATION,
  );
}

/* --------------------------------- runner --------------------------------- */

const GENERATORS: { key: string; run: (asOf: string) => { created: number } }[] = [
  { key: NOTIFICATION_TYPES.RIG_SHEET_PENDING, run: generateRigSheetPendingNotifications },
  { key: NOTIFICATION_TYPES.EQUIPMENT_HEALTH_CHECKUP_PENDING, run: generateEquipmentHealthCheckupPendingNotifications },
  { key: NOTIFICATION_TYPES.DRR_APPROVAL_ESCALATION, run: generateDrrApprovalEscalations },
  { key: NOTIFICATION_TYPES.SERVICE_DUE_SOON, run: generateServiceNotifications },
  { key: NOTIFICATION_TYPES.HEALTH_CHECK_DUE_SOON, run: generateHealthCheckDueSoonNotifications },
  { key: NOTIFICATION_TYPES.HEALTH_CHECK_OVERDUE_ESCALATION, run: generateHealthCheckOverdueEscalations },
  { key: NOTIFICATION_TYPES.INTERNAL_FOLLOWUP_OVERDUE, run: generateInternalFollowupOverdueNotifications },
];

/**
 * Runs every registered generator. Idempotent by construction (each generator
 * relies on the same dedupe key + unique index), so this is safe to call from
 * the daily cron tick, from a server-restart catch-up, and from the manual
 * admin-triggered endpoint without ever risking a duplicate.
 */
export function runDailyNotificationChecks(asOf: string = today()): Record<string, { created: number }> {
  const summary: Record<string, { created: number }> = {};
  for (const g of GENERATORS) {
    try {
      summary[g.key] = g.run(asOf);
    } catch (err) {
      console.error(`[notifications] ${g.key} generator failed:`, err);
      summary[g.key] = { created: 0 };
    }
  }
  return summary;
}

/* --------------------------------- reads --------------------------------- */

export function listForUser(userId: string, limit = 100): NotificationRow[] {
  return db.prepare<[string, number], NotificationRow>(`
    SELECT id, type, title, message, userId, equipmentId, rigId, referenceDate,
           severity, isRead, resolvedAt, createdAt, readAt
    FROM notifications
    WHERE userId = ?
    ORDER BY createdAt DESC, id DESC
    LIMIT ?
  `).all(userId, limit);
}

export function unreadCountForUser(userId: string): number {
  return db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE userId = ? AND isRead = 0",
  ).get(userId)!.n;
}

export function markRead(userId: string, id: string): boolean {
  const info = db.prepare(
    "UPDATE notifications SET isRead = 1, readAt = ? WHERE id = ? AND userId = ? AND isRead = 0",
  ).run(nowIso(), id, userId);
  return info.changes > 0;
}

export function markAllRead(userId: string): number {
  const info = db.prepare(
    "UPDATE notifications SET isRead = 1, readAt = ? WHERE userId = ? AND isRead = 0",
  ).run(nowIso(), userId);
  return info.changes;
}

/**
 * Open (unresolved) notification counts by type, for this user only —
 * powers every role's dashboard boxes (section 8 of the brief) from one
 * generic endpoint: since recipients are already correctly scoped at
 * generation time (Storekeeper/Manager via drr_rig_responsibility, PMS User
 * via pmsUsersForRig, Admin via activeAdmins), "this user's own open
 * notifications, grouped by type" is exactly what every box needs — no
 * bespoke per-role query.
 */
export function openCountsForUser(userId: string): Record<string, number> {
  const rows = db.prepare<[string], { type: string; n: number }>(
    "SELECT type, COUNT(*) AS n FROM notifications WHERE userId = ? AND resolvedAt IS NULL GROUP BY type",
  ).all(userId);
  return Object.fromEntries(rows.map((r) => [r.type, r.n]));
}
