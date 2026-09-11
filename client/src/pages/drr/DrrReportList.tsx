import { useEffect, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { date, dateTime } from '../../lib/format';
import type { DrrReportStatus, DrrReportSummary } from '../../lib/types';
import { useAuth } from '../../lib/auth';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../../components/ui';

const STATUS_LABELS: Record<DrrReportStatus, string> = {
  Draft: 'Draft', PendingApproval: 'Pending Approval', Submitted: 'Submitted', Rejected: 'Rejected',
};
const STATUS_PILL: Record<DrrReportStatus, string> = {
  Draft: 'pill-place', PendingApproval: 'pill-upcoming', Submitted: 'pill-normal', Rejected: 'pill-overdue',
};

/**
 * Filters live in the URL (rigId/status/dateFrom/dateTo), not just local
 * state, so a DRR Dashboard status box can link straight to a pre-filtered
 * view here (?status=PendingApproval etc.) — "clicking a box opens the
 * corresponding filtered DRR list."
 */
export default function DrrReportList() {
  const { hasModuleAction } = useAuth();
  const [params, setParams] = useSearchParams();
  const [rigs, setRigs] = useState<{ id: string; rigNumber: string; name: string }[]>([]);
  const [reports, setReports] = useState<DrrReportSummary[] | null>(null);
  const [error, setError] = useState('');

  const filters = {
    rigId: params.get('rigId') ?? '', status: params.get('status') ?? '',
    dateFrom: params.get('dateFrom') ?? '', dateTo: params.get('dateTo') ?? '',
  };

  function setFilter(patch: Partial<typeof filters>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ ...filters, ...patch })) {
      if (v) next.set(k, v); else next.delete(k);
    }
    setParams(next, { replace: true });
  }

  useEffect(() => {
    api.get<{ rigs: typeof rigs }>('/drr/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    const q = new URLSearchParams();
    if (filters.rigId) q.set('rigId', filters.rigId);
    if (filters.status) q.set('status', filters.status);
    if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) q.set('dateTo', filters.dateTo);
    api.get<{ reports: DrrReportSummary[] }>(`/drr/reports?${q}`).then((d) => setReports(d.reports)).catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const hasFilters = !!(filters.rigId || filters.status || filters.dateFrom || filters.dateTo);

  return (
    <div>
      <PageHeader
        title="Daily Rig Reports"
        subtitle="Every unified daily entry — each one updates DPR, Mechanical Log and HSD together."
        actions={hasModuleAction('DRR', 'create') ? (
          <Link to="/drr/new" className="btn-primary"><Plus size={14} /> New Daily Report</Link>
        ) : undefined}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
        <select className="input" value={filters.rigId} onChange={(e) => setFilter({ rigId: e.target.value })}>
          <option value="">All Rigs</option>
          {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
        </select>
        <select className="input" value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
          <option value="">All Status</option>
          {(Object.keys(STATUS_LABELS) as DrrReportStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <Field label=""><input className="input" type="date" value={filters.dateFrom} onChange={(e) => setFilter({ dateFrom: e.target.value })} /></Field>
        <Field label=""><input className="input" type="date" value={filters.dateTo} onChange={(e) => setFilter({ dateTo: e.target.value })} /></Field>
        <button className="btn-ghost justify-center" disabled={!hasFilters} onClick={() => setParams(new URLSearchParams(), { replace: true })}>
          <X size={14} /> Clear
        </button>
      </div>

      <div className="card">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Rig</th><th>Well</th><th>Status</th><th>Submitted By</th><th>Updated</th><th /></tr>
            </thead>
            <tbody>
              {!reports ? (
                <tr><td colSpan={7}><Spinner /></td></tr>
              ) : reports.length === 0 ? (
                <tr><td colSpan={7}><Empty message="No Daily Rig Reports match these filters." /></td></tr>
              ) : reports.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium whitespace-nowrap">{date(r.reportDate)}</td>
                  <td>{r.rigNumber}</td>
                  <td className="text-xs">{r.wellNo ?? '-'}</td>
                  <td>
                    <span className={STATUS_PILL[r.status]}>{STATUS_LABELS[r.status]}</span>
                    {r.status === 'Rejected' && r.rejectionReason && (
                      <div className="text-[11px] text-red-700 mt-0.5 max-w-[200px] truncate" title={r.rejectionReason}>{r.rejectionReason}</div>
                    )}
                  </td>
                  <td className="text-xs">{r.submittedBy}</td>
                  <td className="text-xs whitespace-nowrap">{dateTime(r.updatedAt)}</td>
                  <td className="text-right"><Link to={`/drr/reports/${r.id}`} className="text-rig-700 hover:underline text-xs">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
