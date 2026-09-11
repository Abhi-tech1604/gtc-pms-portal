import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, X } from 'lucide-react';
import { api } from '../../lib/api';
import { count, date, dateTime } from '../../lib/format';
import type { DprAuditEntry, DprReportSummary, DprRig } from '../../lib/types';
import { Empty, ErrorBox, PageHeader, Spinner } from '../../components/ui';

const fmtH = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

const ACTION_LABELS: Record<string, string> = {
  'dpr.create': 'Created',
  'dpr.update': 'Updated',
  'dpr.import': 'Imported from Excel',
  'dpr.delete': 'Deleted',
};

/**
 * The end of the dashboard's click-through: Dashboard -> Completed -> a rig's
 * green "Uploaded" pill -> this page — the current DPR list for one specific
 * rig, plus its full history (spec: "what was previously updated").
 */
export default function DprRigDetail() {
  const { rigId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [rig, setRig] = useState<DprRig | null>(null);
  const [reports, setReports] = useState<DprReportSummary[] | null>(null);
  const [history, setHistory] = useState<DprAuditEntry[] | null>(null);
  const [error, setError] = useState('');

  /** Seeded from the dashboard's own date window (passed in the query string),
   *  so arriving from a dashboard filtered to today lands on today's DPRs;
   *  the top-right From/To then widens it to any stretch of history. */
  const [dateFrom, setDateFrom] = useState(searchParams.get('dateFrom') ?? '');
  const [dateTo, setDateTo] = useState(searchParams.get('dateTo') ?? '');

  useEffect(() => {
    if (!rigId) return;
    api.get<{ rig: DprRig }>(`/dpr/rigs/${rigId}`).then((d) => setRig(d.rig)).catch((e) => setError((e as Error).message));
    api.get<{ entries: DprAuditEntry[] }>(`/dpr/rig-history/${rigId}`).then((d) => setHistory(d.entries)).catch((e) => setError((e as Error).message));
  }, [rigId]);

  useEffect(() => {
    if (!rigId) return;
    const q = new URLSearchParams({ rigId });
    if (dateFrom) q.set('dateFrom', dateFrom);
    if (dateTo) q.set('dateTo', dateTo);
    api.get<{ reports: DprReportSummary[] }>(`/dpr/reports?${q}`).then((d) => setReports(d.reports)).catch((e) => setError((e as Error).message));
  }, [rigId, dateFrom, dateTo]);

  if (!rig || !reports) {
    return (
      <div>
        <ErrorBox message={error} onDismiss={() => setError('')} />
        {!error && <Spinner />}
      </div>
    );
  }

  const latest = reports[0] as DprReportSummary | undefined;

  return (
    <div>
      <button className="btn-ghost btn-sm mb-3" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title={`DPR Details — ${rig.rigNumber}`}
          subtitle={rig.name}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">From</span>
          <input className="input w-auto" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <span className="text-xs text-slate-500">To</span>
          <input className="input w-auto" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          <button className="btn-ghost btn-sm" disabled={!dateFrom && !dateTo} onClick={() => { setDateFrom(''); setDateTo(''); }}>
            <X size={14} /> Clear
          </button>
        </div>
      </div>
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <div className="card p-4">
          <div className="text-xs text-slate-500 mb-1">Rig Name</div>
          <div className="text-lg font-semibold text-slate-900">{rig.rigNumber}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 mb-1">Latest DPR Date</div>
          <div className="text-lg font-semibold text-slate-900">{latest ? date(latest.dprDate) : '-'}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-slate-500 mb-1">Status</div>
          <div>
            {latest
              ? <span className="pill-normal">Uploaded</span>
              : <span className="pill-overdue">Pending</span>}
          </div>
        </div>
      </div>

      <div className="card mb-5">
        <div className="card-header">
          <h3 className="card-title">Current DPR List</h3>
          <span className="text-xs text-slate-500">
            {dateFrom || dateTo
              ? `${dateFrom ? date(dateFrom) : 'start'} — ${dateTo ? date(dateTo) : 'today'}`
              : 'All dates'}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Date</th><th>Source</th><th>Uploaded File</th><th className="text-right">Lines</th><th className="text-right">Hours</th><th>Created By</th><th /></tr></thead>
            <tbody>
              {reports.length === 0 && <tr><td colSpan={7}><Empty message="No DPR reports for this rig in this date range." /></td></tr>}
              {reports.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium whitespace-nowrap">{date(r.dprDate)}</td>
                  <td><span className={r.source === 'excel' ? 'pill-engine' : 'pill-normal'}>{r.source === 'excel' ? 'Excel' : 'Manual'}</span></td>
                  <td className="text-xs">{r.fileName ?? <span className="text-slate-400">Manual entry</span>}</td>
                  <td className="num">{count(r.lineCount)}</td>
                  <td className="num">{fmtH(r.totalHours)}</td>
                  <td className="text-xs">{r.createdBy}</td>
                  <td className="text-right"><Link to={`/dpr/entry/${r.id}`} className="text-rig-700 hover:underline text-xs">View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><h3 className="card-title">Previous Updates</h3></div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>When</th><th>Action</th><th>By</th><th>Detail</th></tr></thead>
            <tbody>
              {!history ? (
                <tr><td colSpan={4}><Spinner /></td></tr>
              ) : history.length === 0 ? (
                <tr><td colSpan={4}><Empty message="No history recorded yet." /></td></tr>
              ) : history.map((h) => (
                <tr key={h.id}>
                  <td className="whitespace-nowrap text-xs">{dateTime(h.time)}</td>
                  <td>{ACTION_LABELS[h.action] ?? h.action}</td>
                  <td className="text-xs">{h.user ?? '-'}</td>
                  <td className="text-xs text-slate-500">{h.detail ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
