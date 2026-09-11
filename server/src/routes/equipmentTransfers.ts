import { Router } from 'express';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { isIsoDate, nowIso, today } from '../util/date.js';
import { cleanText } from '../util/num.js';
import { assertRigAllowed, requireAnyPage, requireAuth, rigScope } from '../middleware/auth.js';
import { badRequest, notFound, wrap } from '../middleware/http.js';
import { audit } from '../services/audit.js';

export const equipmentTransfersRouter = Router();

const TRANSFER_TYPES = ['Permanent', 'Temporary'];

export interface TransferInput {
  equipmentId: string;
  /** 'yard' and 'other' both move the machine to a free-location string (toPlace) — the
   *  only difference is which control the admin used (a pick-list vs. free text) so the
   *  Transfer List can show what was intended; both are stored identically otherwise. */
  destinationType: 'rig' | 'yard' | 'other';
  toRigId?: string;
  toPlace?: string;
  transferType?: string;
  date?: string;
  expectedReturnDate?: string;
  remarks?: string;
}

const DESTINATION_LABEL: Record<TransferInput['destinationType'], string> = { rig: 'Rig', yard: 'Yard', other: 'Other' };

/**
 * A transfer moves one machine either to another rig (equipment.rigId itself
 * changes, so it becomes that rig's asset for every future report and
 * ingestion match) or to a yard/other location (equipment.currentPlace is set;
 * rigId is left as its home rig, since it is expected back). Every transfer is
 * kept as a permanent history row — moving equipment "back" is simply another
 * transfer, not a special reversal action.
 *
 * This is the single centralized transfer path for the whole app — Admin >
 * Master > Transfer Equipment, Equipment Master, and Equipment Detail's
 * transfer history all read/write through this one function and table.
 *
 * Extracted from the route handler (matching how routes/rigs.ts exports
 * createRig) so the core rule can be unit-tested without an HTTP layer.
 */
export function createTransfer(input: TransferInput, ctx: { user: string; ip: string | null }) {
  const equipment = db.prepare<[string], {
    id: string; rigId: string; currentPlace: string | null; name: string;
  }>('SELECT id, rigId, currentPlace, name FROM equipment WHERE id = ?').get(input.equipmentId);
  if (!equipment) throw badRequest('Choose the machine to transfer.');

  const destinationType: TransferInput['destinationType'] = input.destinationType === 'rig' ? 'rig'
    : input.destinationType === 'yard' ? 'yard' : 'other';
  const transferType = TRANSFER_TYPES.includes(input.transferType ?? '') ? input.transferType! : 'Permanent';
  const date = isIsoDate(input.date) ? input.date! : today();
  const remarks = cleanText(input.remarks);
  const expectedReturnDate = transferType === 'Temporary' && isIsoDate(input.expectedReturnDate)
    ? input.expectedReturnDate! : null;

  let toRigId: string | null = null;
  let toRigNumber: string | null = null;
  let toPlace: string | null = null;

  if (destinationType === 'rig') {
    const rig = db.prepare<[string], { id: string; rigNumber: string }>(
      'SELECT id, rigNumber FROM rigs WHERE id = ?',
    ).get(input.toRigId ?? '');
    if (!rig) throw badRequest('Choose the rig this machine is being transferred to.');
    if (rig.id === equipment.rigId && !equipment.currentPlace) {
      throw badRequest(`${equipment.name} is already on this rig.`);
    }
    toRigId = rig.id;
    toRigNumber = rig.rigNumber;
  } else {
    toPlace = cleanText(input.toPlace);
    if (!toPlace) {
      throw badRequest(destinationType === 'yard'
        ? 'Choose the yard this machine is being transferred to.'
        : 'Enter the destination this machine is being transferred to.');
    }
    if (toPlace === equipment.currentPlace) {
      throw badRequest(`${equipment.name} is already recorded at ${toPlace}.`);
    }
  }

  const fromRigId = equipment.rigId;
  const fromPlace = equipment.currentPlace;

  return transact(() => {
    const id = newId('xfer');
    db.prepare(`
      INSERT INTO equipment_transfers
        (id, equipmentId, fromRigId, fromPlace, toRigId, toPlace, destinationType, transferType, expectedReturnDate,
         date, remarks, createdBy, createdAt)
      VALUES (@id, @equipmentId, @fromRigId, @fromPlace, @toRigId, @toPlace, @destinationType, @transferType,
              @expectedReturnDate, @date, @remarks, @createdBy, @createdAt)
    `).run({
      id, equipmentId: equipment.id, fromRigId, fromPlace, toRigId, toPlace,
      destinationType: DESTINATION_LABEL[destinationType], transferType,
      expectedReturnDate, date, remarks, createdBy: ctx.user, createdAt: nowIso(),
    });

    if (destinationType === 'rig') {
      db.prepare('UPDATE equipment SET rigId = ?, currentPlace = NULL, currentPlaceSince = NULL, updatedAt = ? WHERE id = ?')
        .run(toRigId, nowIso(), equipment.id);
    } else {
      db.prepare('UPDATE equipment SET currentPlace = ?, currentPlaceSince = ?, updatedAt = ? WHERE id = ?')
        .run(toPlace, date, nowIso(), equipment.id);
    }

    audit({
      user: ctx.user, ip: ctx.ip, action: 'equipment.transfer',
      entity: 'equipment', entityId: equipment.id,
      detail: `${transferType} transfer of ${equipment.name} to ${toRigNumber ?? toPlace}` +
        (expectedReturnDate ? `, expected back ${expectedReturnDate}` : ''),
    });

    return db.prepare('SELECT * FROM equipment_transfers WHERE id = ?').get(id);
  });
}

/**
 * Admin > Master > Transfer Equipment's "Yard" picker: every distinct
 * location ever recorded, derived live from real data (equipment currently
 * parked there, or named in a past transfer) — never a hardcoded list. A
 * genuinely new location is entered once via "Other" and appears here for
 * every transfer after that.
 */
equipmentTransfersRouter.get('/places', requireAuth, wrap((_req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT place FROM (
      SELECT currentPlace AS place FROM equipment WHERE currentPlace IS NOT NULL AND currentPlace != ''
      UNION
      SELECT toPlace AS place FROM equipment_transfers WHERE toPlace IS NOT NULL AND toPlace != ''
    )
    ORDER BY place COLLATE NOCASE
  `).all() as { place: string }[];
  res.json({ places: rows.map((r) => r.place) });
}));

/**
 * Admin > Master > Transfer Equipment's List — every transfer fleet-wide (not
 * one machine's history, see GET / below), scoped to the rigs this account can
 * see on either side of the move. "Current" marks each machine's most recent
 * transfer (its present location); every earlier one for that machine reads
 * "Historical" — both derived from the same rows, nothing fabricated.
 */
equipmentTransfersRouter.get('/list', requireAuth, requireAnyPage(['PMS','equipment','view'],['ADMIN','transfer_equipment','view']), wrap((req, res) => {
  const rows = db.prepare(`
    SELECT t.*, e.name AS equipmentName, e.rigId AS equipmentCurrentRigId,
           fr.rigNumber AS fromRigNumber, fr.name AS fromRigName,
           tr.rigNumber AS toRigNumber, tr.name AS toRigName
    FROM equipment_transfers t
    JOIN equipment e ON e.id = t.equipmentId
    LEFT JOIN rigs fr ON fr.id = t.fromRigId
    LEFT JOIN rigs tr ON tr.id = t.toRigId
    ORDER BY t.date DESC, t.createdAt DESC
  `).all() as { id: string; equipmentId: string; fromRigId: string | null; toRigId: string | null }[];

  const scope = rigScope(req);
  const inScope = (rigId: string | null) => !rigId || scope === null || scope.includes(rigId);
  const visible = rows.filter((r) => inScope(r.fromRigId) || inScope(r.toRigId));

  const latestIdByEquipment = new Map<string, string>();
  for (const r of rows) {
    if (!latestIdByEquipment.has(r.equipmentId)) latestIdByEquipment.set(r.equipmentId, r.id);
  }
  const transfers = visible.map((r) => ({
    ...r,
    status: latestIdByEquipment.get(r.equipmentId) === r.id ? 'Current' : 'Historical',
  }));
  res.json({ transfers });
}));

equipmentTransfersRouter.post('/', requireAuth, requireAnyPage(['PMS','equipment','create'],['ADMIN','transfer_equipment','create']), wrap((req, res) => {
  const body = req.body ?? {};
  const equipment = db.prepare<[string], { rigId: string }>('SELECT rigId FROM equipment WHERE id = ?')
    .get(String(body.equipmentId ?? ''));
  if (!equipment) throw badRequest('Choose the machine to transfer.');
  assertRigAllowed(req, equipment.rigId);

  const transfer = createTransfer(body as TransferInput, { user: req.user!.username, ip: req.clientIp ?? null });
  res.status(201).json({ transfer });
}));

equipmentTransfersRouter.get('/', requireAuth, wrap((req, res) => {
  if (!req.query.equipmentId) throw badRequest('Specify the machine whose transfer history you want.');
  const equipment = db.prepare<[string], { rigId: string }>('SELECT rigId FROM equipment WHERE id = ?')
    .get(String(req.query.equipmentId));
  if (!equipment) throw notFound('That machine does not exist.');
  assertRigAllowed(req, equipment.rigId);

  const rows = db.prepare(`
    SELECT t.*, fr.rigNumber AS fromRigNumber, tr.rigNumber AS toRigNumber
    FROM equipment_transfers t
    LEFT JOIN rigs fr ON fr.id = t.fromRigId
    LEFT JOIN rigs tr ON tr.id = t.toRigId
    WHERE t.equipmentId = ?
    ORDER BY t.date DESC, t.createdAt DESC
  `).all(req.query.equipmentId);
  res.json({ transfers: rows });
}));
