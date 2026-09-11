import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { addDays, nowIso, today } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { parseWorkbook } from '../src/excel/parseWorkbook.js';
import { commitIngestion, planIngestion } from '../src/excel/ingest.js';
import {
  NOTIFICATION_TYPES, generateEquipmentHealthCheckupPendingNotifications,
  generateRigSheetPendingNotifications, listForUser, markAllRead, markRead,
  resolveEquipmentHealthCheckupPending, runDailyNotificationChecks, unreadCountForUser,
} from '../src/services/notifications.js';
import { ROLE_DEFAULTS, serialiseRights } from '../src/services/rights.js';
import { FLEET } from '../src/db/seed.js';

/**
 * The daily notification system: RIG_SHEET_PENDING and EQUIPMENT_HEALTH_
 * CHECKUP_PENDING, their eligibility rules, idempotent generation, and
 * resolution once the underlying requirement is met.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, 'fixtures', name));
const ctx = { user: 'tester', ip: '127.0.0.1' };

function reset(): void {
  transact(() => {
    for (const table of [
      'mechanical_log_rows', 'mechanical_log_uploads', 'equipment_history',
      'health_check_records', 'health_check_uploads', 'equipment',
      'rig_holidays', 'audit_logs', 'notifications', 'users', 'rigs',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const rigNumber of FLEET) {
      db.prepare(`
        INSERT INTO rigs (id, name, rigNumber, rigKey, status, createdAt)
        VALUES (?, ?, ?, ?, 'Active', ?)
      `).run(newId('rig'), rigNumber.replace(/^GTC\s*/i, 'Rig '), rigNumber, rigKey(rigNumber), nowIso());
    }
  });
}

function makeUser(opts: {
  username: string; role: keyof typeof ROLE_DEFAULTS; rigId?: string | null; status?: string;
  rights?: Partial<Record<string, boolean>>;
}): string {
  const id = newId('usr');
  const rights = serialiseRights(opts.rights ?? {}, opts.role);
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role, name, email, rigId, status, rights, createdAt)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(id, opts.username, bcrypt.hashSync('x', 4), opts.role, opts.username,
    opts.rigId ?? null, opts.status ?? 'Active', rights, nowIso());
  return id;
}

function rig(rigNumber: string): { id: string; rigNumber: string } {
  return db.prepare<[string], { id: string; rigNumber: string }>(
    'SELECT id, rigNumber FROM rigs WHERE rigNumber = ?',
  ).get(rigNumber)!;
}

before(reset);

test('a rig with no data for yesterday generates RIG_SHEET_PENDING for every eligible user', () => {
  reset();
  const uploader = makeUser({ username: 'uploader1', role: 'Rig Supervisor' });
  const asOf = today();
  const requiredDate = addDays(asOf, -1);

  const result = generateRigSheetPendingNotifications(asOf);
  assert.ok(result.rigsPending >= FLEET.length, 'every seeded rig has no data at all yet');

  const rows = listForUser(uploader);
  assert.ok(rows.length >= FLEET.length, 'the eligible user is notified for every pending rig');
  const one = rows.find((r) => r.type === NOTIFICATION_TYPES.RIG_SHEET_PENDING)!;
  assert.equal(one.referenceDate, requiredDate);
  assert.match(one.message, new RegExp(requiredDate.split('-').reverse().join('-')));
  assert.equal(one.title, 'Rig Sheet Upload Pending');
});

test('an Admin account is never notified, even though Admin carries every permission flag', () => {
  reset();
  const admin = makeUser({ username: 'admin1', role: 'Admin' });
  const operator = makeUser({ username: 'operator1', role: 'Rig Supervisor' });
  generateRigSheetPendingNotifications();
  assert.deepEqual(listForUser(admin), []);
  assert.ok(listForUser(operator).length > 0, 'a non-Admin eligible user is still notified');
});

test('a user without canUploadMechanicalLogs is never notified', () => {
  reset();
  const auditor = makeUser({ username: 'auditor1', role: 'Auditor' }); // no upload right
  generateRigSheetPendingNotifications();
  assert.deepEqual(listForUser(auditor), []);
});

test('a suspended user is never notified even if otherwise eligible', () => {
  reset();
  const suspended = makeUser({ username: 'suspended1', role: 'Rig Supervisor', status: 'Suspended' });
  generateRigSheetPendingNotifications();
  assert.deepEqual(listForUser(suspended), []);
});

test('a user assigned to one rig is notified only for that rig, not the whole fleet', () => {
  reset();
  const target = rig('GTC 50-01');
  const scoped = makeUser({ username: 'scoped1', role: 'Rig Supervisor', rigId: target.id });
  generateRigSheetPendingNotifications();

  const rows = listForUser(scoped);
  assert.equal(rows.length, 1, 'exactly one rig is theirs');
  assert.equal(rows[0].rigId, target.id);
});

test('with nobody assigned to a specific rig, every eligible fleet-wide user is notified for every pending rig', () => {
  reset();
  const a = makeUser({ username: 'fleetA', role: 'Rig Supervisor' });
  const b = makeUser({ username: 'fleetB', role: 'Rig Supervisor' });
  generateRigSheetPendingNotifications();

  assert.equal(listForUser(a).length, FLEET.length);
  assert.equal(listForUser(b).length, FLEET.length);
});

test('running the generator twice for the same day creates no duplicates (idempotency)', () => {
  reset();
  const uploader = makeUser({ username: 'uploader2', role: 'Rig Supervisor' });
  const first = generateRigSheetPendingNotifications();
  const second = generateRigSheetPendingNotifications();
  assert.ok(first.created > 0);
  assert.equal(second.created, 0, 'the second run must not create anything new');
  assert.equal(listForUser(uploader).length, first.created);
});

test('a database-level constraint enforces the dedupe, not only the application check', () => {
  reset();
  const uploader = makeUser({ username: 'uploader3', role: 'Rig Supervisor' });
  generateRigSheetPendingNotifications();
  const row = listForUser(uploader)[0];

  // Attempt the exact same insert the generator would make, bypassing its own
  // existence check, to prove the unique index — not just application logic —
  // is what prevents the duplicate.
  const dupe = () => db.prepare(`
    INSERT INTO notifications (id, type, title, message, userId, rigId, date, referenceDate, dedupeKey, severity, isRead, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'critical', 0, ?)
  `).run(
    newId('ntf'), row.type, row.title, row.message, uploader, row.rigId,
    row.referenceDate, row.referenceDate,
    `${row.type}:${uploader}:${row.referenceDate}:${row.rigId}`,
    nowIso(),
  );
  assert.throws(dupe, /UNIQUE constraint/);
});

test('the required date is always yesterday relative to asOf, not "today"', () => {
  reset();
  const uploader = makeUser({ username: 'uploader4', role: 'Rig Supervisor' });
  const asOf = '2026-08-21';
  generateRigSheetPendingNotifications(asOf);
  const row = listForUser(uploader)[0];
  assert.equal(row.referenceDate, '2026-08-20');
});

test('uploading a rig sheet for the required date resolves that rig\'s pending notification', () => {
  reset();
  const uploader = makeUser({ username: 'uploader5', role: 'Rig Supervisor' });
  const target = rig('GTC 50-02');

  // Manufacture a real workbook and re-date its only real day onto "yesterday",
  // exactly as the compliance test in ingest.test.ts does, so this exercises
  // the real commit path rather than inserting rows by hand.
  const parsed = parseWorkbook(fixture('rig-50-02-real.xlsx'));
  const requiredDate = addDays(today(), -1);
  const day = Number(requiredDate.slice(8));
  const shifted = {
    ...parsed,
    logMonth: requiredDate.slice(0, 7),
    groups: parsed.groups.map((g) => ({
      ...g,
      days: g.days.slice(-1).map((d) => ({ ...d, sheetDay: day })),
    })),
  };

  generateRigSheetPendingNotifications();
  const before = listForUser(uploader).find((n) => n.rigId === target.id)!;
  assert.equal(before.resolvedAt, null);

  const plan = planIngestion({ parsed: shifted, fileName: 'catchup.xlsx', storedFileName: 's' });
  commitIngestion(plan, ctx);

  const after = listForUser(uploader).find((n) => n.id === before.id)!;
  assert.notEqual(after.resolvedAt, null, 'the notification must be resolved, not deleted');
  assert.equal(listForUser(uploader).some((n) => n.id === before.id), true, 'history is kept');
});

test('an equipment overdue for its health checkup generates EQUIPMENT_HEALTH_CHECKUP_PENDING once', () => {
  reset();
  const inspector = makeUser({ username: 'inspector1', role: 'Rig Supervisor' });
  const target = rig('GTC 100-01');
  const eqId = newId('eq');
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, currentRunningHours, lastServiceHours,
      serviceInterval, lastHealthCheckDate, healthCheckInterval, isBreakdown, status, section, createdAt, updatedAt)
    VALUES (?, ?, 'Rig Engine 1', 'rigengine1', 'Rig Carrier Engine', 100, 0, 500, ?, 90, 0, 'Normal', 'diesel', ?, ?)
  `).run(eqId, target.id, addDays(today(), -120), nowIso(), nowIso());

  const first = generateEquipmentHealthCheckupPendingNotifications();
  assert.ok(first.created >= 1);
  const second = generateEquipmentHealthCheckupPendingNotifications();
  assert.equal(second.created, 0, 'no duplicate on a second run');

  const rows = listForUser(inspector).filter((n) => n.type === NOTIFICATION_TYPES.EQUIPMENT_HEALTH_CHECKUP_PENDING);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].equipmentId, eqId);
});

test('logging a checkup resolves its EQUIPMENT_HEALTH_CHECKUP_PENDING notification', () => {
  reset();
  const inspector = makeUser({ username: 'inspector2', role: 'Rig Supervisor' });
  const target = rig('GTC 100-02');
  const eqId = newId('eq');
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, currentRunningHours, lastServiceHours,
      serviceInterval, lastHealthCheckDate, healthCheckInterval, isBreakdown, status, section, createdAt, updatedAt)
    VALUES (?, ?, 'DG Set 1', 'dgset1', 'DG Set', 10, 0, 500, ?, 90, 0, 'Normal', 'generator', ?, ?)
  `).run(eqId, target.id, addDays(today(), -100), nowIso(), nowIso());

  generateEquipmentHealthCheckupPendingNotifications();
  const before = listForUser(inspector).find((n) => n.equipmentId === eqId)!;
  assert.equal(before.resolvedAt, null);

  resolveEquipmentHealthCheckupPending(eqId);

  const after = listForUser(inspector).find((n) => n.id === before.id)!;
  assert.notEqual(after.resolvedAt, null);
});

test('a healthy machine with no overdue checkup generates nothing', () => {
  reset();
  makeUser({ username: 'inspector3', role: 'Rig Supervisor' });
  const target = rig('GTC 100-03');
  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, currentRunningHours, lastServiceHours,
      serviceInterval, lastHealthCheckDate, healthCheckInterval, isBreakdown, status, section, createdAt, updatedAt)
    VALUES (?, ?, 'Fresh Machine', 'freshmachine', 'Others', 10, 0, 500, ?, 90, 0, 'Normal', 'diesel', ?, ?)
  `).run(newId('eq'), target.id, today(), nowIso(), nowIso());

  const result = generateEquipmentHealthCheckupPendingNotifications();
  assert.equal(result.created, 0);
});

test('the daily runner covers both types and each is independently idempotent', () => {
  reset();
  makeUser({ username: 'both1', role: 'Rig Supervisor' });
  const summary1 = runDailyNotificationChecks();
  assert.ok(NOTIFICATION_TYPES.RIG_SHEET_PENDING in summary1);
  assert.ok(NOTIFICATION_TYPES.EQUIPMENT_HEALTH_CHECKUP_PENDING in summary1);
  const summary2 = runDailyNotificationChecks();
  assert.equal(summary2[NOTIFICATION_TYPES.RIG_SHEET_PENDING].created, 0);
  assert.equal(summary2[NOTIFICATION_TYPES.EQUIPMENT_HEALTH_CHECKUP_PENDING].created, 0);
});

test('mark-as-read affects only the named notification and only for its owner', () => {
  reset();
  const a = makeUser({ username: 'reader1', role: 'Rig Supervisor' });
  const b = makeUser({ username: 'reader2', role: 'Rig Supervisor' });
  generateRigSheetPendingNotifications();

  const aRows = listForUser(a);
  const bCountBefore = unreadCountForUser(b);
  markRead(a, aRows[0].id);

  assert.equal(listForUser(a).find((n) => n.id === aRows[0].id)!.isRead, 1);
  assert.equal(unreadCountForUser(a), aRows.length - 1);
  assert.equal(unreadCountForUser(b), bCountBefore, "another user's unread count is untouched");
});

test('mark-all-read clears every unread notification for that user only', () => {
  reset();
  const a = makeUser({ username: 'reader3', role: 'Rig Supervisor' });
  const b = makeUser({ username: 'reader4', role: 'Rig Supervisor' });
  generateRigSheetPendingNotifications();

  const updated = markAllRead(a);
  assert.equal(updated, FLEET.length);
  assert.equal(unreadCountForUser(a), 0);
  assert.ok(unreadCountForUser(b) > 0, "another user's notifications are unaffected");
});

test('a rig on a declared holiday for the required date is Exempt, not pending', () => {
  reset();
  const uploader = makeUser({ username: 'uploader6', role: 'Rig Supervisor' });
  const target = rig('GTC 150-02');
  const requiredDate = addDays(today(), -1);
  db.prepare('INSERT INTO rig_holidays (id, rigId, date, type, description, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId('hol'), target.id, requiredDate, 'Holiday', 'Rig move', nowIso());

  generateRigSheetPendingNotifications();
  const rows = listForUser(uploader);
  assert.equal(rows.some((n) => n.rigId === target.id), false, 'an exempt rig raises no notification');
});
