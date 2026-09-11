import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso, today } from '../util/date.js';
import { badRequest, notFound } from '../middleware/http.js';
import { amountInWords } from '../util/numberToWords.js';
import type { PriceLine } from './invoiceData.js';

/**
 * Admin > Invoice > Create Invoice's Save step. Everything about the client,
 * rig, contract and bank/GST footer is re-read fresh from Rig Master/
 * Companies/Invoice Settings at save time (never trusted from the client) —
 * only the 5 price-element rows (Total Hrs/Qty/Rate, the fields Create
 * Invoice's Preview explicitly allows an Admin to adjust) and Remarks come
 * from the caller. Once inserted, every value here is a frozen snapshot:
 * editing Invoice Settings, Rig Master, Companies, or correcting DRR/DPR/ILM
 * data afterwards never changes an already-saved invoice (spec: "preserve
 * its historical values even if operational data changes later").
 */

export interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  rigId: string;
  invoiceDate: string;
  periodFrom: string;
  periodTo: string;
  periodLabel: string;
  clientName: string | null;
  clientAddressBlock: string | null;
  clientGstin: string | null;
  rigName: string;
  rigNumber: string;
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
  status: 'Final' | 'Cancelled';
  remarks: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

interface InvoiceRow extends Omit<InvoiceRecord, 'priceLines'> {
  priceLines: string;
}

function toView(row: InvoiceRow): InvoiceRecord {
  return { ...row, priceLines: JSON.parse(row.priceLines) as PriceLine[] };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function slug(s: string): string {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function generateInvoiceNumber(rigNumber: string, month: string): string {
  const base = `INV/${slug(rigNumber)}/${month.replace('-', '')}`;
  const exists = (n: string) => !!db.prepare('SELECT 1 FROM invoices WHERE invoiceNumber = ?').get(n);
  if (!exists(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${newId('x')}`;
}

function validatePriceLines(lines: unknown): PriceLine[] {
  if (!Array.isArray(lines) || lines.length === 0) throw badRequest('At least one price element line is required.');
  return lines.map((raw, i) => {
    const l = raw as Partial<PriceLine>;
    const particulars = String(l.particulars ?? '').trim();
    if (!particulars) throw badRequest(`Line ${i + 1}: Particulars is required.`);
    const totalHrs = Number(l.totalHrs) || 0;
    const qty = Number(l.qty) || 0;
    const rate = Number(l.rate) || 0;
    const uom = String(l.uom ?? '').trim() || 'DAY';
    if (qty < 0 || rate < 0 || totalHrs < 0) throw badRequest(`Line ${i + 1}: values cannot be negative.`);
    return { sNo: i + 1, particulars, totalHrs: round2(totalHrs), qty, uom, rate, grossAmount: round2(rate * qty) };
  });
}

export interface InvoiceCreateInput {
  rigId: string;
  invoiceDate: string;
  periodFrom: string;
  periodTo: string;
  periodLabel: string;
  priceLines: unknown;
  remarks?: string | null;
}

function create(input: InvoiceCreateInput, user: string): InvoiceRecord {
  if (!input.rigId) throw badRequest('Select a Rig.');
  if (!input.invoiceDate) throw badRequest('Invoice Date is required.');
  if (!input.periodFrom || !input.periodTo || !input.periodLabel) throw badRequest('Invoice Period is required.');

  const rig = db.prepare<[string], { id: string; name: string; rigNumber: string; companyName: string | null; companyGstin: string | null }>(`
    SELECT r.id, r.name, r.rigNumber, c.name AS companyName, c.gstNumber AS companyGstin
    FROM rigs r LEFT JOIN companies c ON c.id = r.companyId WHERE r.id = ?
  `).get(input.rigId);
  if (!rig) throw badRequest('That rig does not exist.');

  const dup = db.prepare(
    "SELECT 1 FROM invoices WHERE rigId = ? AND periodFrom = ? AND periodTo = ? AND status != 'Cancelled'",
  ).get(input.rigId, input.periodFrom, input.periodTo);
  if (dup) throw badRequest('An invoice already exists for this Rig and Invoice Period. Cancel it first if you need to reissue.');

  const settings = db.prepare<[string], {
    contractNo: string | null; accountingCode: string | null; clientAddressBlock: string | null;
    contractorAddress: string | null; contractorGstin: string | null; sgstPercent: number; cgstPercent: number;
    bankAccountName: string | null; bankName: string | null; bankAccountType: string | null; bankAccountNumber: string | null;
    bankIfsc: string | null; pan: string | null; authorisedEmail: string | null; signatoryCompanyName: string | null;
  }>('SELECT * FROM invoice_settings WHERE rigId = ?').get(input.rigId);

  const priceLines = validatePriceLines(input.priceLines);
  const totalAmount = round2(priceLines.reduce((sum, l) => sum + l.grossAmount, 0));
  const sgstPercent = settings?.sgstPercent ?? 9;
  const cgstPercent = settings?.cgstPercent ?? 9;
  const sgstAmount = round2(totalAmount * (sgstPercent / 100));
  const cgstAmount = round2(totalAmount * (cgstPercent / 100));
  const netAmount = round2(totalAmount + sgstAmount + cgstAmount);

  const wellNameRows = db.prepare<[string, string, string], { wellName: string }>(`
    SELECT DISTINCT li.wellName AS wellName
    FROM dpr_line_items li JOIN dpr_reports rr ON rr.id = li.reportId
    JOIN dpr_rigs dr ON dr.id = rr.rigId JOIN rigs r ON r.rigKey = dr.rigKey
    WHERE r.id = ? AND rr.dprDate >= ? AND rr.dprDate <= ? AND li.wellName IS NOT NULL AND trim(li.wellName) != ''
    ORDER BY li.wellName
  `).all(input.rigId, input.periodFrom, input.periodTo);
  const wellLocation = wellNameRows.length ? wellNameRows.map((r) => r.wellName).join(', ') : null;

  const id = newId('inv');
  const month = input.periodFrom.slice(0, 7);
  const invoiceNumber = generateInvoiceNumber(rig.rigNumber, month);
  const stamp = nowIso();
  const words = amountInWords(netAmount);

  db.prepare(`
    INSERT INTO invoices (
      id, invoiceNumber, rigId, invoiceDate, periodFrom, periodTo, periodLabel,
      clientName, clientAddressBlock, clientGstin, rigName, rigNumber,
      contractNo, accountingCode, wellLocation, contractorAddress, contractorGstin,
      priceLines, totalAmount, sgstPercent, sgstAmount, cgstPercent, cgstAmount, netAmount, amountInWords,
      bankAccountName, bankName, bankAccountType, bankAccountNumber, bankIfsc, pan, authorisedEmail, signatoryCompanyName,
      status, remarks, createdBy, createdAt, updatedBy, updatedAt
    ) VALUES (
      @id, @invoiceNumber, @rigId, @invoiceDate, @periodFrom, @periodTo, @periodLabel,
      @clientName, @clientAddressBlock, @clientGstin, @rigName, @rigNumber,
      @contractNo, @accountingCode, @wellLocation, @contractorAddress, @contractorGstin,
      @priceLines, @totalAmount, @sgstPercent, @sgstAmount, @cgstPercent, @cgstAmount, @netAmount, @amountInWords,
      @bankAccountName, @bankName, @bankAccountType, @bankAccountNumber, @bankIfsc, @pan, @authorisedEmail, @signatoryCompanyName,
      'Final', @remarks, @user, @stamp, NULL, @stamp
    )
  `).run({
    id, invoiceNumber, rigId: input.rigId, invoiceDate: input.invoiceDate,
    periodFrom: input.periodFrom, periodTo: input.periodTo, periodLabel: input.periodLabel,
    clientName: rig.companyName, clientAddressBlock: settings?.clientAddressBlock ?? null, clientGstin: rig.companyGstin,
    rigName: rig.name, rigNumber: rig.rigNumber,
    contractNo: settings?.contractNo ?? null, accountingCode: settings?.accountingCode ?? null,
    wellLocation,
    contractorAddress: settings?.contractorAddress ?? null, contractorGstin: settings?.contractorGstin ?? null,
    priceLines: JSON.stringify(priceLines), totalAmount, sgstPercent, sgstAmount, cgstPercent, cgstAmount, netAmount,
    amountInWords: words,
    bankAccountName: settings?.bankAccountName ?? null, bankName: settings?.bankName ?? null,
    bankAccountType: settings?.bankAccountType ?? null, bankAccountNumber: settings?.bankAccountNumber ?? null,
    bankIfsc: settings?.bankIfsc ?? null, pan: settings?.pan ?? null,
    authorisedEmail: settings?.authorisedEmail ?? null, signatoryCompanyName: settings?.signatoryCompanyName ?? null,
    remarks: input.remarks || null, user, stamp,
  });

  return get(id)!;
}

export interface InvoiceFilters {
  rigId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

function list(filters: InvoiceFilters): InvoiceRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.rigId) { where.push('rigId = ?'); params.push(filters.rigId); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.dateFrom) { where.push('invoiceDate >= ?'); params.push(filters.dateFrom); }
  if (filters.dateTo) { where.push('invoiceDate <= ?'); params.push(filters.dateTo); }
  const sql = `SELECT * FROM invoices ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY invoiceDate DESC, createdAt DESC`;
  return db.prepare<unknown[], InvoiceRow>(sql).all(...params).map(toView);
}

function get(id: string): InvoiceRecord | undefined {
  const row = db.prepare<[string], InvoiceRow>('SELECT * FROM invoices WHERE id = ?').get(id);
  return row ? toView(row) : undefined;
}

function cancel(id: string, user: string): InvoiceRecord {
  const existing = get(id);
  if (!existing) throw notFound('That invoice does not exist.');
  if (existing.status === 'Cancelled') return existing;
  db.prepare("UPDATE invoices SET status = 'Cancelled', updatedBy = ?, updatedAt = ? WHERE id = ?")
    .run(user, nowIso(), id);
  return get(id)!;
}

export interface InvoiceDashboard {
  totalInvoices: number;
  totalNetAmount: number;
  thisMonthCount: number;
  thisMonthNetAmount: number;
  cancelledCount: number;
  byRig: { rigId: string; rigName: string; count: number; netAmount: number }[];
}

function dashboard(): InvoiceDashboard {
  const all = list({}).filter((i) => i.status !== 'Cancelled');
  const cancelledCount = list({ status: 'Cancelled' }).length;
  const month = today().slice(0, 7);
  const thisMonth = all.filter((i) => i.invoiceDate.slice(0, 7) === month);

  const byRigMap = new Map<string, { rigId: string; rigName: string; count: number; netAmount: number }>();
  for (const inv of all) {
    const row = byRigMap.get(inv.rigId) ?? { rigId: inv.rigId, rigName: inv.rigName, count: 0, netAmount: 0 };
    row.count++;
    row.netAmount = round2(row.netAmount + inv.netAmount);
    byRigMap.set(inv.rigId, row);
  }

  return {
    totalInvoices: all.length,
    totalNetAmount: round2(all.reduce((s, i) => s + i.netAmount, 0)),
    thisMonthCount: thisMonth.length,
    thisMonthNetAmount: round2(thisMonth.reduce((s, i) => s + i.netAmount, 0)),
    cancelledCount,
    byRig: [...byRigMap.values()].sort((a, b) => b.netAmount - a.netAmount),
  };
}

export const invoicesModel = { create, list, get, cancel, dashboard };
