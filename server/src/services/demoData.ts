import bcrypt from 'bcryptjs';
import { db, transact } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { badRequest, HttpError } from '../middleware/http.js';
import { audit } from './audit.js';
import { serialiseRights } from './rights.js';
import { serialiseModuleAccess } from './moduleAccess.js';
import { createRig } from '../routes/rigs.js';
import { createModuleRig } from '../routes/moduleRigMaster.js';
import { createEquipment } from '../routes/equipment.js';
import { createOilLubricant } from '../routes/oilLubricants.js';
import { createDepartment } from '../routes/departments.js';
import { saveReport } from '../routes/dailyRigReport.js';
import {
  addCraneRecord, addCraneRound, addTrailerLoad, addTrailerMovement,
  createIlm, endIlm, setDelayLines,
} from './ilmLifecycle.js';

/**
 * Admin > Master > Demo Data: builds a complete, internally-linked set of
 * sample records — 2 rigs, 2 rig-scoped users, equipment, a real lubricant
 * used alongside a demo one, ~18 Daily Rig Reports per rig (each of which
 * distributes into DPR/HSD/Mechanical-Log/Oil the same way a real DRR save
 * does), and several ILM movements with cost fields — so the whole app can
 * be exercised end to end without touching real data.
 *
 * Every entry point used here is the exact function the real UI calls
 * (createRig, createModuleRig, createEquipment, createOilLubricant,
 * createDepartment, saveReport, and the ILM lifecycle functions in
 * services/ilmLifecycle.ts) — demo rows are indistinguishable from
 * manually-entered ones once created, and go through the same
 * validation/calculation as everything else. Each demo ILM is created,
 * given one Trailer Movement + one Crane Round, then ended (Completed) —
 * three separate short-lived ILMs per rig, not one long-running one, since
 * that's what these dates (spread ~55 days apart) represent.
 *
 * Cleanup never needs an isDemo column on a dozen tables: only the
 * top-level, non-rig-derivable rows (rigs in all three masters, users,
 * departments, oil_lubricants) are logged in demo_data_log. Everything else
 * (equipment, dpr/hsd/drr reports, ilm_transactions and their line items) is
 * found at clear-time by rigId, since it all lives under the two demo rigs.
 */

const DEMO_PREFIX = 'DEMO';
const SYSTEM_USER = 'demo-data-tool';

function logEntity(table: string, id: string): void {
  db.prepare(
    'INSERT INTO demo_data_log (id, entityTable, entityId, createdAt) VALUES (?, ?, ?, ?)',
  ).run(newId('demolog'), table, id, nowIso());
}

function loggedIds(table: string): string[] {
  return (db.prepare('SELECT entityId FROM demo_data_log WHERE entityTable = ?').all(table) as { entityId: string }[])
    .map((r) => r.entityId);
}

export function getDemoDataStatus(): { loaded: boolean; rigCount: number; loadedAt: string | null } {
  const rigs = loggedIds('rigs');
  const first = db.prepare(
    "SELECT MIN(createdAt) AS t FROM demo_data_log",
  ).get() as { t: string | null };
  return { loaded: rigs.length > 0, rigCount: rigs.length, loadedAt: first.t };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Every 2-3 days over the last ~55 days — realistic partial coverage, enough spread for daily/weekly/monthly comparisons. */
function demoReportDates(): string[] {
  const dates: string[] = [];
  const today = new Date();
  for (let daysAgo = 55; daysAgo >= 1; daysAgo -= 3) {
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    dates.push(isoDate(d));
  }
  return dates;
}

interface DemoRigProfile {
  rigNumber: string;
  name: string;
  rigType: 'Drilling' | 'Work-Over';
  location: string;
  wellPrefix: string;
  operatorName: string;
  username: string;
  userName: string;
}

const RIG_PROFILES: DemoRigProfile[] = [
  {
    rigNumber: `${DEMO_PREFIX} RIG-01`, name: 'Demo Rig One', rigType: 'Drilling',
    location: 'Demo Field North', wellPrefix: 'DEMO-A', operatorName: 'Demo Drilling Co.',
    username: 'demo.rig01', userName: 'Demo User A (Rig-01)',
  },
  {
    rigNumber: `${DEMO_PREFIX} RIG-02`, name: 'Demo Rig Two', rigType: 'Work-Over',
    location: 'Demo Field South', wellPrefix: 'DEMO-B', operatorName: 'Demo Workover Co.',
    username: 'demo.rig02', userName: 'Demo User B (Rig-02)',
  },
];

const OPERATION_CYCLE = ['02 - Drilling', '12 - Casing R/in', '06 - Tripping', '11 - Logging', '18 - Cementing'];
const WORK_TYPE_CYCLE = ['R1', 'R2', 'R3', 'ILM'];

export function loadDemoData(ctx: { user: string; ip: string | null }): { rigsCreated: number; usersCreated: number; reportsCreated: number; ilmMovementsCreated: number } {
  if (getDemoDataStatus().loaded) {
    throw badRequest('Demo data is already loaded. Clear it first, then load again if you want a fresh set.');
  }

  // Not wrapped in one outer transaction: saveReport()/saveIlmTransaction() each
  // already manage their own transaction internally, and better-sqlite3 in this
  // codebase deliberately avoids nested transactions (see their `skipTransaction`
  // options, used only when a caller's own transact() truly wraps them).
  {
    const user = ctx.user || SYSTEM_USER;
    const ip = ctx.ip;

    // Department all demo users belong to (Module -> Department -> User, same as real users).
    const dept = createDepartment({ name: `${DEMO_PREFIX} Operations`, moduleCode: 'PMS', status: 'Active' }, user, ip);
    logEntity('departments', dept.id);

    // One genuinely new lubricant, alongside real Active types already in the master —
    // proves the master itself supports demo additions without needing a second list.
    let demoOilId: string | null = null;
    try {
      const oil = createOilLubricant({ name: `${DEMO_PREFIX} - Marine Grade Grease`, status: 'Active' }, user, ip);
      demoOilId = oil.id;
      logEntity('oil_lubricants', oil.id);
    } catch {
      // Already exists from a previous load that wasn't fully cleared — fine, just skip.
    }
    const realLubricants = (db.prepare(
      "SELECT name FROM oil_lubricants WHERE status = 'Active' ORDER BY name LIMIT 3",
    ).all() as { name: string }[]).map((r) => r.name);
    const lubricantNames = [...new Set([...realLubricants, demoOilId ? `${DEMO_PREFIX} - Marine Grade Grease` : null].filter(Boolean) as string[])].slice(0, 3);

    let reportsCreated = 0;
    let ilmMovementsCreated = 0;
    const dates = demoReportDates();

    for (const [rigIndex, profile] of RIG_PROFILES.entries()) {
      // 1. Rig, in all three independent rig masters, same rig number so rigKey bridges them.
      const pmsRig = createRig({
        rigNumber: profile.rigNumber, name: profile.name, location: profile.location,
        rigType: profile.rigType, status: 'Active',
      }, user, ip);
      logEntity('rigs', pmsRig.id);

      const dprRig = createModuleRig(
        { table: 'dpr_rigs', idPrefix: 'dprrig', auditEntity: 'dpr_rigs', dependents: [], getScope: () => ({ restricted: false, rigIds: [] }) },
        { rigNumber: profile.rigNumber, name: profile.name, status: 'Active' }, user, ip,
      );
      logEntity('dpr_rigs', dprRig.id);

      const ilmRig = createModuleRig(
        { table: 'ilm_rigs', idPrefix: 'ilmrig', auditEntity: 'ilm_rigs', dependents: [], getScope: () => ({ restricted: false, rigIds: [] }) },
        { rigNumber: profile.rigNumber, name: profile.name, status: 'Active' }, user, ip,
      );
      logEntity('ilm_rigs', ilmRig.id);

      // 2. User assigned to this rig only — exactly the rig-scoping mechanism real users go through.
      const demoUserId = newId('usr');
      db.prepare(`
        INSERT INTO users (id, username, passwordHash, role, name, email, rigId, departmentId, status, rights, moduleAccess, createdAt)
        VALUES (@id, @username, @passwordHash, @role, @name, @email, @rigId, @departmentId, 'Active', @rights, @moduleAccess, @createdAt)
      `).run({
        id: demoUserId, username: profile.username, passwordHash: bcrypt.hashSync('Demo@12345', 10),
        role: 'PMS User', name: profile.userName, email: null, rigId: pmsRig.id, departmentId: dept.id,
        rights: serialiseRights({}, 'PMS User'),
        moduleAccess: serialiseModuleAccess({
          PMS: { access: true, view: true, create: true, edit: true, delete: false },
          DPR: { access: true, view: true, create: true, edit: true, delete: false },
          ILM: { access: true, view: true, create: true, edit: true, delete: false },
          DRR: { access: true, view: true, create: true, edit: true, delete: false },
        }, 'PMS User'),
        createdAt: nowIso(),
      });
      logEntity('users', demoUserId);
      audit({ user, ip, action: 'user.create', entity: 'users', entityId: demoUserId, newValue: { username: profile.username, role: 'PMS User', rigId: pmsRig.id } });

      // 3. Equipment for this rig — Equipment Master's real create path.
      const equipmentDefs = [
        { name: 'Rig Carrier Engine', category: 'Rig Carrier Engine', manufacturer: 'CAT', model: 'C-15', serialNumber: `${DEMO_PREFIX}-${rigIndex + 1}-001`, ecmPresent: 'Yes', etToolApplicable: 'Yes' },
        { name: 'Mud Pump Engine', category: 'Mud Pump Engine', manufacturer: 'CUMMINS', model: 'KTA38-C1300', serialNumber: `${DEMO_PREFIX}-${rigIndex + 1}-002`, ecmPresent: 'No', etToolApplicable: 'No' },
        { name: 'DG-1 (125 KVA)', category: 'DG Set', manufacturer: 'SUPERNOVA', model: 'EE694TCI', serialNumber: `${DEMO_PREFIX}-${rigIndex + 1}-003`, ecmPresent: 'No', etToolApplicable: 'No' },
      ];
      const equipmentIds: string[] = [];
      for (const def of equipmentDefs) {
        const eq = createEquipment(pmsRig.id, { ...def, serviceInterval: 500, isActive: true }, user, ip);
        equipmentIds.push(eq.id);
        logEntity('equipment', eq.id); // scoped-by-rig at clear time too, but logged for clarity/robustness
      }

      // 4. ~18 submitted Daily Rig Reports — each one, via saveReport(), writes into
      //    DPR (dpr_reports/dpr_line_items), HSD (hsd_reports/*), Mechanical Log
      //    (mechanical_log_uploads/rows) and DRR's own oil/hydraulic lines together,
      //    exactly the way a real operator's single daily entry does.
      const openingHours = new Map(equipmentIds.map((id) => [id, 4000 + rigIndex * 500]));
      const oilBalance = new Map(lubricantNames.map((n) => [n, 200]));
      const hydraulicBalance = new Map([['Rig Carrier Hydraulic Tank', 400], ['Accumulator Tank', 150]]);
      let dieselStock = 2000;
      let drillDepth = 500 + rigIndex * 200;
      let casingDepth = 300 + rigIndex * 150;

      dates.forEach((date, dayIndex) => {
        const isBreakdownDay = dayIndex > 0 && dayIndex % 9 === 0;
        const shift = dayIndex % 2 === 0 ? 'Day' : 'Night';
        const hsdReceived = dayIndex % 4 === 0 ? 500 : 0;
        dieselStock += hsdReceived;

        const equipmentLines = equipmentIds.map((id, i) => {
          const dayHours = isBreakdownDay && i === 0 ? 2 : 8 + (i % 3);
          const nightHours = isBreakdownDay && i === 0 ? 0 : 4 + (i % 2);
          const consumption = round2(18 + i * 4 + (dayIndex % 5));
          dieselStock = round2(dieselStock - consumption);
          const opening = openingHours.get(id)!;
          const closing = round2(opening + dayHours + nightHours);
          openingHours.set(id, closing);
          const status = isBreakdownDay && i === 0 ? 'Breakdown' : 'Running';
          return {
            equipmentId: id, openingRunningHours: opening, dayHours, nightHours,
            hsdConsumption: consumption, status, remarks: status === 'Breakdown' ? 'Demo breakdown for testing' : null,
            breakdownAt: status === 'Breakdown' ? `${date}T06:00` : null,
            breakdownDescription: status === 'Breakdown' ? 'Radiator overheating — demo scenario' : null,
            actionTaken: status === 'Breakdown' ? 'Coolant topped up, monitoring' : null,
            partsRequired: null, expectedRestoration: status === 'Breakdown' ? date : null,
            breakdownRemark: null,
          };
        });

        const oilLines = lubricantNames.map((name) => {
          const opening = oilBalance.get(name)!;
          const added = dayIndex % 6 === 0 ? 40 : 0;
          const consumed = round2(3 + (dayIndex % 3));
          oilBalance.set(name, round2(opening + added - consumed));
          return { equipmentId: null, oilType: name, openingBalance: opening, oilAdded: added, oilConsumed: consumed, remark: null };
        });

        const hydraulicLines = [...hydraulicBalance.entries()].map(([tankName, opening]) => {
          const topUp = dayIndex % 7 === 0 ? 15 : 0;
          const loss = round2(1 + (dayIndex % 2));
          hydraulicBalance.set(tankName, round2(opening + topUp - loss));
          return { tankName, openingLevel: opening, topUp, loss, remark: null };
        });

        const op1 = OPERATION_CYCLE[dayIndex % OPERATION_CYCLE.length];
        const isDrilling = op1 === '02 - Drilling';
        const isCasing = op1 === '12 - Casing R/in';
        let drillingFrom: number | null = null, drillingTo: number | null = null;
        let casingFrom: number | null = null, casingTo: number | null = null;
        if (isDrilling) { drillingFrom = drillDepth; drillDepth = round2(drillDepth + 20 + (dayIndex % 10)); drillingTo = drillDepth; }
        if (isCasing) { casingFrom = casingDepth; casingDepth = round2(casingDepth + 15 + (dayIndex % 8)); casingTo = casingDepth; }

        const dprLines = [{
          wellName: `${profile.wellPrefix}-${1 + Math.floor(dayIndex / 6)}`,
          operationCode: isBreakdownDay ? '08 - Breakdown' : op1,
          workType: WORK_TYPE_CYCLE[dayIndex % WORK_TYPE_CYCLE.length],
          startTime: '06:00', endTime: '14:00',
          description: isBreakdownDay ? 'Equipment breakdown handled, operations resumed' : `${op1.split(' - ')[1]} progressing as planned`,
          breakdownEquipment: isBreakdownDay ? 'Rig Carrier Engine' : null,
          breakdownReason: isBreakdownDay ? 'Radiator overheating' : null,
          drillingSection: isDrilling ? '12 1/4"' : null, drillingFrom, drillingTo,
          casingSection: isCasing ? '9 5/8"' : null, casingFrom, casingTo,
        }];

        const detail = saveReport(null, {
          rigId: pmsRig.id, reportDate: date, wellNo: `${profile.wellPrefix}-${1 + Math.floor(dayIndex / 6)}`,
          shift, fieldLocation: profile.location,
          hsdReceived, hsdRemarks: hsdReceived > 0 ? 'Demo top-up' : null,
          equipmentLines, oilLines, hydraulicLines, dprLines, status: 'Submitted',
        }, user, ip);
        logEntity('drr_reports', detail!.id);
        reportsCreated += 1;
      });

      // 5. A handful of ILM movements, with cost fields for the ILM Summary Dashboard.
      const ilmDates = dates.filter((_, i) => i % 8 === 0);
      ilmDates.forEach((date, i) => {
        const spudDate = new Date(date); spudDate.setDate(spudDate.getDate() + 2);
        const hsdAccession = 5000, received = 2000, shiftEnd = 3000;
        const distanceKm = 120 + i * 15;
        const ilmCtx = { user, ip };

        const transactionId = createIlm({
          rigId: ilmRig.id, date, source: 'manual', importBatchId: null,
          individual: {
            area: `Area-${rigIndex + 1}`, operatorName: profile.operatorName, wellNo: `${profile.wellPrefix}-${i + 1}`,
            movementFromWell: `${profile.wellPrefix}-${i}`, movementToWell: `${profile.wellPrefix}-${i + 1}`,
            releaseDate: date, releaseTime: '08:00', spudDate: isoDate(spudDate), spudTime: '10:00',
            ilmRatePerDay: 25000 + rigIndex * 2000, ilmExpenses: 40000 + i * 3000,
          },
          ctx: ilmCtx,
        });

        setDelayLines(transactionId, [{
          reasonForDelay: i % 2 === 0 ? 'Weather Conditions' : 'Site Not Ready',
          totalDelayHours: 2 + (i % 3), hsdStockAccession: hsdAccession, receivedQtyDuringIlm: received,
          hsdStockShiftEnd: shiftEnd, ilmDistanceKm: distanceKm,
          totalLoadsMoved: 8 + i, cumulativeTrailerKm: 1200 + i * 100,
        }], ilmCtx);

        const { id: movementId } = addTrailerMovement(transactionId, {
          fleetReportAt: `${date} 09:00`, leadDistanceKm: distanceKm, allowedDurationHrs: 48,
        }, ilmCtx);
        addTrailerLoad(movementId, {
          mtGatePassNo: `GP-${1000 + i}`, trailerNo: `TRL-${rigIndex + 1}0${i + 1}`, equipmentId: null, trailerType: 'HB', capacityTon: 70,
          arrivalDate: date, arrivalTime: '06:00', loadingDate: date, loadingTime: '08:00',
          loadDescription: 'Rig equipment load', totalPackages: 6 + i, unloadingDate: isoDate(spudDate), unloadingTime: '10:00',
          driverName: `Demo Driver ${i + 1}`, driverContact: '9000000001',
        }, ilmCtx);
        addTrailerLoad(movementId, {
          mtGatePassNo: `GP-${1000 + i}`, trailerNo: `TRL-${rigIndex + 1}1${i + 1}`, equipmentId: null, trailerType: 'LB', capacityTon: 60,
          arrivalDate: date, arrivalTime: '07:00', loadingDate: date, loadingTime: '09:00',
          loadDescription: 'Mud pump components', totalPackages: 4 + i, unloadingDate: isoDate(spudDate), unloadingTime: '11:00',
          driverName: `Demo Driver ${i + 2}`, driverContact: '9000000002',
        }, ilmCtx);

        const roundId = addCraneRound(transactionId, { oldLocation: null, newLocation: null }, ilmCtx);
        addCraneRecord(roundId, {
          craneNo: `CRN-${rigIndex + 1}0${i + 1}`, equipmentId: null, capacityTon: 100, reportingDate: date, rigOrHired: 'Rig-owned',
          registrationNo: `REG-${rigIndex + 1}0${i + 1}`, arrivedDate: date, arrivedTime: '06:00',
          releaseDate: isoDate(spudDate), releaseTime: '18:00', transporterName: 'Demo Heavy Lift Transport',
          dayNo: 1, shiftDate: date, dayShiftHrs: 6.5, detailsJobDay: 'Rig-up assembly', nightShiftHrs: 5,
          detailsJobNight: 'Standby', breakdownHrs: 0, cumulativeHrs: 11.5, issuedHsdLtrs: 50, totalWorkingHrs: 11.5,
        }, ilmCtx);

        endIlm(transactionId, ilmCtx);

        logEntity('ilm_transactions', transactionId); // scoped-by-rig at clear time too, logged for clarity
        ilmMovementsCreated += 1;
      });
    }

    audit({ user, ip, action: 'demoData.load', entity: 'demo_data_log', entityId: 'all', detail: `${reportsCreated} DRR reports, ${ilmMovementsCreated} ILM movements across ${RIG_PROFILES.length} demo rigs` });

    return { rigsCreated: RIG_PROFILES.length, usersCreated: RIG_PROFILES.length, reportsCreated, ilmMovementsCreated };
  }
}

export function clearDemoData(ctx: { user: string; ip: string | null }): { removed: Record<string, number> } {
  const pmsRigIds = loggedIds('rigs');
  const dprRigIds = loggedIds('dpr_rigs');
  const ilmRigIds = loggedIds('ilm_rigs');
  const userIds = loggedIds('users');
  const deptIds = loggedIds('departments');
  const oilIds = loggedIds('oil_lubricants');

  if (pmsRigIds.length === 0 && dprRigIds.length === 0 && ilmRigIds.length === 0 && userIds.length === 0) {
    throw new HttpError(400, 'No demo data is currently loaded.');
  }

  return transact(() => {
    const removed: Record<string, number> = {};
    const runFor = (table: string, column: string, ids: string[]): void => {
      let n = 0;
      for (const id of ids) n += db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id).changes;
      removed[table] = (removed[table] ?? 0) + n;
    };

    // Children first (their own FKs cascade further down), in FK-safe order.
    runFor('drr_reports', 'rigId', pmsRigIds);
    runFor('mechanical_log_uploads', 'rigId', pmsRigIds); // cascades mechanical_log_rows
    runFor('equipment', 'rigId', pmsRigIds); // cascades equipment_history/document_files/health_check_records
    runFor('dpr_reports', 'rigId', dprRigIds); // cascades dpr_line_items
    runFor('hsd_reports', 'rigId', dprRigIds); // cascades hsd_equipment_lines/hsd_site_lines
    runFor('ilm_transactions', 'rigId', ilmRigIds); // cascades individual/lines/trailer/crane

    runFor('users', 'id', userIds);
    runFor('dpr_rigs', 'id', dprRigIds);
    runFor('ilm_rigs', 'id', ilmRigIds);
    runFor('rigs', 'id', pmsRigIds);
    runFor('departments', 'id', deptIds);
    runFor('oil_lubricants', 'id', oilIds);

    db.exec('DELETE FROM demo_data_log');

    audit({ user: ctx.user, ip: ctx.ip, action: 'demoData.clear', entity: 'demo_data_log', entityId: 'all', detail: JSON.stringify(removed) });

    return { removed };
  });
}
