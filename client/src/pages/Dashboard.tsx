import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertOctagon, CalendarClock, CheckCircle2, Clock, Cog, Factory, HeartPulse, Settings2,
} from 'lucide-react';
import { api } from '../lib/api';
import { count, date, hours, statusClass } from '../lib/format';
import type { DashboardData } from '../lib/types';
import { Empty, ErrorBox, PageHeader, Spinner } from '../components/ui';

/**
 * These four read from the notification system directly (Admin > Notification
 * Settings' configurable thresholds — default 250h service warning, 70-day
 * health-check warning), distinct from the tiles below (Overdue/Upcoming
 * Services & Health Checks), which are a separate, longstanding feature with
 * its own fixed 200h window — kept exactly as it was, not touched here.
 */
const NOTIFICATION_BOX_HREF: Record<string, string> = {
  SERVICE_DUE_SOON: '/equipment?status=Upcoming',
  SERVICE_OVERDUE: '/equipment?status=Overdue',
  HEALTH_CHECK_DUE_SOON: '/equipment?health=Upcoming',
  EQUIPMENT_HEALTH_CHECKUP_PENDING: '/equipment?health=Overdue',
};

/** Where each summary card leads. Reuses existing filtered views wherever one
 *  already exists (Equipment Directory's status/health filters) instead of
 *  duplicating a page that already shows the same list. */
const TILE_HREF: Record<string, string> = {
  'Total Rigs': '/rigs',
  'Total Equipment': '/equipment',
  'Overdue Services': '/equipment?status=Overdue',
  'Upcoming Services': '/equipment?status=Upcoming',
  'Overdue Health Checks': '/equipment?health=Overdue',
  'Upcoming Health Checks': '/equipment?health=Upcoming',
  'Uploads Today': '/uploads/today',
  'Engines Tracked': '/equipment-master',
  'Transmissions Tracked': '/equipment-master',
};

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [notifCounts, setNotifCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<DashboardData>('/dashboard')
      .then(setData)
      .catch((err) => setError((err as Error).message));
    api.get<{ counts: Record<string, number> }>('/notifications/counts')
      .then((d) => setNotifCounts(d.counts))
      .catch(() => {});
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Spinner label="Reading the fleet's current position..." />;

  const k = data.kpis;
  const tiles = [
    { label: 'Total Rigs', value: k.totalRigs, icon: Factory, tone: 'slate' },
    { label: 'Total Equipment', value: k.totalEquipment, icon: Settings2, tone: 'slate' },
    { label: 'Overdue Services', value: k.overdueServices, icon: AlertOctagon, tone: 'red' },
    { label: 'Upcoming Services', value: k.upcomingServices, icon: Clock, tone: 'amber' },
    { label: 'Overdue Health Checks', value: k.overdueHealthChecks, icon: HeartPulse, tone: 'red' },
    { label: 'Upcoming Health Checks', value: k.upcomingHealthChecks, icon: CalendarClock, tone: 'amber' },
    { label: 'Uploads Today', value: k.uploadsToday, icon: CheckCircle2, tone: 'emerald' },
    { label: 'Engines Tracked', value: k.totalEngines, icon: Cog, tone: 'slate' },
    { label: 'Transmissions Tracked', value: k.totalTransmissions, icon: Cog, tone: 'slate' },
  ] as const;

  return (
    <div>
      <PageHeader
        title="PMS Dashboard"
        subtitle={`Fleet position as of ${date(data.asOf)}. Upload status is judged against ${date(data.complianceDate)}.`}
      />

      <div className="mb-5">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Notifications</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <NotificationCard tone="amber" label="Service Due" value={notifCounts?.SERVICE_DUE_SOON} href={NOTIFICATION_BOX_HREF.SERVICE_DUE_SOON} />
          <NotificationCard tone="red" label="Service Overdue" value={notifCounts?.SERVICE_OVERDUE} href={NOTIFICATION_BOX_HREF.SERVICE_OVERDUE} />
          <NotificationCard tone="amber" label="Health Check Due" value={notifCounts?.HEALTH_CHECK_DUE_SOON} href={NOTIFICATION_BOX_HREF.HEALTH_CHECK_DUE_SOON} />
          <NotificationCard tone="red" label="Health Check Overdue" value={notifCounts?.EQUIPMENT_HEALTH_CHECKUP_PENDING} href={NOTIFICATION_BOX_HREF.EQUIPMENT_HEALTH_CHECKUP_PENDING} />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {tiles.map((t) => (
          <Link
            key={t.label}
            to={TILE_HREF[t.label]}
            className="card p-3 block no-underline cursor-pointer transition-shadow hover:shadow-md hover:border-rig-300"
          >
            <div className="flex items-start justify-between">
              <div className="text-[11px] font-medium text-slate-500 leading-tight pr-2">{t.label}</div>
              <t.icon size={16} className={toneText(t.tone)} />
            </div>
            <div className={`text-2xl font-semibold mt-1 ${t.value > 0 ? toneText(t.tone) : 'text-slate-800'}`}>
              {count(t.value)}
            </div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Machines Needing Attention</h2>
            <Link to="/equipment?status=Overdue" className="text-xs text-rig-700 hover:underline">
              Open Equipment Directory
            </Link>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Rig</th>
                  <th>Machine</th>
                  <th className="text-right">Current Hrs</th>
                  <th className="text-right">Hrs Remaining</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.attention.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">{e.rigNumber}</td>
                    <td>
                      <Link to={`/equipment/${e.id}`} className="text-rig-700 hover:underline">{e.name}</Link>
                      <div className="text-[11px] text-slate-500">{e.category}</div>
                    </td>
                    <td className="num">{hours(e.currentRunningHours)}</td>
                    <td className={`num font-semibold ${e.remainingServiceHours <= 0 ? 'text-red-600' : 'text-amber-700'}`}>
                      {hours(e.remainingServiceHours)}
                    </td>
                    <td><span className={statusClass(e.status)}>{e.status}</span></td>
                  </tr>
                ))}
                {data.attention.length === 0 && (
                  <tr><td colSpan={5}><Empty message="No machine is due or overdue for service." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Health Checkup Countdown</h2>
            <Link to="/equipment?health=Overdue" className="text-xs text-rig-700 hover:underline">
              Open Equipment Directory
            </Link>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Rig</th>
                  <th>Machine</th>
                  <th className="text-right">Last Checked</th>
                  <th className="text-right">Days Remaining</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.healthAttention.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap">{e.rigNumber}</td>
                    <td>
                      <Link to={`/equipment/${e.id}`} className="text-rig-700 hover:underline">{e.name}</Link>
                      <div className="text-[11px] text-slate-500">{e.category}</div>
                    </td>
                    <td className="num whitespace-nowrap">{date(e.lastHealthCheckDate)}</td>
                    <td className={`num font-semibold ${
                      e.remainingHealthCheckDays === null || e.remainingHealthCheckDays <= 0
                        ? 'text-red-600' : 'text-amber-700'
                    }`}>
                      {e.remainingHealthCheckDays === null ? 'never checked' : hours(e.remainingHealthCheckDays)}
                    </td>
                    <td><span className={statusClass(e.healthStatus)}>{e.healthStatus}</span></td>
                  </tr>
                ))}
                {data.healthAttention.length === 0 && (
                  <tr><td colSpan={5}><Empty message="No machine is due or overdue for a health checkup." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Fleet Breakdown</h2>
          </div>
          <div className="p-4 grid grid-cols-2 gap-6">
            <div>
              <div className="text-[11px] font-semibold text-slate-500 uppercase mb-2">By service status</div>
              {Object.entries(data.byStatus).map(([status, n]) => (
                <div key={status} className="flex items-center justify-between py-1 text-sm">
                  <span className={statusClass(status)}>{status}</span>
                  <span className="tabular-nums font-medium">{count(n)}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-500 uppercase mb-2">By category</div>
              {data.byCategory.length === 0 && <div className="text-sm text-slate-500">No machines yet.</div>}
              {data.byCategory.map((c) => (
                <div key={c.category} className="flex items-center justify-between py-1 text-sm">
                  <span className="text-slate-700">{c.category}</span>
                  <span className="tabular-nums font-medium">{count(c.count)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** One notification-count card, matching the tiles above visually but sourced from GET /notifications/counts. */
function NotificationCard({ tone, label, value, href }: { tone: 'amber' | 'red'; label: string; value: number | undefined; href: string }) {
  const n = value ?? 0;
  return (
    <Link to={href} className="card p-3 block no-underline cursor-pointer transition-shadow hover:shadow-md hover:border-rig-300">
      <div className="text-[11px] font-medium text-slate-500 leading-tight">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${n > 0 ? toneText(tone) : 'text-slate-800'}`}>{value === undefined ? '-' : n}</div>
    </Link>
  );
}

function toneText(tone: string): string {
  switch (tone) {
    case 'red': return 'text-red-600';
    case 'amber': return 'text-amber-600';
    case 'emerald': return 'text-emerald-600';
    default: return 'text-slate-500';
  }
}
