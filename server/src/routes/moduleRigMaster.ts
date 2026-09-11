import { Router } from 'express';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { rigKey } from '../excel/normalize.js';
import type { Request } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { badRequest, notFound, wrap, HttpError } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { config } from '../config.js';
import { assertModuleRigAllowed, NO_RIG_ACCESS, type ModuleRigScope } from '../services/rigScope.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

/**
 * DPR and ILM each need their own independent Rig Master — structurally
 * separate from PMS's `rigs` table and from each other, not a shared table
 * filtered by module. Rather than duplicating rigs.ts's CRUD/cascade-delete/
 * bulk-import logic twice nearly verbatim, this factory parameterizes it by
 * table name and dependent tables; server/src/routes/dprRigs.ts and
 * ilmRigs.ts are each a few lines calling this once.
 */

const RIG_STATUSES = ['Active', 'Idle', 'Maintenance'];

interface ModuleRigRecord {
  id: string; name: string; rigNumber: string; rigKey: string;
  status: string; createdAt: string;
}

export interface ModuleRigMasterOptions {
  table: 'dpr_rigs' | 'ilm_rigs';
  idPrefix: string;
  auditEntity: string;
  /** Tables with a rigId column pointing at this module's rig table, used for the cascade-delete warning. */
  dependents: { table: string; label: string }[];
  /** A rig-scoped user (see services/rigScope.ts) sees only their own bridged rig in this module's master list. */
  getScope: (req: Request) => ModuleRigScope;
}

export function createModuleRigMasterRouter(opts: ModuleRigMasterOptions): Router {
  const router = Router();
  const { table, auditEntity, dependents, getScope } = opts;

  router.get('/', requireAuth, wrap((req, res) => {
    const scope = getScope(req);
    // Bridged in (never fabricated): a real rigType only when this module's
    // rig matches a PMS rig by the same normalised rigKey every other
    // cross-module lookup uses. No match -> null, not a guess.
    const sql = `
      SELECT m.*, r.rigType AS rigType
      FROM ${table} m
      LEFT JOIN rigs r ON r.rigKey = m.rigKey
      ${scope.restricted ? `WHERE m.id IN (${scope.rigIds.length ? scope.rigIds.map(() => '?').join(',') : `'${NO_RIG_ACCESS}'`})` : ''}
      ORDER BY m.rigNumber
    `;
    const rigs = scope.restricted
      ? db.prepare(sql).all(...scope.rigIds)
      : db.prepare(sql).all();
    res.json({ rigs });
  }));

  router.get('/:id', requireAuth, wrap((req, res) => {
    assertModuleRigAllowed(getScope(req), req.params.id);
    const rig = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!rig) throw notFound('That rig does not exist.');
    res.json({ rig });
  }));

  router.post('/', requireAuth, requireAdmin, wrap((req, res) => {
    const rig = createModuleRig(opts, req.body ?? {}, req.user!.username, req.clientIp ?? null);
    res.status(201).json({ rig });
  }));

  router.put('/:id', requireAuth, requireAdmin, wrap((req, res) => {
    const existing = db.prepare<[string], ModuleRigRecord>(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!existing) throw notFound('That rig does not exist.');

    const body = req.body ?? {};
    const rigNumber = String(body.rigNumber ?? existing.rigNumber).trim();
    if (!rigNumber) throw badRequest('A rig number is required.');
    const key = rigKey(rigNumber);
    const clash = db.prepare<[string, string], { id: string }>(
      `SELECT id FROM ${table} WHERE rigKey = ? AND id != ?`,
    ).get(key, existing.id);
    if (clash) throw badRequest(`Another rig is already registered with a number that matches "${rigNumber}".`);

    const next = {
      id: existing.id,
      name: String(body.name ?? existing.name).trim(),
      rigNumber,
      rigKey: key,
      status: RIG_STATUSES.includes(body.status) ? body.status : existing.status,
    };

    db.prepare(`UPDATE ${table} SET name=@name, rigNumber=@rigNumber, rigKey=@rigKey, status=@status WHERE id=@id`).run(next);

    auditDiff(
      { user: req.user!.username, ip: req.clientIp, action: `${auditEntity}.update`, entity: auditEntity, entityId: existing.id },
      existing as unknown as Record<string, unknown>,
      next as unknown as Record<string, unknown>,
    );
    res.json({ rig: db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(existing.id) });
  }));

  router.delete('/:id', requireAuth, requireAdmin, wrap((req, res) => {
    const rig = db.prepare<[string], ModuleRigRecord>(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!rig) throw notFound('That rig does not exist.');

    const counts = dependents.map((d) => ({
      ...d,
      count: (db.prepare(`SELECT COUNT(*) AS n FROM ${d.table} WHERE rigId = ?`).get(rig.id) as { n: number }).n,
    }));
    const total = counts.reduce((n, c) => n + c.count, 0);
    const cascade = String(req.query.cascade ?? '') === 'true';
    if (total > 0 && !cascade) {
      const detail = counts.filter((c) => c.count > 0).map((c) => `${c.count} ${c.label}`).join(', ');
      throw new HttpError(
        409,
        `${rig.rigNumber} still has ${detail}. Deleting the rig removes all of them. Confirm to continue.`,
        { requiresConfirmation: true, counts: Object.fromEntries(counts.map((c) => [c.table, c.count])) },
      );
    }

    transact(() => {
      for (const d of dependents) db.prepare(`DELETE FROM ${d.table} WHERE rigId = ?`).run(rig.id);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rig.id);
      audit({
        user: req.user!.username, ip: req.clientIp, action: `${auditEntity}.delete`,
        entity: auditEntity, entityId: rig.id, oldValue: rig,
        detail: `Removed ${counts.map((c) => `${c.count} ${c.label}`).join(', ')}`,
      });
    });
    res.json({ ok: true, removed: Object.fromEntries(counts.map((c) => [c.table, c.count])) });
  }));

  router.get('/template/download', requireAuth, requireAdmin, wrap(async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rigs');
    ws.columns = [
      { header: 'Rig Number', key: 'rigNumber', width: 18 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Status', key: 'status', width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRow({ rigNumber: 'GTC 300-01', name: 'Rig 300-01', status: 'Active' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${opts.auditEntity}_master_template.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }));

  router.post('/import', requireAuth, requireAdmin, upload.single('file'), wrap((req, res) => {
    if (!req.file) throw badRequest('Attach an Excel file to import.');
    let rows: Record<string, unknown>[];
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
    } catch (err) {
      throw badRequest(`The file could not be read as an Excel workbook: ${(err as Error).message}`);
    }

    const created: unknown[] = [];
    const skipped: { row: number; reason: string }[] = [];

    transact(() => {
      rows.forEach((row, i) => {
        const rigNumber = pick(row, ['Rig Number', 'rigNumber', 'RigNumber', 'Rig No']);
        if (!rigNumber) { skipped.push({ row: i + 2, reason: 'No rig number in the row.' }); return; }
        try {
          created.push(createModuleRig(
            opts,
            { rigNumber, name: pick(row, ['Name', 'name', 'Rig Name']) ?? `Rig ${rigNumber}`, status: pick(row, ['Status', 'status']) },
            req.user!.username, req.clientIp ?? null,
          ));
        } catch (err) {
          skipped.push({ row: i + 2, reason: (err as Error).message });
        }
      });
    });

    res.json({ created: created.length, skipped, rigs: created });
  }));

  return router;
}

function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

export function createModuleRig(
  opts: ModuleRigMasterOptions, body: Record<string, unknown>, user: string, ip: string | null,
) {
  const { table, idPrefix, auditEntity } = opts;
  const rigNumber = String(body.rigNumber ?? '').trim();
  if (!rigNumber) throw badRequest('A rig number is required.');
  const key = rigKey(rigNumber);
  if (!key) throw badRequest(`"${rigNumber}" is not a usable rig number.`);

  const clash = db.prepare<[string], { rigNumber: string }>(`SELECT rigNumber FROM ${table} WHERE rigKey = ?`).get(key);
  if (clash) throw badRequest(`"${clash.rigNumber}" is already registered and matches "${rigNumber}".`);

  const record = {
    id: newId(idPrefix),
    name: String(body.name ?? rigNumber).trim() || rigNumber,
    rigNumber,
    rigKey: key,
    status: RIG_STATUSES.includes(body.status as string) ? (body.status as string) : 'Active',
    createdAt: nowIso(),
  };

  db.prepare(`
    INSERT INTO ${table} (id, name, rigNumber, rigKey, status, createdAt)
    VALUES (@id, @name, @rigNumber, @rigKey, @status, @createdAt)
  `).run(record);

  audit({ user, ip, action: `${auditEntity}.create`, entity: auditEntity, entityId: record.id, newValue: record });
  return record;
}
