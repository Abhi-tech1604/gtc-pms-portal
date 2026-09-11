import { useEffect, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { Link } from 'react-router-dom';
import { Search, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { count, date } from '../../lib/format';
import type { DprReportSummary, DprRig } from '../../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, PageHeader, Spinner, useBusy } from '../../components/ui';
import { useAuth } from '../../lib/auth';

const fmtH = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

/**
 * A read-only roll-up of every DPR activity line on record, Excel-imported
 * and DRR-entered together — daily DPR activity now only ever originates
 * from DRR (Daily Rig Report), so this list has no "New DPR" / Edit call to
 * action any more. DprEntry.tsx still exists (unlinked) for the rare
 * corrective edit an Admin needs to make directly.
 */
export default function DprProgressReport() {
  const { hasModuleAction } = useAuth();
  const [rigs, setRigs] = useState<DprRig[]>([]);
  const [reports, setReports] = useState<DprReportSummary[] | null>(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ rigId: '', dateFrom: '', dateTo: '', search: '' });
  const [deleting, setDeleting] = useState<DprReportSummary | null>(null);
  const [busy, run] = useBusy();

  const canDelete = hasModuleAction('DPR', 'delete');

  useEffect(() => {
    api.get<{ rigs: DprRig[] }>('/dpr/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  async function load() {
    const q = new URLSearchParams();
    if (filters.rigId) q.set('rigId', filters.rigId);
    if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) q.set('dateTo', filters.dateTo);
    if (filters.search) q.set('search', filters.search);
    const data = await api.get<{ reports: DprReportSummary[] }>(`/dpr/reports?${q}`);
    setReports(data.reports);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [filters]);

  async function remove() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/dpr/reports/${deleting.id}`); await load(); });
      setDeleting(null);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  return (
    <div>
      <PageHeader
        title="Progress Report"
        subtitle={reports ? `${count(reports.length)} DPR report(s) — logged from Daily Rig Report entries and Excel imports.` : undefined}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-4 grid grid-cols-1 md:grid-cols-5 gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input className="input pl-8" placeholder="Well, activity, remarks..." value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
        </div>
        <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
          <option value="">All rigs</option>
          {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
        </select>
        <Field label=""><input className="input" type="date" value={filters.dateFrom} placeholder="From" onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} /></Field>
        <Field label=""><input className="input" type="date" value={filters.dateTo} placeholder="To" onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} /></Field>
        <button className="btn-primary justify-center" onClick={() => void load().catch((e) => setError((e as Error).message))}>
          <Search size={14} /> Search
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Rig</th><th>Date</th><th>Source</th><th className="text-right">Lines</th>
              <th className="text-right">Hours</th><th>Created By</th><th />
            </tr>
          </thead>
          <tbody>
            {!reports ? (
              <tr><td colSpan={7}><Spinner /></td></tr>
            ) : reports.length === 0 ? (
              <tr><td colSpan={7}><Empty message="No DPR reports match these filters." /></td></tr>
            ) : reports.map((r) => (
              <tr key={r.id}>
                <td className="font-medium">{r.rigNumber}</td>
                <td className="whitespace-nowrap">{date(r.dprDate)}</td>
                <td><span className={r.source === 'excel' ? 'pill-engine' : 'pill-normal'}>{r.source === 'excel' ? 'Excel' : 'Manual'}</span></td>
                <td className="num">{count(r.lineCount)}</td>
                <td className="num">{fmtH(r.totalHours)}</td>
                <td className="text-xs">{r.createdBy}</td>
                <td className="whitespace-nowrap text-right">
                  <Link to={`/dpr/entry/${r.id}`} className="btn-ghost btn-sm mr-1">View</Link>
                  {canDelete && (
                    <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(r)}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title={`Delete the DPR for ${deleting?.rigNumber ?? ''} on ${deleting ? date(deleting.dprDate) : ''}?`}
        confirmLabel="Delete DPR"
        busy={busy}
        body={<p>{deleting?.lineCount} activity row(s) will be removed. This cannot be undone.</p>}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
