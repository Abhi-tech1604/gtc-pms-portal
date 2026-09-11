import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { rigLabel } from '../../lib/rig';
import { count, date } from '../../lib/format';
import type { Invoice, Rig } from '../../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../../components/ui';

const STATUS_PILL: Record<string, string> = { Final: 'pill bg-emerald-100 text-emerald-800', Cancelled: 'pill bg-slate-200 text-slate-700' };

/** Every invoice ever generated — Invoice No., Rig, Client, Month, Date, Total, GST, Net, Status, Created By. Click a row to open its full detail. */
export default function InvoiceHistory() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Invoice[] | null>(null);
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [error, setError] = useState('');

  const rigId = params.get('rigId') ?? '';
  const status = params.get('status') ?? '';
  const dateFrom = params.get('dateFrom') ?? '';
  const dateTo = params.get('dateTo') ?? '';

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }

  async function load() {
    const [inv, rigData] = await Promise.all([
      api.get<{ invoices: Invoice[] }>('/invoices'),
      api.get<{ rigs: Rig[] }>('/rigs'),
    ]);
    setRows(inv.invoices);
    setRigs(rigData.rigs);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) =>
      (!rigId || r.rigId === rigId) &&
      (!status || r.status === status) &&
      (!dateFrom || r.invoiceDate >= dateFrom) &&
      (!dateTo || r.invoiceDate <= dateTo),
    );
  }, [rows, rigId, status, dateFrom, dateTo]);

  return (
    <div>
      <PageHeader title="Invoice History" subtitle="Every invoice ever generated. Click one to open its complete details." />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      {!rows ? <Spinner /> : (
        <>
          <div className="card p-4 mb-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="From"><input className="input" type="date" value={dateFrom} onChange={(e) => setFilter('dateFrom', e.target.value)} /></Field>
              <Field label="To"><input className="input" type="date" value={dateTo} onChange={(e) => setFilter('dateTo', e.target.value)} /></Field>
              <Field label="Rig">
                <select className="input" value={rigId} onChange={(e) => setFilter('rigId', e.target.value)}>
                  <option value="">All Rigs</option>
                  {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <select className="input" value={status} onChange={(e) => setFilter('status', e.target.value)}>
                  <option value="">All Statuses</option>
                  <option>Final</option>
                  <option>Cancelled</option>
                </select>
              </Field>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Invoice No.</th><th>Rig</th><th>Client</th><th>Invoice Month</th><th>Invoice Date</th>
                  <th className="text-right">Total Amount</th><th className="text-right">GST</th>
                  <th className="text-right">Net Amount</th><th>Status</th><th>Created By</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <Link className="font-medium text-rig-700 hover:underline whitespace-nowrap" to={`/admin/invoice/history/${inv.id}`}>
                        {inv.invoiceNumber}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap">{inv.rigName || inv.rigNumber}</td>
                    <td className="whitespace-nowrap">{inv.clientName || '-'}</td>
                    <td className="whitespace-nowrap">{inv.periodLabel.split(' (')[0]}</td>
                    <td className="whitespace-nowrap">{date(inv.invoiceDate)}</td>
                    <td className="num">{count(inv.totalAmount)}</td>
                    <td className="num">{count(inv.sgstAmount + inv.cgstAmount)}</td>
                    <td className="num font-semibold">{count(inv.netAmount)}</td>
                    <td><span className={STATUS_PILL[inv.status] ?? 'pill'}>{inv.status}</span></td>
                    <td className="whitespace-nowrap">{inv.createdBy}</td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td colSpan={10}><Empty message="No invoices match these filters." /></td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
