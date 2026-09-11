import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { requireAuth, requirePage } from '../middleware/auth.js';
import { badRequest, notFound, wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { PERMISSION_FLAGS, ROLES, parseRights, serialiseRights, type Role } from '../services/rights.js';
import { MODULE_CODES, parseModuleAccess, serialiseModuleAccess, type ModuleCode } from '../services/moduleAccess.js';

export const usersRouter = Router();

interface UserRow {
  id: string; username: string; passwordHash: string; role: string; name: string;
  email: string | null; rigId: string | null; departmentId: string | null; status: string; rights: string;
  moduleAccess: string | null; createdAt: string;
  departmentName?: string | null; departmentModule?: string | null;
}

/** Module -> Department -> User: the join lets the client show a user's department/module without a second request. */
const SELECT_USER = `
  SELECT u.*, d.name AS departmentName, d.moduleCode AS departmentModule
  FROM users u
  LEFT JOIN departments d ON d.id = u.departmentId
`;

const selectUserRigIds = db.prepare<[string], { rigId: string }>(
  'SELECT rigId FROM user_rig_access WHERE userId = ? ORDER BY rigId',
);

function view(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    role: row.role,
    rigId: row.rigId,
    // Multi-rig assignment (Admin > Users > Add/Edit User's "Assigned Rigs")
    // — what middleware/auth.ts's rigScope() reads for PMS/DPR/ILM, and what
    // drives DRR approval routing for Storekeeper/Operational Manager (see
    // syncUserRigAssignments below). `rigId` above is kept only as the
    // legacy single-rig fallback for an account with no rows here.
    rigIds: selectUserRigIds.all(row.id).map((r) => r.rigId),
    departmentId: row.departmentId,
    departmentName: row.departmentName ?? null,
    departmentModule: row.departmentModule ?? null,
    status: row.status,
    rights: parseRights(row.rights, row.role as Role),
    moduleAccess: parseModuleAccess(row.moduleAccess, row.role as Role),
    createdAt: row.createdAt,
  };
}

function getUserView(id: string) {
  return view(db.prepare<[string], UserRow>(`${SELECT_USER} WHERE u.id = ?`).get(id)!);
}

usersRouter.get('/', requireAuth, requirePage('ADMIN','users','view'), wrap((_req, res) => {
  const rows = db.prepare<[], UserRow>(`${SELECT_USER} ORDER BY u.username`).all();
  res.json({ users: rows.map(view), roles: ROLES, permissionFlags: PERMISSION_FLAGS });
}));

usersRouter.get('/:id/logins', requireAuth, requirePage('ADMIN','users','view'), wrap((req, res) => {
  const row = db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('That user does not exist.');
  const logins = db.prepare(
    'SELECT * FROM login_history WHERE username = ? ORDER BY time DESC LIMIT 200',
  ).all(row.username);
  res.json({ logins });
}));

/** The Add/Edit User form's simple "Module Access" checkboxes (DPR/ILM/PMS/DRR) -> the full per-module CRUD grid, view/create/edit granted, delete withheld (an Admin can still fine-tune delete later via the existing Module Access modal). A richer `body.moduleAccess` object (from that modal) is honored as-is when the caller sends one instead. */
function moduleAccessFromRequest(body: Record<string, unknown>, role: Role): string {
  if (body.moduleAccess) return serialiseModuleAccess(body.moduleAccess as Record<string, unknown>, role);
  if (Array.isArray(body.moduleCodes)) {
    const checked = new Set(body.moduleCodes as string[]);
    const grid: Record<string, unknown> = {};
    for (const code of MODULE_CODES) {
      grid[code] = checked.has(code) ? { access: true, view: true, create: true, edit: true } : { access: false };
    }
    return serialiseModuleAccess(grid, role);
  }
  return serialiseModuleAccess({}, role);
}

/**
 * Admin > Users > Add/Edit User's "Assigned Rigs" checkboxes: replaces this
 * user's multi-rig scope (user_rig_access — what middleware/auth.ts's
 * rigScope() reads for PMS/DPR/ILM) in one transactional delete+insert.
 *
 * For a Storekeeper or Operational Manager, the SAME checkboxes ALSO drive
 * DRR approval routing: each checked rig gets this user as its Primary
 * Storekeeper/Operational Manager (drr_rig_responsibility), and any rig this
 * user no longer covers, or a role change away from these two roles
 * entirely, releases that Primary slot. Backup assignment is deliberately
 * left to Admin > DRR > Rig Responsibility — these checkboxes only ever
 * speak for the Primary slot they visibly promise.
 */
function syncUserRigAssignments(userId: string, rigIds: string[], role: Role, admin: string): void {
  const stamp = nowIso();
  db.prepare('DELETE FROM user_rig_access WHERE userId = ?').run(userId);
  const insertAccess = db.prepare('INSERT INTO user_rig_access (id, userId, rigId, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)');
  for (const rigId of rigIds) insertAccess.run(newId('ura'), userId, rigId, admin, stamp);

  const drrRoleType = role === 'Storekeeper' ? 'Storekeeper' : role === 'Operational Manager' ? 'OperationalManager' : null;

  // Release any Primary slot this user holds under a DIFFERENT roleType (or
  // any roleType, if they no longer qualify at all) — a role change must not
  // leave a stale approver behind.
  const staleFilter = drrRoleType
    ? "userId = ? AND tier = 'Primary' AND roleType != ?"
    : "userId = ? AND tier = 'Primary'";
  const staleArgs = drrRoleType ? [userId, drrRoleType] : [userId];
  db.prepare(`DELETE FROM drr_rig_responsibility WHERE ${staleFilter}`).run(...staleArgs);
  if (!drrRoleType) return;

  const keep = new Set(rigIds);
  const mine = db.prepare<[string, string], { id: string; rigId: string }>(
    "SELECT id, rigId FROM drr_rig_responsibility WHERE userId = ? AND tier = 'Primary' AND roleType = ?",
  ).all(userId, drrRoleType);
  for (const row of mine) {
    if (!keep.has(row.rigId)) db.prepare('DELETE FROM drr_rig_responsibility WHERE id = ?').run(row.id);
  }
  for (const rigId of rigIds) {
    const slot = db.prepare<[string, string], { id: string }>(
      "SELECT id FROM drr_rig_responsibility WHERE rigId = ? AND roleType = ? AND tier = 'Primary'",
    ).get(rigId, drrRoleType);
    if (slot) {
      // Reassigns the Primary slot to this user if someone else held it —
      // matches what checking the box in the form visibly promises.
      db.prepare("UPDATE drr_rig_responsibility SET userId = ?, status = 'Active', updatedAt = ? WHERE id = ?")
        .run(userId, stamp, slot.id);
    } else {
      db.prepare(`
        INSERT INTO drr_rig_responsibility (id, rigId, roleType, tier, userId, status, createdBy, createdAt, updatedAt)
        VALUES (?, ?, ?, 'Primary', ?, 'Active', ?, ?, ?)
      `).run(newId('drrresp'), rigId, drrRoleType, userId, admin, stamp, stamp);
    }
  }
}

function rigIdsFromBody(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.rigIds)) return [];
  return [...new Set((body.rigIds as unknown[]).map((v) => String(v)).filter(Boolean))];
}

usersRouter.post('/', requireAuth, requirePage('ADMIN','users','create'), wrap((req, res) => {
  const body = req.body ?? {};
  const username = String(body.username ?? '').trim();
  const password = String(body.password ?? '');
  if (!username) throw badRequest('A username is required.');
  if (password.length < 8) throw badRequest('The password must be at least 8 characters.');
  if (!ROLES.includes(body.role)) throw badRequest(`Choose one of: ${ROLES.join(', ')}.`);

  const clash = db.prepare<[string], { id: string }>('SELECT id FROM users WHERE lower(username) = lower(?)')
    .get(username);
  if (clash) throw badRequest(`"${username}" is already taken.`);

  // Department is no longer part of the Add New User form (no department-based
  // routing) — accepted only if a caller still explicitly sends one (the old
  // ModuleAccessModal/Department Master flow), never required.
  const departmentId = body.departmentId ? String(body.departmentId) : null;
  const rigIds = rigIdsFromBody(body);

  const record = {
    id: newId('usr'),
    username,
    // Hashed, never plain text (spec 11.4).
    passwordHash: bcrypt.hashSync(password, 10),
    role: body.role as Role,
    name: String(body.name ?? username).trim(),
    email: body.email ?? null,
    rigId: rigIds[0] ?? (body.rigId || null),
    departmentId,
    status: body.status === 'Suspended' ? 'Suspended' : 'Active',
    rights: serialiseRights(body.rights ?? {}, body.role as Role),
    moduleAccess: moduleAccessFromRequest(body, body.role as Role),
    createdAt: nowIso(),
  };

  transact(() => {
    db.prepare(`
      INSERT INTO users (id, username, passwordHash, role, name, email, rigId, departmentId, status, rights, moduleAccess, createdAt)
      VALUES (@id, @username, @passwordHash, @role, @name, @email, @rigId, @departmentId, @status, @rights, @moduleAccess, @createdAt)
    `).run(record);
    syncUserRigAssignments(record.id, rigIds, record.role, req.user!.username);
  });

  audit({
    user: req.user!.username, ip: req.clientIp, action: 'user.create',
    entity: 'users', entityId: record.id,
    newValue: { username, role: record.role, rigIds },
  });
  res.status(201).json({ user: getUserView(record.id) });
}));

usersRouter.put('/:id', requireAuth, requirePage('ADMIN','users','edit'), wrap((req, res) => {
  const existing = db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That user does not exist.');
  const body = req.body ?? {};

  // Department is no longer required or edited from this form — 'departmentId'
  // in body still lets the old Department Master flow clear/change it explicitly.
  const departmentId = 'departmentId' in body ? (body.departmentId ? String(body.departmentId) : null) : existing.departmentId;

  const role = ROLES.includes(body.role) ? (body.role as Role) : (existing.role as Role);
  const rigIds = 'rigIds' in body ? rigIdsFromBody(body) : selectUserRigIds.all(existing.id).map((r) => r.rigId);
  const next = {
    id: existing.id,
    name: String(body.name ?? existing.name).trim(),
    email: body.email ?? existing.email,
    role,
    rigId: rigIds[0] ?? ('rigId' in body ? (body.rigId || null) : existing.rigId),
    departmentId,
    status: ['Active', 'Suspended'].includes(body.status) ? body.status : existing.status,
    rights: body.rights
      ? serialiseRights(body.rights, role)
      : serialiseRights(parseRights(existing.rights, existing.role as Role), role),
    moduleAccess: (body.moduleAccess || body.moduleCodes)
      ? moduleAccessFromRequest(body, role)
      : serialiseModuleAccess(parseModuleAccess(existing.moduleAccess, existing.role as Role), role),
  };

  transact(() => {
    db.prepare(`
      UPDATE users SET name=@name, email=@email, role=@role, rigId=@rigId, departmentId=@departmentId,
        status=@status, rights=@rights, moduleAccess=@moduleAccess
      WHERE id=@id
    `).run(next);
    if ('rigIds' in body || role !== existing.role) {
      syncUserRigAssignments(existing.id, rigIds, role, req.user!.username);
    }
  });

  if (body.password) {
    const password = String(body.password);
    if (password.length < 8) throw badRequest('The password must be at least 8 characters.');
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), existing.id);
    audit({
      user: req.user!.username, ip: req.clientIp, action: 'user.password_reset',
      entity: 'users', entityId: existing.id,
    });
  }

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'user.update', entity: 'users', entityId: existing.id },
    existing as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
  );
  res.json({ user: getUserView(existing.id) });
}));

/** Spec 6.10: the per-user matrix of the ten permission flags. */
usersRouter.put('/:id/rights', requireAuth, requirePage('ADMIN','user_rights','edit'), wrap((req, res) => {
  const existing = db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That user does not exist.');
  const before = parseRights(existing.rights, existing.role as Role);
  const rights = serialiseRights(req.body?.rights ?? {}, existing.role as Role);
  db.prepare('UPDATE users SET rights = ? WHERE id = ?').run(rights, existing.id);
  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'user.rights', entity: 'users', entityId: existing.id },
    before as unknown as Record<string, unknown>,
    JSON.parse(rights) as Record<string, unknown>,
  );
  res.json({ user: getUserView(existing.id) });
}));

usersRouter.delete('/:id', requireAuth, requirePage('ADMIN','users','delete'), wrap((req, res) => {
  const existing = db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) throw notFound('That user does not exist.');
  if (existing.id === req.user!.id) throw badRequest('You cannot delete the account you are signed in with.');

  const admins = db.prepare<[], { n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'Admin' AND status = 'Active'",
  ).get()!.n;
  if (existing.role === 'Admin' && admins <= 1) {
    throw badRequest('This is the last active Admin account. Create another before deleting this one.');
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(existing.id);
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'user.delete',
    entity: 'users', entityId: existing.id, oldValue: { username: existing.username, role: existing.role },
  });
  res.json({ ok: true });
}));
