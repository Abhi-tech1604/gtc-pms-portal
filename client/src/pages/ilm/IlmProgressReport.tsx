import { useEffect, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { Link } from 'react-router-dom';
import { Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { count, date } from '../../lib/format';
import type { IlmTransactionSummary, IlmRig } from '../../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, PageHeader, Spinner, useBusy } from '../../components/ui';
import { useAuth } from '../../lib/auth';

const fmtN = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

/**
 * One unified report of every ILM movement on record, Excel-imported and
 * manually entered together (spec 28) — and the entry point for creating/
 * editing one.
 */
export default function IlmProgressReport() {
  const { hasModuleAction } = useAuth();
  const [rigs, setRigs] = useState<IlmRig[]>([]);
  const [txns, setTxns] = useState<IlmTransactionSummary[] | null>(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    rigId: '', dateFrom: '', dateTo: '', ilmNumber: '', movementFrom: '', movementTo: '', status: '',
  });
  const [deleting, setDeleting] = useState<IlmTransactionSummary | null>(null);
  const [busy, run] = useBusy();

  const canCreate = hasModuleAction('ILM', 'create');
  const canEdit = hasModuleAction('ILM', 'edit');
  const canDelete = hasModuleAction('ILM', 'delete');

  useEffect(() => {
    api.get<{ rigs: IlmRig[] }>('/ilm/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  async function load() {
    const q = new URLSearchParams();
    if (filters.rigId) q.set('rigId', filters.rigId);
    if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) q.set('dateTo', filters.dateTo);
    if (filters.ilmNumber) q.set('ilmNumber', filters.ilmNumber);
    if (filters.movementFrom) q.set('movementFrom', filters.movementFrom);
    if (filters.movementTo) q.set('movementTo', filters.movementTo);
    if (filters.status) q.set('status', filters.status);
    const data = await api.get<{ transactions: IlmTransactionSummary[] }>(`/ilm/transactions?${q}`);
    setTxns(data.transactions);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [filters]);

  async function remove() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/ilm/transactions/${deleting.id}`); await load(); });
      setDeleting(null);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  return (
    <div>
      <PageHeader
        title="Progress Report"
        subtitle={txns ? `${count(txns.length)} ILM movement(s) — Excel-imported and manually entered together.` : undefined}
        actions={canCreate && (
          <Link to="/ilm/entry/new" className="btn-primary"><Plus size={14} /> New ILM</Link>
        )}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
          <option value="">All rigs</option>
          {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
        </select>
        <Field label=""><input className="input" type="date" value={filters.dateFrom} placeholder="From" onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} /></Field>
        <Field label=""><input className="input" type="date" value={filters.dateTo} placeholder="To" onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} /></Field>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input className="input pl-8" placeholder="ILM No." value={filters.ilmNumber}
            onChange={(e) => setFilters({ ...filters, ilmNumber: e.target.value })} />
        </div>
        <input className="input" placeholder="Movement From" value={filters.movementFrom} onChange={(e) => setFilters({ ...filters, movementFrom: e.target.value })} />
        <input className="input" placeholder="Movement To" value={filters.movementTo} onChange={(e) => setFilters({ ...filters, movementTo: e.target.value })} />
        <select className="input" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="Active">Active</option>
          <option value="Completed">Completed</option>
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>ILM No.</th><th>Rig</th><th>Date</th><th>From</th><th>To</th><th>Source</th>
              <th className="text-right">Dist (KM)</th><th className="text-right">Trailers</th><th className="text-right">Cranes</th>
              <th>Status</th><th>Created By</th><th />
            </tr>
          </thead>
          <tbody>
            {!txns ? (
              <tr><td colSpan={12}><Spinner /></td></tr>
            ) : txns.length === 0 ? (
              <tr><td colSpan={12}><Empty message="No ILM movements match these filters." /></td></tr>
            ) : txns.map((t) => (
              <tr key={t.id}>
                <td className="font-medium whitespace-nowrap">{t.ilmNumber}</td>
                <td>{t.rigNumber}</td>
                <td className="whitespace-nowrap">{date(t.date)}</td>
                <td className="text-xs">{t.movementFromWell ?? '-'}</td>
                <td className="text-xs">{t.movementToWell ?? '-'}</td>
                <td><span className={t.source === 'excel' ? 'pill-engine' : 'pill-normal'}>{t.source === 'excel' ? 'Excel' : 'Manual'}</span></td>
                <td className="num">{fmtN(t.totalDistanceKm)}</td>
                <td className="num">{count(t.trailerCount)}</td>
                <td className="num">{count(t.craneCount)}</td>
                <td>
                  <span className={`pill-engine ${t.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'}`}>
                    {t.status === 'Active' ? 'ACTIVE' : 'COMPLETED'}
                  </span>
                </td>
                <td className="text-xs">{t.createdBy}</td>
                <td className="whitespace-nowrap text-right">
                  <Link to={`/ilm/entry/${t.id}`} className="btn-ghost btn-sm mr-1">{canEdit ? 'Edit' : 'View'}</Link>
                  {canDelete && (
                    <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(t)}>
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
        title={`Delete ${deleting?.ilmNumber ?? 'this ILM movement'}?`}
        confirmLabel="Delete ILM"
        busy={busy}
        body={<p>All Individual, Trailer and Crane records for this movement will be removed. This cannot be undone.</p>}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
