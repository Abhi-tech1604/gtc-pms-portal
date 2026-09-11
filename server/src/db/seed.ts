import bcrypt from 'bcryptjs';
import { db, transact } from './index.js';
import { migrate } from './migrate.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { rigKey } from '../excel/normalize.js';
import { ROLE_DEFAULTS } from '../services/rights.js';

/**
 * Seed data is the 16-rig fleet of section 2.4 and one Admin account. There are
 * deliberately no demo machines, uploads or log rows: every figure the portal
 * shows must come from a real workbook.
 */

export const FLEET = [
  'GTC 50-01', 'GTC 100-02', 'GTC 150-02', 'GTC 1000-01',
  'GTC 50-02', 'GTC 100-03', 'GTC 160-0', 'GTC 1000-02',
  'GTC 50-03', 'GTC 100-04', 'GTC 200-01', 'GTC 2000-01',
  'GTC 100-01', 'GTC 100-07', 'GTC 250-01', 'GTC 100-08',
];

const DEFAULT_ADMIN = {
  username: process.env.ADMIN_USERNAME || 'admin',
  password: process.env.ADMIN_PASSWORD || 'ChangeMe123!',
  name: 'System Administrator',
};

export function ensureSeed(): void {
  transact(() => {
    seedRigs();
    seedAdmin();
  });
}

function seedRigs(): void {
  const insert = db.prepare(`
    INSERT INTO rigs (id, name, rigNumber, rigKey, companyId, location, rigType, status, commissionDate, createdAt)
    VALUES (@id, @name, @rigNumber, @rigKey, NULL, NULL, @rigType, 'Active', NULL, @createdAt)
  `);
  const exists = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE rigKey = ?');

  for (const rigNumber of FLEET) {
    const key = rigKey(rigNumber);
    if (exists.get(key)) continue;
    insert.run({
      id: newId('rig'),
      name: rigNumber.replace(/^GTC\s*/i, 'Rig '),
      rigNumber,
      rigKey: key,
      rigType: 'Drilling',
      createdAt: nowIso(),
    });
  }
}

function seedAdmin(): void {
  const existing = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'Admin'").get()!;
  if (existing.n > 0) return;
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role, name, email, rigId, status, rights, createdAt)
    VALUES (@id, @username, @passwordHash, 'Admin', @name, NULL, NULL, 'Active', @rights, @createdAt)
  `).run({
    id: newId('usr'),
    username: DEFAULT_ADMIN.username,
    passwordHash: bcrypt.hashSync(DEFAULT_ADMIN.password, 10),
    name: DEFAULT_ADMIN.name,
    rights: JSON.stringify(ROLE_DEFAULTS.Admin),
    createdAt: nowIso(),
  });
  console.log(
    `Created the initial Admin account "${DEFAULT_ADMIN.username}". ` +
    'Sign in and change the password immediately.',
  );
}

if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  migrate();
  ensureSeed();
  const rigs = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM rigs').get()!.n;
  console.log(`Seed complete. ${rigs} rigs registered.`);
}
