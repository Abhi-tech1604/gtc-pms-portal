import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ClipboardCheck, FileClock, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { date, count, todayIso } from '../../lib/format';
import type { DrrMyRigRoles, DrrReportSummary, DrrStatusCounts } from '../../lib/types';
import { useAuth } from '../../lib/auth';
import { ConfirmDialog, Empty, ErrorBox, PageHeader, Spinner, useBusy } from '../../components/ui';

type RecentFilter = 'All' | 'Submitted' | 'Draft';

/**
 * Daily Rig Report's own landing page. Role-aware: a Storekeeper sees
 * Draft/Pending Approval/Rejected/Submitted boxes for their assigned rigs; an
 * Operational Manager sees Pending Approval/Approved/Rejected for theirs;
 * Admin sees both, fleet-wide. Someone with neither role (today's default
 * for any account with no rig responsibility assignment) falls back to the
 * original 3-KPI summary, unchanged. Every box's count and its click-through
 * list come from the exact same server-side rig/status filter
 * (GET /drr/reports/status-counts and GET /drr/reports), so a box can never
 * disagree with what opening it shows.
 */
export default function DrrDashboard() {
  const { hasModuleAction, isAdmin } = useAuth();
  const [myRoles, setMyRoles] = useState<DrrMyRigRoles | null>(null);
  const [counts, setCounts] = useState<DrrStatusCounts | null>(null);
  const [overdueApprovals, setOverdueApprovals] = useState<number | null>(null);
  const [today, setToday] = useState<DrrReportSummary[] | null>(null);
  const [recent, setRecent] = useState<DrrReportSummary[] | null>(null);
  const [recentFilter, setRecentFilter] = useState<RecentFilter>('All');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<DrrReportSummary | null>(null);
  const [busy, run] = useBusy();

  function loadRecent(filter: RecentFilter) {
    setRecent(null);
    const query = filter === 'All' ? '' : `?status=${filter}`;
    api.get<{ reports: DrrReportSummary[] }>(`/drr/reports${query}`).then((d) => setRecent(d.reports.slice(0, 10)))
      .catch((e) => setError((e as Error).message));
  }

  useEffect(() => {
    api.get<DrrMyRigRoles>('/drr/rig-responsibility/my').then(setMyRoles).catch(() => {});
    api.get<{ counts: DrrStatusCounts; overdueApprovals: number }>('/drr/reports/status-counts')
      .then((d) => { setCounts(d.counts); setOverdueApprovals(d.overdueApprovals); })
      .catch((e) => setError((e as Error).message));
    const todayIsoStr = todayIso();
    api.get<{ reports: DrrReportSummary[] }>(`/drr/reports?dateFrom=${todayIsoStr}&dateTo=${todayIsoStr}`)
      .then((d) => setToday(d.reports)).catch((e) => setError((e as Error).message));
    loadRecent('All');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/drr/reports/${deleting.id}`); });
      setDeleting(null);
      loadRecent(recentFilter);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  const isStorekeeper = !!myRoles && (myRoles.isAdmin || myRoles.storekeeperRigIds.length > 0);
  const isManager = !!myRoles && (myRoles.isAdmin || myRoles.managerRigIds.length > 0);
  const showRoleBoxes = isStorekeeper || isManager;

  const submittedToday = today?.filter((r) => r.status !== 'Draft').length ?? 0;
  const draftsToday = today?.filter((r) => r.status === 'Draft').length ?? 0;

  return (
    <div>
      <PageHeader
        title="Daily Rig Report"
        subtitle="One entry per rig per day — updates DPR, Mechanical Log and HSD together."
        actions={hasModuleAction('DRR', 'create') ? (
          <Link to="/drr/new" className="btn-primary"><Plus size={14} /> New Daily Report</Link>
        ) : undefined}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      {showRoleBoxes ? (
        <>
          {isStorekeeper && (
            <div className="mb-5">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Storekeeper</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatusBox to="/drr/reports?status=Draft" tone="slate" label="Draft" value={counts?.Draft} />
                <StatusBox to="/drr/reports?status=PendingApproval" tone="amber" label="Pending Approval" value={counts?.PendingApproval} />
                <StatusBox to="/drr/reports?status=Rejected" tone="red" label="Rejected" value={counts?.Rejected} />
                <StatusBox to="/drr/reports?status=Submitted" tone="emerald" label="Submitted" value={counts?.Submitted} />
              </div>
            </div>
          )}
          {isManager && (
            <div className="mb-5">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Operational Manager</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatusBox to="/drr/reports?status=PendingApproval" tone="amber" label="Pending Approval" value={counts?.PendingApproval} />
                <StatusBox to="/drr/reports?status=PendingApproval" tone="red" label="Approval Overdue" value={overdueApprovals ?? undefined} />
                <StatusBox to="/drr/reports?status=Submitted" tone="emerald" label="Approved" value={counts?.Submitted} />
                <StatusBox to="/drr/reports?status=Rejected" tone="red" label="Rejected" value={counts?.Rejected} />
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          <Kpi icon={CheckCircle2} tone="emerald" label="Submitted Today" value={today ? count(submittedToday) : '-'} />
          <Kpi icon={FileClock} tone="amber" label="Drafts Today" value={today ? count(draftsToday) : '-'} />
          <Kpi icon={ClipboardCheck} tone="sky" label="Total Reports on Record" value={recent ? count(recent.length) : '-'} />
        </div>
      )}

      <div className="card">
        <div className="card-header flex items-center justify-between">
          <h3 className="card-title">Recent Reports</h3>
          <select
            className="input w-auto text-xs py-1"
            value={recentFilter}
            onChange={(e) => { const f = e.target.value as RecentFilter; setRecentFilter(f); loadRecent(f); }}
          >
            <option value="All">All statuses</option>
            <option value="Submitted">Submitted</option>
            <option value="Draft">Draft</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Date</th><th>Rig</th><th>Well</th><th>Status</th><th /></tr></thead>
            <tbody>
              {!recent ? (
                <tr><td colSpan={5}><Spinner /></td></tr>
              ) : recent.length === 0 ? (
                <tr><td colSpan={5}><Empty message={recentFilter === 'All' ? 'No Daily Rig Reports have been filed yet.' : `No ${recentFilter} reports.`} /></td></tr>
              ) : recent.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium whitespace-nowrap">{date(r.reportDate)}</td>
                  <td>{r.rigNumber}</td>
                  <td className="text-xs">{r.wellNo ?? '-'}</td>
                  <td>
                    <span className={
                      r.status === 'Draft' ? 'pill-place'
                        : r.status === 'PendingApproval' ? 'pill-upcoming'
                        : r.status === 'Rejected' ? 'pill-overdue' : 'pill-normal'
                    }>
                      {r.status === 'PendingApproval' ? 'Pending Approval' : r.status}
                    </span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <Link to={`/drr/reports/${r.id}`} className="text-rig-700 hover:underline text-xs">Open</Link>
                    {isAdmin && (
                      <button
                        className="btn-ghost btn-sm ml-2 text-red-700"
                        title="Delete this report"
                        onClick={() => setDeleting(r)}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title={`Delete the ${deleting ? date(deleting.reportDate) : ''} report for ${deleting?.rigNumber ?? ''}?`}
        confirmLabel="Delete report"
        busy={busy}
        body={<p>This permanently removes the Daily Rig Report and, if it was Submitted, the DPR / HSD / Mechanical Log entries it created. This cannot be undone.</p>}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

const TONES: Record<string, string> = {
  emerald: 'bg-emerald-100 text-emerald-600',
  amber: 'bg-amber-100 text-amber-600',
  sky: 'bg-sky-100 text-sky-600',
};

function Kpi({ icon: Icon, tone, label, value }: { icon: typeof CheckCircle2; tone: keyof typeof TONES; label: string; value: string }) {
  return (
    <div className="card p-4 flex items-center justify-between gap-3">
      <div>
        <div className="text-xs text-slate-500 mb-1">{label}</div>
        <div className="text-2xl font-semibold text-slate-900">{value}</div>
      </div>
      <span className={`shrink-0 h-9 w-9 rounded-lg grid place-items-center ${TONES[tone]}`}><Icon size={16} /></span>
    </div>
  );
}

const BOX_TONES: Record<string, string> = {
  slate: 'border-slate-200 hover:border-slate-300',
  amber: 'border-amber-200 hover:border-amber-300',
  red: 'border-red-200 hover:border-red-300',
  emerald: 'border-emerald-200 hover:border-emerald-300',
};
const BOX_VALUE_TONES: Record<string, string> = {
  slate: 'text-slate-700', amber: 'text-amber-700', red: 'text-red-700', emerald: 'text-emerald-700',
};

/** One clickable status card — "Clicking a box opens the corresponding filtered DRR list." */
function StatusBox({ to, tone, label, value }: { to: string; tone: keyof typeof BOX_TONES; label: string; value: number | undefined }) {
  return (
    <Link to={to} className={`card border-2 p-4 flex flex-col items-center justify-center text-center transition-colors ${BOX_TONES[tone]}`}>
      <div className={`text-3xl font-bold ${BOX_VALUE_TONES[tone]}`}>{value ?? '-'}</div>
      <div className="text-xs text-slate-600 mt-1">{label}</div>
    </Link>
  );
}
