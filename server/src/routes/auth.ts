import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { clientIp, loadUser, requireAuth, signToken } from '../middleware/auth.js';
import { badRequest, wrap } from '../middleware/http.js';
import { parseRights, type Role } from '../services/rights.js';
import { parseModuleAccess } from '../services/moduleAccess.js';
import { parsePagePermissions } from '../services/pagePermissions.js';
import { audit } from '../services/audit.js';

export const authRouter = Router();

interface UserRow {
  id: string; username: string; passwordHash: string; role: string; name: string;
  email: string | null; rigId: string | null; status: string; rights: string;
  moduleAccess: string | null;
}

/** Every login attempt, successful or not, is recorded (spec 6.1). */
function recordLogin(input: {
  userId: string | null; username: string; ip: string; success: boolean;
  userAgent: string | null; reason?: string;
}): void {
  db.prepare(`
    INSERT INTO login_history (id, userId, username, time, ip, success, userAgent, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId('lgn'), input.userId, input.username, nowIso(), input.ip,
    input.success ? 1 : 0, input.userAgent, input.reason ?? null,
  );
}

authRouter.post('/login', wrap((req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] ?? null;

  if (!username || !password) throw badRequest('Enter both a username and a password.');

  const row = db
    .prepare<[string], UserRow>('SELECT * FROM users WHERE lower(username) = lower(?)')
    .get(username);

  if (!row) {
    recordLogin({ userId: null, username, ip, success: false, userAgent: userAgent as string, reason: 'Unknown username' });
    throw badRequest('Username or password is incorrect.');
  }
  if (row.status !== 'Active') {
    recordLogin({ userId: row.id, username, ip, success: false, userAgent: userAgent as string, reason: `Account ${row.status}` });
    throw badRequest(`This account is ${row.status.toLowerCase()}. Contact an administrator.`);
  }
  // Passwords are stored hashed; the previous build stored them in plain text.
  if (!bcrypt.compareSync(password, row.passwordHash)) {
    recordLogin({ userId: row.id, username, ip, success: false, userAgent: userAgent as string, reason: 'Wrong password' });
    throw badRequest('Username or password is incorrect.');
  }

  recordLogin({ userId: row.id, username, ip, success: true, userAgent: userAgent as string });
  audit({ user: row.username, ip, action: 'auth.login', entity: 'users', entityId: row.id });

  res.json({
    token: signToken(row.id),
    user: publicUser(row),
  });
}));

authRouter.get('/me', loadUser, requireAuth, wrap((req, res) => {
  res.json({ user: req.user });
}));

authRouter.post('/change-password', loadUser, requireAuth, wrap((req, res) => {
  const current = String(req.body?.currentPassword ?? '');
  const next = String(req.body?.newPassword ?? '');
  if (next.length < 8) throw badRequest('The new password must be at least 8 characters.');
  const row = db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(req.user!.id)!;
  if (!bcrypt.compareSync(current, row.passwordHash)) throw badRequest('The current password is incorrect.');
  db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), row.id);
  audit({ user: row.username, ip: req.clientIp, action: 'auth.password_change', entity: 'users', entityId: row.id });
  res.json({ ok: true });
}));

export function publicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    rigId: row.rigId,
    status: row.status,
    rights: parseRights(row.rights, row.role as Role),
    moduleAccess: parseModuleAccess(row.moduleAccess, row.role as Role),
    pagePermissions: parsePagePermissions(row.moduleAccess),
  };
}
