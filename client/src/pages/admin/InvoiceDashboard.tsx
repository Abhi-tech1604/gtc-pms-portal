import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, CalendarCheck, IndianRupee, Plus, Receipt } from 'lucide-react';
import { api } from '../../lib/api';
import { count } from '../../lib/format';
import type { InvoiceDashboardData } from '../../lib/types';
import { Empty, ErrorBox, PageHeader, Spinner } from '../../components/ui';

/** Invoice-only KPIs and a Rig-wise breakdown — nothing from any other module. */
export default function InvoiceDashboard() {
  const [data, setData] = useState<InvoiceDashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ dashboard: InvoiceDashboardData }>('/invoices/dashboard').then((d) => setData(d.dashboard)).catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div>
      <PageHeader
        title="Invoice Dashboard"
        subtitle="Monthly invoices generated from Rig Master, DRR/DPR, ILM and Invoice Settings."
        actions={<Link className="btn-primary" to="/admin/invoice/new"><Plus size={14} /> Create Invoice</Link>}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      {!data ? <Spinner /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Total Invoices" value={count(data.totalInvoices)} icon={Receipt} />
            <Tile label="Total Net Amount (₹)" value={count(data.totalNetAmount)} icon={IndianRupee} />
            <Tile label="This Month" value={`${count(data.thisMonthCount)} / ₹${count(data.thisMonthNetAmount)}`} icon={CalendarCheck} tone="amber" />
            <Tile label="Cancelled" value={count(data.cancelledCount)} icon={Ban} tone={data.cancelledCount > 0 ? 'red' : 'slate'} />
          </div>

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">Rig-wise Invoices</h3>
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead><tr><th>Rig</th><th className="text-right">Invoices</th><th className="text-right">Net Amount (₹)</th></tr></thead>
                <tbody>
                  {data.byRig.map((r) => (
                    <tr key={r.rigId}>
                      <td className="font-medium whitespace-nowrap">{r.rigName}</td>
                      <td className="num">{count(r.count)}</td>
                      <td className="num font-semibold">{count(r.netAmount)}</td>
                    </tr>
                  ))}
                  {data.byRig.length === 0 && <tr><td colSpan={3}><Empty message="No invoices generated yet." /></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, icon: Icon, tone = 'slate' }: {
  label: string; value: string; icon: typeof Receipt; tone?: 'slate' | 'red' | 'amber';
}) {
  const toneClass = tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-slate-900';
  return (
    <div className="card p-3">
      <div className="flex items-start justify-between">
        <div className="text-[11px] font-medium text-slate-500 leading-tight pr-2">{label}</div>
        <Icon size={16} className="text-slate-400" />
      </div>
      <div className={`text-xl font-semibold mt-1 ${toneClass}`}>{value}</div>
    </div>
  );
}
