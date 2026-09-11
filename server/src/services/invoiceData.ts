import { db } from '../db/index.js';
import { badRequest } from '../middleware/http.js';
import { daysInMonth } from '../util/date.js';
import { resolveModuleRigIds } from './rigScope.js';
import { invoiceSettingsModel, type InvoiceSettingsRecord } from './invoiceSettings.js';
import { amountInWords } from '../util/numberToWords.js';

/**
 * Builds an Invoice Preview entirely from existing portal data: Rig Master
 * (rigs/companies), DPR's already-computed workType hour buckets
 * (R0/R1/R2/R2-2/R3/ILM — see services/dprOperationalData.ts, the same
 * aggregation the DPR Dashboard already shows), and ILM's own transaction
 * records — bridged from this PMS rig id to its DPR/ILM rig counterpart the
 * same rigKey-based way the Admin Dashboard's Rig filter already does
 * (services/rigScope.ts's resolveModuleRigIds). Nothing here is a second
 * data-entry system: every number is read, never typed twice.
 *
 * Hour-category mapping (confirmed, not guessed): R0 = Operating,
 * R1 = Standby, R2 + R2/2 = Repair, R3 = Force Majeure, ILM = ILM.
 */

const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

export interface PriceLine {
  sNo: number;
  particulars: string;
  totalHrs: number;
  qty: number;
  uom: string;
  rate: number;
  grossAmount: number;
}

export interface InvoicePreview {
  rigId: string;
  rigName: string;
  rigNumber: string;
  invoiceDate: string;
  periodFrom: string;
  periodTo: string;
  periodLabel: string;

  clientName: string | null;
  clientAddressBlock: string | null;
  clientGstin: string | null;
  contractNo: string | null;
  accountingCode: string | null;
  wellLocation: string | null;
  contractorAddress: string | null;
  contractorGstin: string | null;

  priceLines: PriceLine[];
  totalAmount: number;
  sgstPercent: number;
  sgstAmount: number;
  cgstPercent: number;
  cgstAmount: number;
  netAmount: number;
  amountInWords: string;

  bankAccountName: string | null;
  bankName: string | null;
  bankAccountType: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  pan: string | null;
  authorisedEmail: string | null;
  signatoryCompanyName: string | null;

  /** True when Invoice Settings has no rate configured yet for one of the price lines — the line is still shown, at rate 0, so Admin sees exactly what needs configuring rather than a silent wrong number. */
  settingsIncomplete: boolean;
}

/** "2026-07" -> { periodFrom: '2026-07-01', periodTo: '2026-07-31', periodLabel: "JULY'2026 (01.07.2026 to 31.07.2026)" } */
export function resolveInvoicePeriod(month: string): { periodFrom: string; periodTo: string; periodLabel: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Invoice Month must be in YYYY-MM format.');
  const [y, m] = month.split('-').map(Number);
  const lastDay = daysInMonth(month);
  const periodFrom = `${month}-01`;
  const periodTo = `${month}-${String(lastDay).padStart(2, '0')}`;
  const ddmmyyyy = (d: number) => `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
  const periodLabel = `${MONTH_NAMES[m - 1]}'${y} (${ddmmyyyy(1)} to ${ddmmyyyy(lastDay)})`;
  return { periodFrom, periodTo, periodLabel };
}

interface RigCompanyRow {
  id: string; name: string; rigNumber: string;
  companyName: string | null; companyGstin: string | null;
}

function loadRig(rigId: string): RigCompanyRow {
  const row = db.prepare<[string], RigCompanyRow>(`
    SELECT r.id, r.name, r.rigNumber, c.name AS companyName, c.gstNumber AS companyGstin
    FROM rigs r LEFT JOIN companies c ON c.id = r.companyId
    WHERE r.id = ?
  `).get(rigId);
  if (!row) throw badRequest('That rig does not exist.');
  return row;
}

/** Same six DPR workType buckets services/dprOperationalData.ts already computes for the DPR Dashboard — read here, never recomputed differently. */
function loadDprHourBuckets(dprRigId: string | null, periodFrom: string, periodTo: string) {
  if (!dprRigId) return { r0Hours: 0, r1Hours: 0, r2Hours: 0, r22Hours: 0, r3Hours: 0, ilmHours: 0 };
  const row = db.prepare<[string, string, string], {
    r0Hours: number; r1Hours: number; r2Hours: number; r22Hours: number; r3Hours: number; ilmHours: number;
  }>(`
    SELECT
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R0' THEN li.totalHours END), 0) AS r0Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R1' THEN li.totalHours END), 0) AS r1Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R2' THEN li.totalHours END), 0) AS r2Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R2/2' THEN li.totalHours END), 0) AS r22Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'R3' THEN li.totalHours END), 0) AS r3Hours,
      COALESCE(SUM(CASE WHEN upper(trim(li.workType)) = 'ILM' THEN li.totalHours END), 0) AS ilmHours
    FROM dpr_line_items li
    JOIN dpr_reports rr ON rr.id = li.reportId
    WHERE rr.rigId = ? AND rr.dprDate >= ? AND rr.dprDate <= ?
  `).get(dprRigId, periodFrom, periodTo)!;
  return row;
}

/** Distinct well names DPR recorded for this rig in the period — "Well Location" on the invoice header. */
function loadWellLocation(dprRigId: string | null, periodFrom: string, periodTo: string): string | null {
  if (!dprRigId) return null;
  const rows = db.prepare<[string, string, string], { wellName: string }>(`
    SELECT DISTINCT li.wellName AS wellName
    FROM dpr_line_items li
    JOIN dpr_reports rr ON rr.id = li.reportId
    WHERE rr.rigId = ? AND rr.dprDate >= ? AND rr.dprDate <= ? AND li.wellName IS NOT NULL AND trim(li.wellName) != ''
    ORDER BY li.wellName
  `).all(dprRigId, periodFrom, periodTo);
  return rows.length ? rows.map((r) => r.wellName).join(', ') : null;
}

/** Count of ILM transactions this rig completed within the period — the ILM Charge row's Qty. */
function countCompletedIlm(ilmRigId: string | null, periodFrom: string, periodTo: string): number {
  if (!ilmRigId) return 0;
  return db.prepare<[string, string, string], { n: number }>(`
    SELECT COUNT(*) AS n FROM ilm_transactions
    WHERE rigId = ? AND status = 'Completed' AND date >= ? AND date <= ?
  `).get(ilmRigId, periodFrom, periodTo)!.n;
}

function buildPriceLines(hours: { r0Hours: number; r1Hours: number; r2Hours: number; r22Hours: number; r3Hours: number; ilmHours: number }, ilmQty: number, settings: InvoiceSettingsRecord | null): { lines: PriceLine[]; incomplete: boolean } {
  const operatingRate = settings?.operatingDayRate ?? null;
  const standbyRate = operatingRate !== null ? round2(operatingRate * (settings!.standbyRatePct / 100)) : 0;
  const repairRate = operatingRate !== null ? round2(operatingRate * (settings!.repairRatePct / 100)) : 0;
  const forceMajeureRate = settings?.forceMajeureRate ?? 0;
  const ilmRate = settings?.ilmChargeRate ?? null;

  const repairHours = hours.r2Hours + hours.r22Hours;
  const line = (sNo: number, particulars: string, totalHrs: number, qty: number, uom: string, rate: number): PriceLine => ({
    sNo, particulars, totalHrs: round2(totalHrs), qty, uom, rate, grossAmount: round2(rate * qty),
  });

  const lines: PriceLine[] = [
    line(1, 'Operating Day Rate', hours.r0Hours, round3(hours.r0Hours / 24), 'DAY', operatingRate ?? 0),
    line(2, 'Standby Day Rate', hours.r1Hours, round3(hours.r1Hours / 24), 'DAY', standbyRate),
    line(3, 'Repair Day Rate', repairHours, round3(repairHours / 24), 'DAY', repairRate),
    line(4, 'Force Majeure (During ILM - no charge)', hours.r3Hours, round3(hours.r3Hours / 24), 'DAY', forceMajeureRate),
    line(5, 'ILM Charge for Cluster Well (Lumpsump)', hours.ilmHours, ilmQty, 'Nos', ilmRate ?? 0),
  ];

  const incomplete = operatingRate === null || ilmRate === null || !settings;
  return { lines, incomplete };
}

export function buildInvoicePreview(rigId: string, month: string, invoiceDate: string): InvoicePreview {
  if (!invoiceDate) throw badRequest('Invoice Date is required.');
  const { periodFrom, periodTo, periodLabel } = resolveInvoicePeriod(month);
  const rig = loadRig(rigId);
  const settings = invoiceSettingsModel.get(rigId) ?? null;

  const [dprRigId] = resolveModuleRigIds([rigId], 'dpr_rigs');
  const [ilmRigId] = resolveModuleRigIds([rigId], 'ilm_rigs');

  const hours = loadDprHourBuckets(dprRigId ?? null, periodFrom, periodTo);
  const wellLocation = loadWellLocation(dprRigId ?? null, periodFrom, periodTo);
  const ilmQty = countCompletedIlm(ilmRigId ?? null, periodFrom, periodTo);

  const { lines, incomplete } = buildPriceLines(hours, ilmQty, settings);
  const totalAmount = round2(lines.reduce((sum, l) => sum + l.grossAmount, 0));
  const sgstPercent = settings?.sgstPercent ?? 9;
  const cgstPercent = settings?.cgstPercent ?? 9;
  const sgstAmount = round2(totalAmount * (sgstPercent / 100));
  const cgstAmount = round2(totalAmount * (cgstPercent / 100));
  const netAmount = round2(totalAmount + sgstAmount + cgstAmount);

  return {
    rigId: rig.id, rigName: rig.name, rigNumber: rig.rigNumber,
    invoiceDate, periodFrom, periodTo, periodLabel,
    clientName: rig.companyName, clientAddressBlock: settings?.clientAddressBlock ?? null, clientGstin: rig.companyGstin,
    contractNo: settings?.contractNo ?? null, accountingCode: settings?.accountingCode ?? null,
    wellLocation, contractorAddress: settings?.contractorAddress ?? null, contractorGstin: settings?.contractorGstin ?? null,
    priceLines: lines, totalAmount, sgstPercent, sgstAmount, cgstPercent, cgstAmount, netAmount,
    amountInWords: amountInWords(netAmount),
    bankAccountName: settings?.bankAccountName ?? null, bankName: settings?.bankName ?? null,
    bankAccountType: settings?.bankAccountType ?? null, bankAccountNumber: settings?.bankAccountNumber ?? null,
    bankIfsc: settings?.bankIfsc ?? null, pan: settings?.pan ?? null,
    authorisedEmail: settings?.authorisedEmail ?? null, signatoryCompanyName: settings?.signatoryCompanyName ?? null,
    settingsIncomplete: incomplete,
  };
}
