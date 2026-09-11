import { Router } from 'express';
import { requireAuth, requirePage } from '../middleware/auth.js';
import { wrap } from '../middleware/http.js';
import { audit, auditDiff } from '../services/audit.js';
import { invoiceSettingsModel } from '../services/invoiceSettings.js';

/** Admin > Invoice > Invoice Settings: per-rig contract/commercial terms. Admin-only, same as the rest of the Invoice module. */
export const invoiceSettingsRouter = Router();

invoiceSettingsRouter.get('/', requireAuth, requirePage('INVOICE','settings','view'), wrap((_req, res) => {
  res.json({ settings: invoiceSettingsModel.list() });
}));

invoiceSettingsRouter.get('/:rigId', requireAuth, requirePage('INVOICE','settings','view'), wrap((req, res) => {
  res.json({ settings: invoiceSettingsModel.get(req.params.rigId) ?? null });
}));

invoiceSettingsRouter.put('/:rigId', requireAuth, requirePage('INVOICE','settings','edit'), wrap((req, res) => {
  const existing = invoiceSettingsModel.get(req.params.rigId);
  const body = req.body ?? {};
  const record = invoiceSettingsModel.upsert(req.params.rigId, {
    contractNo: body.contractNo, accountingCode: body.accountingCode, clientAddressBlock: body.clientAddressBlock,
    contractorAddress: body.contractorAddress, contractorGstin: body.contractorGstin,
    operatingDayRate: body.operatingDayRate !== undefined ? (body.operatingDayRate === null ? null : Number(body.operatingDayRate)) : undefined,
    standbyRatePct: body.standbyRatePct !== undefined ? Number(body.standbyRatePct) : undefined,
    repairRatePct: body.repairRatePct !== undefined ? Number(body.repairRatePct) : undefined,
    forceMajeureRate: body.forceMajeureRate !== undefined ? Number(body.forceMajeureRate) : undefined,
    ilmChargeRate: body.ilmChargeRate !== undefined ? (body.ilmChargeRate === null ? null : Number(body.ilmChargeRate)) : undefined,
    sgstPercent: body.sgstPercent !== undefined ? Number(body.sgstPercent) : undefined,
    cgstPercent: body.cgstPercent !== undefined ? Number(body.cgstPercent) : undefined,
    bankAccountName: body.bankAccountName, bankName: body.bankName, bankAccountType: body.bankAccountType,
    bankAccountNumber: body.bankAccountNumber, bankIfsc: body.bankIfsc, pan: body.pan,
    authorisedEmail: body.authorisedEmail, signatoryCompanyName: body.signatoryCompanyName,
  }, req.user!.username);

  if (existing) {
    auditDiff(
      { user: req.user!.username, ip: req.clientIp, action: 'invoiceSettings.update', entity: 'invoice_settings', entityId: record.id },
      existing as unknown as Record<string, unknown>, record as unknown as Record<string, unknown>,
    );
  } else {
    audit({ user: req.user!.username, ip: req.clientIp, action: 'invoiceSettings.create', entity: 'invoice_settings', entityId: record.id, newValue: record });
  }
  res.json({ settings: record });
}));
