import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { isIsoDate, nowIso, today } from '../util/date.js';
import { assertRigAllowed, requireAuth, requireRight, rigScope } from '../middleware/auth.js';
import { badRequest, notFound, wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';

/** Spec 6.8 and 6.11: audit registers, companies, documents, transfers, holidays. */
export const supportRouter = Router();

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

/* ---------------------------- audit registers ---------------------------- */

supportRouter.get('/audit', requireAuth, requireRight('canViewAuditLogs'), wrap((req, res) => {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (req.query.user) { filters.push('user = ?'); params.push(req.query.user); }
  if (req.query.action) { filters.push('action LIKE ?'); params.push(`${req.query.action}%`); }
  if (req.query.entity) { filters.push('entity = ?'); params.push(req.query.entity); }
  if (req.query.from) { filters.push('date(time) >= date(?)'); params.push(req.query.from); }
  if (req.query.to) { filters.push('date(time) <= date(?)'); params.push(req.query.to); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.min(Number(req.query.limit ?? 500), 2000);

  const entries = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY time DESC LIMIT ${limit}`).all(...params);
  const users = db.prepare('SELECT DISTINCT user FROM audit_logs WHERE user IS NOT NULL ORDER BY user').all();
  const actions = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all();
  res.json({ entries, users, actions });
}));

supportRouter.get('/logins', requireAuth, requireRight('canViewAuditLogs'), wrap((req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 300), 1000);
  res.json({ logins: db.prepare(`SELECT * FROM login_history ORDER BY time DESC LIMIT ${limit}`).all() });
}));

/* ---------------------------- companies ---------------------------- */

supportRouter.get('/companies', requireAuth, wrap((_req, res) => {
  res.json({
    companies: db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM rigs r WHERE r.companyId = c.id) AS rigCount
      FROM companies c ORDER BY c.name
    `).all(),
  });
}));

supportRouter.post('/companies', requireAuth, requireRight('canManageRigs'), wrap((req, res) => {
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  if (!name) throw badRequest('A company name is required.');
  const record = {
    id: newId('co'), name,
    code: body.code ?? null, gstNumber: body.gstNumber ?? null, pan: body.pan ?? null,
    contactPerson: body.contactPerson ?? null, email: body.email ?? null, phone: body.phone ?? null,
    createdAt: nowIso(),
  };
  db.prepare(`
    INSERT INTO companies (id, name, code, gstNumber, pan, contactPerson, email, phone, createdAt)
    VALUES (@id, @name, @code, @gstNumber, @pan, @contactPerson, @email, @phone, @createdAt)
  `).run(record);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'company.create', entity: 'companies', entityId: record.id, newValue: record });
  res.status(201).json({ company: record });
}));

supportRouter.put('/companies/:id', requireAuth, requireRight('canManageRigs'), wrap((req, res) => {
  const existing = db.prepare<[string], Record<string, unknown>>('SELECT * FROM companies WHERE id = ?')
    .get(req.params.id);
  if (!existing) throw notFound('That company does not exist.');
  const body = req.body ?? {};
  const next = {
    id: existing.id,
    name: String(body.name ?? existing.name).trim(),
    code: body.code ?? existing.code, gstNumber: body.gstNumber ?? existing.gstNumber,
    pan: body.pan ?? existing.pan, contactPerson: body.contactPerson ?? existing.contactPerson,
    email: body.email ?? existing.email, phone: body.phone ?? existing.phone,
  };
  db.prepare(`
    UPDATE companies SET name=@name, code=@code, gstNumber=@gstNumber, pan=@pan,
      contactPerson=@contactPerson, email=@email, phone=@phone WHERE id=@id
  `).run(next);
  auditDiff({ user: req.user!.username, ip: req.clientIp, action: 'company.update', entity: 'companies', entityId: String(existing.id) },
    existing, next as unknown as Record<string, unknown>);
  res.json({ company: next });
}));

supportRouter.delete('/companies/:id', requireAuth, requireRight('canManageRigs'), wrap((req, res) => {
  const rigs = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM rigs WHERE companyId = ?')
    .get(req.params.id)!.n;
  if (rigs > 0) throw badRequest(`${rigs} rig(s) are still assigned to this company. Reassign them first.`);
  db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'company.delete', entity: 'companies', entityId: req.params.id });
  res.json({ ok: true });
}));

/* ---------------------------- documents ---------------------------- */

supportRouter.get('/documents', requireAuth, wrap((req, res) => {
  const equipmentId = String(req.query.equipmentId ?? '');
  if (!equipmentId) throw badRequest('Specify the machine whose documents you want.');
  const equipment = db.prepare<[string], { rigId: string }>('SELECT rigId FROM equipment WHERE id = ?')
    .get(equipmentId);
  if (!equipment) throw notFound('That machine does not exist.');
  assertRigAllowed(req, equipment.rigId);
  res.json({
    documents: db.prepare(
      'SELECT id, equipmentId, docType, title, fileName, uploadDate, version, uploadedBy FROM document_files WHERE equipmentId = ? ORDER BY uploadDate DESC',
    ).all(equipmentId),
  });
}));

supportRouter.post('/documents', requireAuth, requireRight('canManageEquipment'),
  docUpload.single('file'), wrap((req, res) => {
    if (!req.file) throw badRequest('Attach a file.');
    const equipmentId = String(req.body?.equipmentId ?? '');
    const equipment = db.prepare<[string], { rigId: string }>('SELECT rigId FROM equipment WHERE id = ?')
      .get(equipmentId);
    if (!equipment) throw badRequest('Choose the machine this document belongs to.');
    assertRigAllowed(req, equipment.rigId);

    const title = String(req.body?.title ?? req.file.originalname).trim();
    const docType = String(req.body?.docType ?? 'Other');
    const previous = db.prepare<[string, string], { version: number }>(
      'SELECT MAX(version) AS version FROM document_files WHERE equipmentId = ? AND title = ?',
    ).get(equipmentId, title);

    const storedFileName = `${Date.now()}_${newId('doc')}${path.extname(req.file.originalname)}`;
    fs.writeFileSync(path.join(config.uploadDir, storedFileName), req.file.buffer);

    const record = {
      id: newId('doc'), equipmentId, docType, title,
      fileName: req.file.originalname, storedFileName,
      uploadDate: nowIso(), version: (previous?.version ?? 0) + 1,
      uploadedBy: req.user!.username,
    };
    db.prepare(`
      INSERT INTO document_files (id, equipmentId, docType, title, fileName, storedFileName, uploadDate, version, uploadedBy)
      VALUES (@id, @equipmentId, @docType, @title, @fileName, @storedFileName, @uploadDate, @version, @uploadedBy)
    `).run(record);
    audit({ user: req.user!.username, ip: req.clientIp, action: 'document.upload', entity: 'equipment', entityId: equipmentId, newValue: { title, version: record.version } });
    res.status(201).json({ document: record });
  }));

supportRouter.get('/documents/:id/file', requireAuth, wrap((req, res) => {
  const doc = db.prepare<[string], { fileName: string; storedFileName: string; equipmentId: string }>(
    'SELECT fileName, storedFileName, equipmentId FROM document_files WHERE id = ?',
  ).get(req.params.id);
  if (!doc) throw notFound('That document does not exist.');
  const equipment = db.prepare<[string], { rigId: string }>('SELECT rigId FROM equipment WHERE id = ?')
    .get(doc.equipmentId);
  assertRigAllowed(req, equipment?.rigId);
  const full = path.join(config.uploadDir, doc.storedFileName);
  if (!fs.existsSync(full)) throw notFound('That file is no longer on disk.');
  res.download(full, doc.fileName);
}));

supportRouter.delete('/documents/:id', requireAuth, requireRight('canManageEquipment'), wrap((req, res) => {
  const doc = db.prepare<[string], { id: string; equipmentId: string; title: string }>(
    'SELECT id, equipmentId, title FROM document_files WHERE id = ?',
  ).get(req.params.id);
  if (!doc) throw notFound('That document does not exist.');
  db.prepare('DELETE FROM document_files WHERE id = ?').run(doc.id);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'document.delete', entity: 'equipment', entityId: doc.equipmentId, oldValue: doc });
  res.json({ ok: true });
}));

/* ---------------------------- material transfers ---------------------------- */

supportRouter.get('/transfers', requireAuth, wrap((req, res) => {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (req.query.status) { filters.push('status = ?'); params.push(req.query.status); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json({ transfers: db.prepare(`SELECT * FROM material_transfers ${where} ORDER BY date DESC`).all(...params) });
}));

supportRouter.post('/transfers', requireAuth, requireRight('canManageTransfers'), wrap((req, res) => {
  const body = req.body ?? {};
  const materialName = String(body.materialName ?? '').trim();
  if (!materialName) throw badRequest('A material name is required.');
  const record = {
    id: newId('mt'),
    transferNumber: String(body.transferNumber ?? `MT-${Date.now()}`),
    materialName,
    quantity: Math.max(1, Math.round(Number(body.quantity ?? 1)) || 1),
    unit: body.unit ?? null,
    source: body.source ?? null,
    destination: body.destination ?? null,
    transferType: body.transferType ?? null,
    status: 'Pending',
    date: isIsoDate(body.date) ? body.date : today(),
    remarks: body.remarks ?? null,
    createdBy: req.user!.username,
    approvedBy: null,
    approvedAt: null,
  };
  db.prepare(`
    INSERT INTO material_transfers (id, transferNumber, materialName, quantity, unit, source, destination,
      transferType, status, date, remarks, createdBy, approvedBy, approvedAt)
    VALUES (@id, @transferNumber, @materialName, @quantity, @unit, @source, @destination, @transferType,
      @status, @date, @remarks, @createdBy, @approvedBy, @approvedAt)
  `).run(record);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'transfer.create', entity: 'material_transfers', entityId: record.id, newValue: record });
  res.status(201).json({ transfer: record });
}));

supportRouter.post('/transfers/:id/status', requireAuth, requireRight('canManageTransfers'), wrap((req, res) => {
  const existing = db.prepare<[string], { id: string; status: string }>(
    'SELECT id, status FROM material_transfers WHERE id = ?',
  ).get(req.params.id);
  if (!existing) throw notFound('That transfer does not exist.');
  const status = String(req.body?.status ?? '');
  if (!['Pending', 'Approved', 'Rejected', 'Completed'].includes(status)) {
    throw badRequest('Status must be Pending, Approved, Rejected or Completed.');
  }
  db.prepare('UPDATE material_transfers SET status = ?, approvedBy = ?, approvedAt = ? WHERE id = ?')
    .run(status, req.user!.username, nowIso(), existing.id);
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'transfer.status',
    entity: 'material_transfers', entityId: existing.id,
    field: 'status', oldValue: existing.status, newValue: status,
  });
  res.json({ ok: true });
}));

/* ---------------------------- rig holidays ---------------------------- */

supportRouter.get('/holidays', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  if (scope === null) {
    res.json({ holidays: db.prepare('SELECT h.*, r.rigNumber FROM rig_holidays h LEFT JOIN rigs r ON r.id = h.rigId ORDER BY h.date DESC').all() });
    return;
  }
  const idList = [...scope, 'all'];
  const sql = `SELECT h.*, r.rigNumber FROM rig_holidays h LEFT JOIN rigs r ON r.id = h.rigId WHERE h.rigId IN (${idList.map(() => '?').join(',')}) ORDER BY h.date DESC`;
  res.json({ holidays: db.prepare(sql).all(...idList) });
}));

supportRouter.post('/holidays', requireAuth, requireRight('canManageHolidays'), wrap((req, res) => {
  const body = req.body ?? {};
  const date = String(body.date ?? '');
  if (!isIsoDate(date)) throw badRequest('Give the date as YYYY-MM-DD.');
  const rigId = String(body.rigId ?? 'all');
  if (rigId !== 'all') {
    const rig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE id = ?').get(rigId);
    if (!rig) throw badRequest('That rig does not exist.');
  }
  const existing = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM rig_holidays WHERE rigId = ? AND date = ?',
  ).get(rigId, date);
  if (existing) throw badRequest(`${date} is already recorded as a non-reporting day for this selection.`);

  const record = {
    id: newId('hol'), rigId, date,
    type: body.type ?? 'Holiday',
    description: body.description ?? null,
    createdAt: nowIso(),
  };
  db.prepare('INSERT INTO rig_holidays (id, rigId, date, type, description, createdAt) VALUES (@id, @rigId, @date, @type, @description, @createdAt)')
    .run(record);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'holiday.create', entity: 'rig_holidays', entityId: record.id, newValue: record });
  res.status(201).json({ holiday: record });
}));

supportRouter.delete('/holidays/:id', requireAuth, requireRight('canManageHolidays'), wrap((req, res) => {
  const existing = db.prepare<[string], Record<string, unknown>>('SELECT * FROM rig_holidays WHERE id = ?')
    .get(req.params.id);
  if (!existing) throw notFound('That entry does not exist.');
  db.prepare('DELETE FROM rig_holidays WHERE id = ?').run(req.params.id);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'holiday.delete', entity: 'rig_holidays', entityId: req.params.id, oldValue: existing });
  res.json({ ok: true });
}));

/* ---------------------------- notifications ----------------------------
 * The per-user notification bell (RIG_SHEET_PENDING, EQUIPMENT_HEALTH_CHECKUP_
 * PENDING, and future types) lives in routes/notifications.ts, mounted at
 * /api/notifications. Nothing here duplicates that; the rig-wide machine
 * service-due rows this file's rest of the routes never touched still write
 * through excel/ingest.ts directly. */
