import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { rigLabel } from '../../lib/rig';
import { count, todayIso } from '../../lib/format';
import type { InvoicePreview, InvoicePriceLine, Rig } from '../../lib/types';
import { ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

/**
 * Select Rig -> Invoice Month -> Invoice Date, then the whole invoice is
 * computed live from Rig Master/Companies/Invoice Settings/DPR/ILM (Preview).
 * Only the price-line numbers and Remarks are editable — every header/footer
 * field stays read-only, sourced from the portal, matching "Edit only
 * permitted invoice-specific fields."
 */
export default function CreateInvoice() {
  const navigate = useNavigate();
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [rigId, setRigId] = useState('');
  const [month, setMonth] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [lines, setLines] = useState<InvoicePriceLine[]>([]);
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, run] = useBusy();

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs.filter((r) => r.status === 'Active'))).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (!rigId || !month) { setPreview(null); return; }
    setLoading(true); setError('');
    const q = `?rigId=${rigId}&month=${month}${invoiceDate ? `&invoiceDate=${invoiceDate}` : ''}`;
    api.get<{ preview: InvoicePreview }>(`/invoices/preview${q}`)
      .then((d) => { setPreview(d.preview); setLines(d.preview.priceLines); })
      .catch((e) => { setError((e as Error).message); setPreview(null); })
      .finally(() => setLoading(false));
  }, [rigId, month, invoiceDate]);

  function updateLine(i: number, patch: Partial<InvoicePriceLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch, grossAmount: round2((patch.rate ?? l.rate) * (patch.qty ?? l.qty)) } : l)));
  }

  const totals = useMemo(() => {
    const totalAmount = round2(lines.reduce((s, l) => s + l.grossAmount, 0));
    const sgstPercent = preview?.sgstPercent ?? 9;
    const cgstPercent = preview?.cgstPercent ?? 9;
    const sgstAmount = round2(totalAmount * (sgstPercent / 100));
    const cgstAmount = round2(totalAmount * (cgstPercent / 100));
    const netAmount = round2(totalAmount + sgstAmount + cgstAmount);
    return { totalAmount, sgstPercent, sgstAmount, cgstPercent, cgstAmount, netAmount };
  }, [lines, preview]);

  async function save() {
    if (!preview) return;
    setError('');
    try {
      const { invoice } = await run(() => api.post<{ invoice: { id: string } }>('/invoices', {
        rigId: preview.rigId, invoiceDate, periodFrom: preview.periodFrom, periodTo: preview.periodTo,
        periodLabel: preview.periodLabel, priceLines: lines, remarks: remarks || null,
      }));
      navigate(`/admin/invoice/history/${invoice.id}`);
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div>
      <PageHeader title="Create Invoice" subtitle="Select a Rig and Invoice Month — every figure is fetched from the portal's own records." />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-4 mb-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 max-w-2xl">
          <Field label="Rig">
            <select className="input" value={rigId} onChange={(e) => setRigId(e.target.value)}>
              <option value="">Choose a rig...</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          </Field>
          <Field label="Invoice Month / Period">
            <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
          <Field label="Invoice Date">
            <input className="input" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
        </div>
      </div>

      {loading && <Spinner label="Fetching invoice data from the portal..." />}

      {preview && !loading && (
        <>
          {preview.settingsIncomplete && (
            <InfoBox>
              Invoice Settings for this rig is incomplete (missing a day rate). Configure it under
              Admin → Invoice → Invoice Settings, or fill the Rate column below manually.
            </InfoBox>
          )}

          <div className="card p-4 mb-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">Invoice Header (from portal data)</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-sm">
              <HeaderField label="Client" value={preview.clientName} />
              <HeaderField label="Client GSTIN" value={preview.clientGstin} />
              <HeaderField label="Rig" value={`${preview.rigName}${preview.rigNumber && preview.rigNumber !== preview.rigName ? ` (${preview.rigNumber})` : ''}`} />
              <HeaderField label="Invoice Period" value={preview.periodLabel} />
              <HeaderField label="Contract No." value={preview.contractNo} />
              <HeaderField label="Accounting Code" value={preview.accountingCode} />
              <HeaderField label="Our Address" value={preview.contractorAddress} />
              <HeaderField label="Our GSTIN" value={preview.contractorGstin} />
              <HeaderField label="Well Location" value={preview.wellLocation} />
            </div>
          </div>

          <div className="card p-4 mb-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">Price Elements</h3>
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th>S.No.</th><th>Particulars</th><th className="text-right">Total Hrs</th>
                    <th className="text-right">Qty.</th><th>UOM</th><th className="text-right">Rate</th>
                    <th className="text-right">Gross Amount Without GST</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.sNo}>
                      <td className="num">{l.sNo}</td>
                      <td>{l.particulars}</td>
                      <td>
                        <input className="input py-1 text-right" type="number" value={l.totalHrs}
                          onChange={(e) => updateLine(i, { totalHrs: Number(e.target.value) || 0 })} />
                      </td>
                      <td>
                        <input className="input py-1 text-right" type="number" step="0.001" value={l.qty}
                          onChange={(e) => updateLine(i, { qty: Number(e.target.value) || 0 })} />
                      </td>
                      <td>
                        <input className="input py-1" value={l.uom}
                          onChange={(e) => updateLine(i, { uom: e.target.value })} />
                      </td>
                      <td>
                        <input className="input py-1 text-right" type="number" value={l.rate}
                          onChange={(e) => updateLine(i, { rate: Number(e.target.value) || 0 })} />
                      </td>
                      <td className="num font-medium">{count(l.grossAmount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 max-w-sm ml-auto space-y-1 text-sm">
              <Row label="Total Amount (INR) Rs." value={count(totals.totalAmount)} bold />
              <Row label={`Add SGST ${totals.sgstPercent}%`} value={count(totals.sgstAmount)} />
              <Row label={`Add CGST ${totals.cgstPercent}%`} value={count(totals.cgstAmount)} />
              <Row label="Net Amount Including GST (INR) Rs." value={count(totals.netAmount)} bold />
            </div>

            <Field label="Remarks" hint="The one freely-editable note field.">
              <textarea className="input mt-3" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </Field>

            <div className="flex justify-end pt-4">
              <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save Invoice</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function HeaderField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-slate-900">{value || '-'}</div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}
