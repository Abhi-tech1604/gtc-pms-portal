import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { nowIso } from '../util/date.js';
import { badRequest, notFound } from '../middleware/http.js';

/**
 * Admin > Invoice > Invoice Settings: per-rig contract/commercial terms that
 * do not exist anywhere else in this database (Contract No., Accounting
 * Code, our own GSTIN/PAN/bank details, day rates, GST %). Create Invoice
 * reads this live at preview time; once an invoice is saved, its own copy of
 * every one of these values is frozen onto the invoices row — editing
 * settings here never rewrites an already-saved invoice.
 */

export interface InvoiceSettingsRecord {
  id: string;
  rigId: string;
  contractNo: string | null;
  accountingCode: string | null;
  clientAddressBlock: string | null;
  contractorAddress: string | null;
  contractorGstin: string | null;
  operatingDayRate: number | null;
  standbyRatePct: number;
  repairRatePct: number;
  forceMajeureRate: number;
  ilmChargeRate: number | null;
  sgstPercent: number;
  cgstPercent: number;
  bankAccountName: string | null;
  bankName: string | null;
  bankAccountType: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  pan: string | null;
  authorisedEmail: string | null;
  signatoryCompanyName: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

function list(): InvoiceSettingsRecord[] {
  return db.prepare<[], InvoiceSettingsRecord>('SELECT * FROM invoice_settings ORDER BY rigId').all();
}

function get(rigId: string): InvoiceSettingsRecord | undefined {
  return db.prepare<[string], InvoiceSettingsRecord>('SELECT * FROM invoice_settings WHERE rigId = ?').get(rigId);
}

export interface InvoiceSettingsInput {
  contractNo?: string | null;
  accountingCode?: string | null;
  clientAddressBlock?: string | null;
  contractorAddress?: string | null;
  contractorGstin?: string | null;
  operatingDayRate?: number | null;
  standbyRatePct?: number;
  repairRatePct?: number;
  forceMajeureRate?: number;
  ilmChargeRate?: number | null;
  sgstPercent?: number;
  cgstPercent?: number;
  bankAccountName?: string | null;
  bankName?: string | null;
  bankAccountType?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  pan?: string | null;
  authorisedEmail?: string | null;
  signatoryCompanyName?: string | null;
}

function validate(input: InvoiceSettingsInput): void {
  const pct = (v: number | undefined, label: string) => {
    if (v !== undefined && (v < 0 || v > 100)) throw badRequest(`${label} must be between 0 and 100.`);
  };
  pct(input.standbyRatePct, 'Standby Rate %');
  pct(input.repairRatePct, 'Repair Rate %');
  pct(input.sgstPercent, 'SGST %');
  pct(input.cgstPercent, 'CGST %');
  if (input.operatingDayRate !== undefined && input.operatingDayRate !== null && input.operatingDayRate < 0) {
    throw badRequest('Operating Day Rate cannot be negative.');
  }
}

/** Upsert — one row per rig, created the first time an Admin saves settings for that rig. */
function upsert(rigId: string, input: InvoiceSettingsInput, user: string): InvoiceSettingsRecord {
  validate(input);
  const rig = db.prepare<[string], { id: string }>('SELECT id FROM rigs WHERE id = ?').get(rigId);
  if (!rig) throw badRequest('That rig does not exist.');

  const existing = get(rigId);
  const stamp = nowIso();

  if (!existing) {
    const id = newId('invset');
    db.prepare(`
      INSERT INTO invoice_settings (
        id, rigId, contractNo, accountingCode, clientAddressBlock, contractorAddress, contractorGstin,
        operatingDayRate, standbyRatePct, repairRatePct, forceMajeureRate, ilmChargeRate,
        sgstPercent, cgstPercent, bankAccountName, bankName, bankAccountType, bankAccountNumber,
        bankIfsc, pan, authorisedEmail, signatoryCompanyName, createdBy, createdAt, updatedBy, updatedAt
      ) VALUES (
        @id, @rigId, @contractNo, @accountingCode, @clientAddressBlock, @contractorAddress, @contractorGstin,
        @operatingDayRate, @standbyRatePct, @repairRatePct, @forceMajeureRate, @ilmChargeRate,
        @sgstPercent, @cgstPercent, @bankAccountName, @bankName, @bankAccountType, @bankAccountNumber,
        @bankIfsc, @pan, @authorisedEmail, @signatoryCompanyName, @user, @stamp, NULL, @stamp
      )
    `).run({
      id, rigId,
      contractNo: input.contractNo ?? null, accountingCode: input.accountingCode ?? null,
      clientAddressBlock: input.clientAddressBlock ?? null, contractorAddress: input.contractorAddress ?? null,
      contractorGstin: input.contractorGstin ?? null, operatingDayRate: input.operatingDayRate ?? null,
      standbyRatePct: input.standbyRatePct ?? 70, repairRatePct: input.repairRatePct ?? 60,
      forceMajeureRate: input.forceMajeureRate ?? 0, ilmChargeRate: input.ilmChargeRate ?? null,
      sgstPercent: input.sgstPercent ?? 9, cgstPercent: input.cgstPercent ?? 9,
      bankAccountName: input.bankAccountName ?? null, bankName: input.bankName ?? null,
      bankAccountType: input.bankAccountType ?? null, bankAccountNumber: input.bankAccountNumber ?? null,
      bankIfsc: input.bankIfsc ?? null, pan: input.pan ?? null, authorisedEmail: input.authorisedEmail ?? null,
      signatoryCompanyName: input.signatoryCompanyName ?? null, user, stamp,
    });
    return get(rigId)!;
  }

  const merged: Required<InvoiceSettingsInput> = {
    contractNo: input.contractNo !== undefined ? input.contractNo : existing.contractNo,
    accountingCode: input.accountingCode !== undefined ? input.accountingCode : existing.accountingCode,
    clientAddressBlock: input.clientAddressBlock !== undefined ? input.clientAddressBlock : existing.clientAddressBlock,
    contractorAddress: input.contractorAddress !== undefined ? input.contractorAddress : existing.contractorAddress,
    contractorGstin: input.contractorGstin !== undefined ? input.contractorGstin : existing.contractorGstin,
    operatingDayRate: input.operatingDayRate !== undefined ? input.operatingDayRate : existing.operatingDayRate,
    standbyRatePct: input.standbyRatePct ?? existing.standbyRatePct,
    repairRatePct: input.repairRatePct ?? existing.repairRatePct,
    forceMajeureRate: input.forceMajeureRate ?? existing.forceMajeureRate,
    ilmChargeRate: input.ilmChargeRate !== undefined ? input.ilmChargeRate : existing.ilmChargeRate,
    sgstPercent: input.sgstPercent ?? existing.sgstPercent,
    cgstPercent: input.cgstPercent ?? existing.cgstPercent,
    bankAccountName: input.bankAccountName !== undefined ? input.bankAccountName : existing.bankAccountName,
    bankName: input.bankName !== undefined ? input.bankName : existing.bankName,
    bankAccountType: input.bankAccountType !== undefined ? input.bankAccountType : existing.bankAccountType,
    bankAccountNumber: input.bankAccountNumber !== undefined ? input.bankAccountNumber : existing.bankAccountNumber,
    bankIfsc: input.bankIfsc !== undefined ? input.bankIfsc : existing.bankIfsc,
    pan: input.pan !== undefined ? input.pan : existing.pan,
    authorisedEmail: input.authorisedEmail !== undefined ? input.authorisedEmail : existing.authorisedEmail,
    signatoryCompanyName: input.signatoryCompanyName !== undefined ? input.signatoryCompanyName : existing.signatoryCompanyName,
  };
  validate(merged);

  db.prepare(`
    UPDATE invoice_settings SET
      contractNo=@contractNo, accountingCode=@accountingCode, clientAddressBlock=@clientAddressBlock,
      contractorAddress=@contractorAddress, contractorGstin=@contractorGstin, operatingDayRate=@operatingDayRate,
      standbyRatePct=@standbyRatePct, repairRatePct=@repairRatePct, forceMajeureRate=@forceMajeureRate,
      ilmChargeRate=@ilmChargeRate, sgstPercent=@sgstPercent, cgstPercent=@cgstPercent,
      bankAccountName=@bankAccountName, bankName=@bankName, bankAccountType=@bankAccountType,
      bankAccountNumber=@bankAccountNumber, bankIfsc=@bankIfsc, pan=@pan, authorisedEmail=@authorisedEmail,
      signatoryCompanyName=@signatoryCompanyName, updatedBy=@updatedBy, updatedAt=@stamp
    WHERE rigId=@rigId
  `).run({ ...merged, rigId, updatedBy: user, stamp });
  return get(rigId)!;
}

export const invoiceSettingsModel = { list, get, upsert };
export function requireInvoiceSettings(rigId: string): InvoiceSettingsRecord {
  const s = get(rigId);
  if (!s) throw notFound('No Invoice Settings configured for this rig yet. Configure it under Admin → Invoice → Invoice Settings first.');
  return s;
}
