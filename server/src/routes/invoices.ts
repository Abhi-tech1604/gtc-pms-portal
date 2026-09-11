import { Router } from 'express';
import { requireAuth, requirePage } from '../middleware/auth.js';
import { badRequest, notFound, wrap } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { buildInvoicePreview, resolveInvoicePeriod } from '../services/invoiceData.js';
import { invoicesModel } from '../services/invoices.js';
import { buildInvoiceExcel, buildInvoicePdf } from '../services/invoiceExport.js';

/** Admin > Invoice: Dashboard, Create Invoice (preview + save), Invoice History. Admin-only, same scope as the Follow-up module. */
export const invoicesRouter = Router();

invoicesRouter.get('/dashboard', requireAuth, requirePage('INVOICE','dashboard','view'), wrap((_req, res) => {
  res.json({ dashboard: invoicesModel.dashboard() });
}));

/** Live preview — computed fresh from Rig Master/Companies/Invoice Settings/DPR/ILM, never saved. */
invoicesRouter.get('/preview', requireAuth, requirePage('INVOICE','create','view'), wrap((req, res) => {
  const rigId = String(req.query.rigId ?? '');
  const month = String(req.query.month ?? '');
  const invoiceDate = String(req.query.invoiceDate ?? '');
  if (!rigId) throw badRequest('Select a Rig.');
  if (!month) throw badRequest('Select an Invoice Month.');
  const preview = buildInvoicePreview(rigId, month, invoiceDate || resolveInvoicePeriod(month).periodTo);
  res.json({ preview });
}));

invoicesRouter.get('/', requireAuth, requirePage('INVOICE','history','view'), wrap((req, res) => {
  const q = req.query;
  res.json({
    invoices: invoicesModel.list({
      rigId: q.rigId as string | undefined,
      status: q.status as string | undefined,
      dateFrom: q.dateFrom as string | undefined,
      dateTo: q.dateTo as string | undefined,
    }),
  });
}));

invoicesRouter.get('/:id', requireAuth, requirePage('INVOICE','history','view'), wrap((req, res) => {
  const invoice = invoicesModel.get(req.params.id);
  if (!invoice) throw notFound('That invoice does not exist.');
  res.json({ invoice });
}));

invoicesRouter.post('/', requireAuth, requirePage('INVOICE','create','create'), wrap((req, res) => {
  const body = req.body ?? {};
  const invoice = invoicesModel.create({
    rigId: String(body.rigId ?? ''), invoiceDate: String(body.invoiceDate ?? ''),
    periodFrom: String(body.periodFrom ?? ''), periodTo: String(body.periodTo ?? ''),
    periodLabel: String(body.periodLabel ?? ''), priceLines: body.priceLines, remarks: body.remarks ?? null,
  }, req.user!.username);

  audit({ user: req.user!.username, ip: req.clientIp, action: 'invoice.create', entity: 'invoices', entityId: invoice.id, newValue: invoice });
  res.status(201).json({ invoice });
}));

invoicesRouter.put('/:id/cancel', requireAuth, requirePage('INVOICE','history','delete'), wrap((req, res) => {
  const invoice = invoicesModel.cancel(req.params.id, req.user!.username);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'invoice.cancel', entity: 'invoices', entityId: invoice.id });
  res.json({ invoice });
}));

invoicesRouter.get('/:id/excel', requireAuth, requirePage('INVOICE','history','view'), wrap(async (req, res) => {
  const invoice = invoicesModel.get(req.params.id);
  if (!invoice) throw notFound('That invoice does not exist.');
  const buffer = await buildInvoiceExcel(invoice);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber.replace(/\//g, '-')}.xlsx"`);
  res.send(buffer);
}));

invoicesRouter.get('/:id/pdf', requireAuth, requirePage('INVOICE','history','view'), wrap(async (req, res) => {
  const invoice = invoicesModel.get(req.params.id);
  if (!invoice) throw notFound('That invoice does not exist.');
  const buffer = await buildInvoicePdf(invoice);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber.replace(/\//g, '-')}.pdf"`);
  res.send(buffer);
}));
