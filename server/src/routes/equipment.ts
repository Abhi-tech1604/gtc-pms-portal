import { Router } from 'express';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { nameKey, serialKey } from '../excel/normalize.js';
import { assertRigAllowed, requireAdmin, requireAnyPage, requireAuth, rigScope } from '../middleware/auth.js';
import { badRequest, notFound, wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { equipmentStatus } from '../services/calc.js';
import { getEquipment, listEquipment } from '../services/equipmentView.js';
import { recordService, listServiceHistory, listServiceHistoryFleet } from '../services/equipmentService.js';
import { materialMasterModel } from '../services/materialMaster.js';
import { equipmentOilLubricantsModel } from '../services/equipmentOilLubricants.js';
import { buildImportPreview, commitImport, listImportHistory, parseRigEquipmentWorkbook } from '../services/rigMasterDataImport.js';
import { config } from '../config.js';

export const equipmentRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

export const CATEGORIES = [
  'Rig Carrier Engine', 'Mud Pump Engine', 'Mud Pump', 'DG Set', 'Air Compressor',
  'Fire Pump', 'Transmission', 'Generator', 'BCU', 'Crane', 'Trailer', 'Others',
];

equipmentRouter.get('/', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  let items = listEquipment(scope);

  const rigId = req.query.rigId as string | undefined;
  const category = req.query.category as string | undefined;
  const status = req.query.status as string | undefined;
  const search = (req.query.search as string | undefined)?.trim().toLowerCase();
  const includeInactive = String(req.query.includeInactive ?? '') === 'true';

  if (!includeInactive) items = items.filter((e) => e.isActive);
  if (rigId) items = items.filter((e) => e.rigId === rigId);
  if (category) items = items.filter((e) => e.category === category);
  if (status) items = items.filter((e) => e.status === status);
  if (search) {
    items = items.filter((e) =>
      [e.name, e.serialNumber, e.model, e.manufacturer, e.rigNumber, e.category]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(search)),
    );
  }
  res.json({ equipment: items, categories: CATEGORIES });
}));

/** PMS > Service History: the fleet-wide counterpart to Equipment Detail's own Service History tab. */
equipmentRouter.get('/service-history', requireAuth, wrap((req, res) => {
  const scope = rigScope(req);
  const rigId = req.query.rigId as string | undefined;
  if (rigId) assertRigAllowed(req, rigId);

  const records = listServiceHistoryFleet({
    rigId,
    rigIds: !rigId && scope ? scope : undefined,
    equipmentId: req.query.equipmentId as string | undefined,
    dateFrom: req.query.dateFrom as string | undefined,
    dateTo: req.query.dateTo as string | undefined,
  });
  res.json({ records });
}));

equipmentRouter.get('/:id', requireAuth, wrap((req, res) => {
  const item = getEquipment(req.params.id);
  if (!item) throw notFound('That machine does not exist.');
  assertRigAllowed(req, item.rigId);

  const history = db.prepare(
    'SELECT * FROM equipment_history WHERE equipmentId = ? ORDER BY date DESC, id DESC LIMIT 200',
  ).all(item.id);
  const healthChecks = db.prepare(
    'SELECT * FROM health_check_records WHERE equipmentId = ? ORDER BY date DESC LIMIT 100',
  ).all(item.id);
  const serviceRecords = listServiceHistory(item.id);
  const engineRecord = item.linkedEngineId ? materialMasterModel.get(item.linkedEngineId) : undefined;
  const transmissionRecord = item.linkedTransmissionId ? materialMasterModel.get(item.linkedTransmissionId) : undefined;
  const linkedEngine = engineRecord ? [engineRecord] : [];
  const linkedTransmission = transmissionRecord ? [transmissionRecord] : [];
  const documents = db.prepare(
    'SELECT id, docType, title, fileName, uploadDate, version, uploadedBy FROM document_files WHERE equipmentId = ? ORDER BY uploadDate DESC',
  ).all(item.id);
  const recentRows = db.prepare(`
    SELECT l.*, u.fileName FROM mechanical_log_rows l
    JOIN mechanical_log_uploads u ON u.id = l.uploadId
    WHERE l.equipmentId = ? ORDER BY l.logDate DESC LIMIT 60
  `).all(item.id);

  const assignedOils = equipmentOilLubricantsModel.listForEquipment(item.id);

  res.json({ equipment: item, history, healthChecks, serviceRecords, linkedEngine, linkedTransmission, assignedOils, documents, recentRows });
}));

/** Head Office / Admin manual service entry — the Spanner button's counterpart to health-narratives' manual checkup. */
equipmentRouter.post('/:id/service', requireAuth, requireAnyPage(['PMS','equipment','edit'],['ADMIN','equipment_master','edit']), wrap((req, res) => {
  const item = getEquipment(req.params.id);
  if (!item) throw notFound('That machine does not exist.');
  assertRigAllowed(req, item.rigId);

  const body = req.body ?? {};
  const date = String(body.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('Select a valid service date.');
  const serviceHours = Number(body.serviceHours);
  if (!Number.isFinite(serviceHours) || serviceHours < 0) throw badRequest('Enter a valid service hour reading.');

  const id = recordService({
    equipmentId: item.id, rigId: item.rigId, date, serviceHours,
    remarks: body.remarks ? String(body.remarks) : null, method: 'Manual', user: req.user!.username,
  });
  audit({
    user: req.user!.username, ip: req.clientIp, action: 'equipment.service.manual',
    entity: 'equipment_service_records', entityId: id, detail: `${item.name} (${item.rigNumber}) serviced at ${serviceHours}h`,
  });
  res.status(201).json({ equipment: getEquipment(item.id) });
}));

equipmentRouter.post('/', requireAuth, requireAnyPage(['PMS','equipment','create'],['ADMIN','equipment_master','create']), wrap((req, res) => {
  const body = req.body ?? {};
  const rigId = String(body.rigId ?? '');
  if (!rigId) throw badRequest('Every machine must belong to a rig.');
  assertRigAllowed(req, rigId);
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE id = ?').get(rigId);
  if (!rig) throw badRequest('That rig does not exist.');

  const record = createEquipment(rigId, body, req.user!.username, req.clientIp ?? null);
  res.status(201).json({ equipment: getEquipment(record.id) });
}));

/**
 * When the equipment is linked to a Global Material Master record, its
 * Name/Make/Model/Serial/Category are derived from that record server-side —
 * never trusted from client-sent text — so the values can never diverge from
 * what an Admin picked in the Linked Material dropdown. Returns null when
 * neither link is present (the "Custom / Other equipment" path, and the Excel
 * bulk-import path, are both untouched).
 */
function resolveLinkedMaterial(body: Record<string, unknown>): {
  name: string; manufacturer: string | null; model: string | null; serialNumber: string | null; category: string;
} | null {
  const linkedEngineId = (body.linkedEngineId as string) || null;
  const linkedTransmissionId = (body.linkedTransmissionId as string) || null;
  if (!linkedEngineId && !linkedTransmissionId) return null;

  if (linkedEngineId) {
    const material = materialMasterModel.get(linkedEngineId);
    if (!material || material.materialType !== 'Engine') throw badRequest('That linked Engine record does not exist.');
    return { name: material.name, manufacturer: material.make, model: material.model, serialNumber: material.serialNumber, category: matchCategory(material.name) };
  }
  const material = materialMasterModel.get(linkedTransmissionId!);
  if (!material || material.materialType !== 'Transmission') throw badRequest('That linked Transmission record does not exist.');
  return { name: material.name, manufacturer: material.make, model: material.model, serialNumber: material.serialNumber, category: 'Transmission' };
}

/** Shared by the single-record POST and bulk import — rigId must already be validated by the caller. */
export function createEquipment(rigId: string, body: Record<string, unknown>, user: string, ip: string | null) {
  const linked = resolveLinkedMaterial(body);
  const name = linked ? linked.name : String(body.name ?? '').trim();
  if (!name) throw badRequest('A machine name is required.');

  const record = {
    id: newId('eq'),
    rigId,
    name,
    nameKey: nameKey(name),
    category: linked ? linked.category
      : CATEGORIES.includes(body.category as string) ? (body.category as string)
      : matchCategory(name), // manual Add never sends a category — guess it from the name, same heuristic bulk import already uses, rather than always defaulting to 'Others'
    manufacturer: linked ? linked.manufacturer : ((body.manufacturer as string) ?? null),
    model: linked ? linked.model : ((body.model as string) ?? null),
    serialNumber: linked ? linked.serialNumber : ((body.serialNumber as string) ?? null),
    serialKey: (linked ? linked.serialNumber : (body.serialNumber as string)) ? serialKey((linked ? linked.serialNumber : body.serialNumber) as string) || null : null,
    assetNumber: (body.assetNumber as string) ?? null,
    engineNumber: (body.engineNumber as string) ?? null,
    installationDate: (body.installationDate as string) ?? null,
    currentRunningHours: Math.round(Number(body.currentRunningHours ?? 0)) || 0,
    lastServiceHours: Math.round(Number(body.lastServiceHours ?? 0)) || 0,
    serviceInterval: Math.round(Number(body.serviceInterval ?? 500)) || 500,
    lastHealthCheckDate: (body.lastHealthCheckDate as string) ?? null,
    healthCheckInterval: Math.round(Number(body.healthCheckInterval ?? 90)) || 90,
    isBreakdown: body.isBreakdown ? 1 : 0,
    isActive: body.isActive === false ? 0 : 1,
    section: body.section === 'generator' ? 'generator' : 'diesel',
    ecmPresent: yesNoOrNull(body.ecmPresent),
    etToolApplicable: yesNoOrNull(body.etToolApplicable),
    linkedEngineId: (body.linkedEngineId as string) || null,
    linkedTransmissionId: (body.linkedTransmissionId as string) || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const status = equipmentStatus({ ...record, isBreakdown: !!record.isBreakdown });

  db.prepare(`
    INSERT INTO equipment (id, rigId, name, nameKey, category, manufacturer, model, serialNumber,
      serialKey, assetNumber, engineNumber, installationDate, currentRunningHours, lastServiceHours,
      serviceInterval, lastHealthCheckDate, healthCheckInterval, isBreakdown, isActive, status, section,
      ecmPresent, etToolApplicable, linkedEngineId, linkedTransmissionId, createdAt, updatedAt)
    VALUES (@id, @rigId, @name, @nameKey, @category, @manufacturer, @model, @serialNumber, @serialKey,
      @assetNumber, @engineNumber, @installationDate, @currentRunningHours, @lastServiceHours,
      @serviceInterval, @lastHealthCheckDate, @healthCheckInterval, @isBreakdown, @isActive, @status, @section,
      @ecmPresent, @etToolApplicable, @linkedEngineId, @linkedTransmissionId, @createdAt, @updatedAt)
  `).run({ ...record, status });

  audit({ user, ip, action: 'equipment.create', entity: 'equipment', entityId: record.id, newValue: record });
  return record;
}

/* ---------------------------- bulk import ---------------------------- */

equipmentRouter.get('/template/download', requireAuth, requireAnyPage(['PMS','equipment','create'],['ADMIN','equipment_master','create']), wrap(async (_req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Equipment');
  ws.columns = [
    { header: 'Equipment Name', key: 'name', width: 24 },
    { header: 'Category', key: 'category', width: 20 },
    { header: 'Make', key: 'manufacturer', width: 18 },
    { header: 'Model', key: 'model', width: 16 },
    { header: 'Sr. No', key: 'serialNumber', width: 18 },
    { header: 'Defined Hours', key: 'serviceInterval', width: 14 },
    { header: 'ECM Present', key: 'ecmPresent', width: 14 },
    { header: 'ET Tool Applicable', key: 'etToolApplicable', width: 18 },
    { header: 'Status', key: 'status', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow({
    name: 'Rig Carrier Engine', category: 'Rig Carrier Engine', manufacturer: 'CAT',
    model: 'C-15', serialNumber: 'JDK00371', serviceInterval: 500,
    ecmPresent: 'Yes', etToolApplicable: 'Yes', status: 'Active',
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Equipment_Master_Template.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}));

equipmentRouter.post('/import', requireAuth, requireAnyPage(['PMS','equipment','create'],['ADMIN','equipment_master','create']), upload.single('file'), wrap((req, res) => {
  const rigId = String(req.query.rigId ?? req.body.rigId ?? '');
  if (!rigId) throw badRequest('Select a rig before importing.');
  assertRigAllowed(req, rigId);
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE id = ?').get(rigId);
  if (!rig) throw badRequest('That rig does not exist.');
  if (!req.file) throw badRequest('Attach an Excel file to import.');

  let rows: Record<string, unknown>[];
  let headerRow: number;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    headerRow = findHeaderRow(ws);
    // Real-world headers carry stray/doubled spaces ("Make ", "ET Tool  Applicable") —
    // normalise them so pick() can match on the clean column name.
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null, range: headerRow })
      .map((row) => Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.trim().replace(/\s+/g, ' '), v]),
      ));
  } catch (err) {
    throw badRequest(`The file could not be read as an Excel workbook: ${(err as Error).message}`);
  }

  const created: unknown[] = [];
  const skipped: { row: number; reason: string }[] = [];

  transact(() => {
    rows.forEach((row, i) => {
      const name = pick(row, ['Equipment Name', 'Equipment', 'name']);
      if (!name) {
        skipped.push({ row: headerRow + i + 2, reason: 'No equipment name in the row.' });
        return;
      }
      try {
        created.push(
          createEquipment(
            rigId,
            {
              name,
              category: matchCategory(pick(row, ['Category', 'category']) ?? name),
              manufacturer: pick(row, ['Make', 'Manufacturer', 'manufacturer']),
              model: pick(row, ['Model', 'model']),
              serialNumber: pick(row, ['Sr. No', 'Sr No', 'Serial No', 'Serial Number', 'serialNumber']),
              serviceInterval: pick(row, ['Defined Hours', 'Service Interval', 'serviceInterval']),
              isActive: pick(row, ['Status', 'status'])?.toLowerCase() !== 'inactive',
              ecmPresent: pick(row, ['ECM Present', 'ECM']),
              etToolApplicable: pick(row, ['ET Tool Applicable', 'ET Tool']),
            },
            req.user!.username,
            req.clientIp ?? null,
          ),
        );
      } catch (err) {
        skipped.push({ row: headerRow + i + 2, reason: (err as Error).message });
      }
    });
  });

  res.json({ created: created.length, skipped, equipment: created });
}));

/* ---------------------------- master-data import (admin-only) ---------------------------- */

/**
 * Admin > Master > Equipment Master > Import Correct Master Data. Unlike
 * POST /import above (one rig at a time, additive only), this reads a
 * multi-rig "Rig -> Equipment -> Make/Model/Sr.No -> Oil" workbook and, per
 * matched rig, reconciles its equipment+oil roster to exactly what the
 * workbook says — updating what already matches by name, creating what's
 * new, and deactivating (never deleting) whatever this import didn't touch.
 * Gated on requireAdmin specifically (stricter than canManageEquipment)
 * since a confirmed run can deactivate equipment across every rig at once.
 */
equipmentRouter.post('/master-import/preview', requireAuth, requireAdmin, upload.single('file'), wrap((req, res) => {
  if (!req.file) throw badRequest('Attach an Excel file to import.');
  const rows = parseRigEquipmentWorkbook(req.file.buffer);
  res.json(buildImportPreview(rows));
}));

equipmentRouter.post('/master-import/confirm', requireAuth, requireAdmin, upload.single('file'), wrap((req, res) => {
  if (!req.file) throw badRequest('Attach an Excel file to import.');
  const rows = parseRigEquipmentWorkbook(req.file.buffer);
  const result = commitImport(rows, req.file.originalname, req.user!.username, req.clientIp ?? null);
  res.json(result);
}));

equipmentRouter.get('/master-import/history', requireAuth, requireAdmin, wrap((_req, res) => {
  res.json({ history: listImportHistory() });
}));

/**
 * Real-world exports (like the customer's own equipment master workbook)
 * often carry a blank row or two before the actual header — find the row
 * that actually names the columns instead of assuming row 1 is it.
 */
function findHeaderRow(ws: XLSX.WorkSheet): number {
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
  const keywords = /equipment|make|manufacturer|model|serial|sr\.?\s*no/i;
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    const row = raw[i];
    if (row.some((cell) => typeof cell === 'string' && keywords.test(cell))) return i;
  }
  return 0;
}

/** "Yes"/"No"/true/false/1/0 -> 1/0; anything absent or unrecognised stays null (unknown, never fabricated). */
function yesNoOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(s)) return 1;
  if (['no', 'n', 'false', '0'].includes(s)) return 0;
  return null;
}

function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/** Rows commonly name a specific machine ("DG-1 (125 KVA)") rather than its CATEGORIES bucket; match by keyword, default to Others. */
export function matchCategory(value: string): string {
  const needle = value.toLowerCase();
  return CATEGORIES.find((c) => c !== 'Others' && needle.includes(c.toLowerCase())) ?? 'Others';
}

const EDITABLE = [
  'name', 'category', 'manufacturer', 'model', 'serialNumber', 'assetNumber', 'engineNumber',
  'installationDate', 'currentRunningHours', 'lastServiceHours', 'serviceInterval',
  'lastHealthCheckDate', 'healthCheckInterval', 'isBreakdown', 'isActive', 'section',
  'ecmPresent', 'etToolApplicable', 'linkedEngineId', 'linkedTransmissionId',
] as const;

equipmentRouter.put('/:id', requireAuth, requireAnyPage(['PMS','equipment','edit'],['ADMIN','equipment_master','edit']), wrap((req, res) => {
  const existing = db.prepare<[string], Record<string, unknown>>('SELECT * FROM equipment WHERE id = ?')
    .get(req.params.id);
  if (!existing) throw notFound('That machine does not exist.');
  assertRigAllowed(req, existing.rigId as string);

  const body = req.body ?? {};
  const next: Record<string, unknown> = { ...existing };
  for (const field of EDITABLE) {
    if (!(field in body)) continue;
    let value = body[field];
    if (['currentRunningHours', 'lastServiceHours', 'serviceInterval', 'healthCheckInterval'].includes(field)) {
      value = Math.round(Number(value) || 0);
    }
    if (field === 'isBreakdown' || field === 'isActive') value = value ? 1 : 0;
    if (field === 'ecmPresent' || field === 'etToolApplicable') value = yesNoOrNull(value);
    if (field === 'linkedEngineId' || field === 'linkedTransmissionId') value = value || null;
    if (field === 'category' && !CATEGORIES.includes(value)) continue;
    next[field] = value;
  }

  const linked = resolveLinkedMaterial({ linkedEngineId: next.linkedEngineId, linkedTransmissionId: next.linkedTransmissionId });
  if (linked) {
    next.name = linked.name;
    next.manufacturer = linked.manufacturer;
    next.model = linked.model;
    next.serialNumber = linked.serialNumber;
    next.category = linked.category;
  }

  next.nameKey = nameKey(next.name);
  next.serialKey = next.serialNumber ? serialKey(next.serialNumber) || null : null;
  next.status = equipmentStatus({
    currentRunningHours: Number(next.currentRunningHours),
    lastServiceHours: Number(next.lastServiceHours),
    serviceInterval: Number(next.serviceInterval),
    isBreakdown: !!next.isBreakdown,
  });
  next.updatedAt = nowIso();

  db.prepare(`
    UPDATE equipment SET name=@name, nameKey=@nameKey, category=@category, manufacturer=@manufacturer,
      model=@model, serialNumber=@serialNumber, serialKey=@serialKey, assetNumber=@assetNumber,
      engineNumber=@engineNumber, installationDate=@installationDate,
      currentRunningHours=@currentRunningHours, lastServiceHours=@lastServiceHours,
      serviceInterval=@serviceInterval, lastHealthCheckDate=@lastHealthCheckDate,
      healthCheckInterval=@healthCheckInterval, isBreakdown=@isBreakdown, isActive=@isActive, status=@status,
      section=@section, ecmPresent=@ecmPresent, etToolApplicable=@etToolApplicable,
      linkedEngineId=@linkedEngineId, linkedTransmissionId=@linkedTransmissionId,
      updatedAt=@updatedAt
    WHERE id=@id
  `).run(next);

  auditDiff(
    { user: req.user!.username, ip: req.clientIp, action: 'equipment.update', entity: 'equipment', entityId: existing.id as string },
    existing,
    Object.fromEntries(EDITABLE.map((f) => [f, next[f]])),
  );
  res.json({ equipment: getEquipment(req.params.id) });
}));

equipmentRouter.delete('/:id', requireAuth, requireAnyPage(['PMS','equipment','delete'],['ADMIN','equipment_master','delete']), wrap((req, res) => {
  const existing = db.prepare<[string], Record<string, unknown>>('SELECT * FROM equipment WHERE id = ?')
    .get(req.params.id);
  if (!existing) throw notFound('That machine does not exist.');
  assertRigAllowed(req, existing.rigId as string);

  transact(() => {
    // Deleted by primary key only (spec 11.1).
    db.prepare('DELETE FROM equipment WHERE id = ?').run(req.params.id);
    audit({
      user: req.user!.username, ip: req.clientIp, action: 'equipment.delete',
      entity: 'equipment', entityId: req.params.id, oldValue: existing,
    });
  });
  res.json({ ok: true });
}));
