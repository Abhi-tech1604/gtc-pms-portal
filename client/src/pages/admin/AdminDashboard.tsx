import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertOctagon, ClipboardCheck, ClipboardList, Cog, Factory, FlaskConical, Grid3x3, HeartPulse,
  LayoutList, Package, PackageOpen, ShieldCheck, Upload, UploadCloud, Users,
} from 'lucide-react';
import { rigLabel } from '../../lib/rig';
import { api } from '../../lib/api';
import { count, hours } from '../../lib/format';
import type { DashboardData, DprDashboardDataV2, IlmDashboardData, Rig, User } from '../../lib/types';
import { ErrorBox, Field, PageHeader, Spinner } from '../../components/ui';

/** Every escalation type an Admin can receive — "Fleet-wide escalations and critical notifications" (notification brief section 5), one card per type from GET /notifications/counts, the same data every dashboard's boxes read. */
const ADMIN_ALERT_TYPES: { type: string; label: string; href: string }[] = [
  { type: 'DRR_APPROVAL_ESCALATION', label: 'Approval Escalations', href: '/drr/reports?status=PendingApproval' },
  { type: 'SERVICE_OVERDUE_ESCALATION', label: 'Service Overdue', href: '/equipment?status=Overdue' },
  { type: 'HEALTH_CHECK_OVERDUE_ESCALATION', label: 'Health Check Overdue', href: '/equipment?health=Overdue' },
];

/**
 * Admin Panel's landing page — one workflow-shaped overview (Master Data ->
 * DRR -> DPR/HSD/ILM dashboards -> reports), not a place that re-embeds the
 * DPR/ILM modules' own full dashboards (those are reachable from the module
 * switcher already, with their own filters/charts/exports — duplicating
 * them here just for Admin was scope creep). Every KPI here reads from the
 * same endpoints those modules already expose; nothing is computed twice.
 */
export default function AdminDashboard() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [moduleCount, setModuleCount] = useState<number | null>(null);
  const [fleet, setFleet] = useState<DashboardData | null>(null);
  const [dpr, setDpr] = useState<DprDashboardDataV2 | null>(null);
  const [ilm, setIlm] = useState<IlmDashboardData | null>(null);
  const [drrCount, setDrrCount] = useState<number | null>(null);
  const [notifCounts, setNotifCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState('');

  // The Rig filter at the top of this page: PMS's Rig Master is the "master"
  // rig list (matching the Rig Master QuickLink below) and the id it sends
  // is a PMS rig id throughout — DPR and ILM each keep their own independent
  // rig table (schema.sql), so their dashboard endpoints bridge that PMS rig
  // id to their own rig id server-side (services/rigScope.ts's
  // resolveModuleRigIds, by rigKey — the same bridge account-based rig
  // scoping already uses), rather than this page guessing by rig number.
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [rigId, setRigId] = useState('');

  useEffect(() => {
    api.get<{ users: User[] }>('/users').then((d) => setUsers(d.users)).catch((e) => setError((e as Error).message));
    api.get<{ modules: { code: string }[] }>('/admin/modules').then((d) => setModuleCount(d.modules.length)).catch(() => {});
    api.get<{ counts: Record<string, number> }>('/notifications/counts').then((d) => setNotifCounts(d.counts)).catch(() => {});
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs)).catch(() => {});
  }, []);

  useEffect(() => {
    // Each module's own data is fetched independently and fails quietly (an
    // Admin may have a module globally switched off, which 403s it even for
    // Admin, by this session's own "off means off for everyone" rule) rather
    // than breaking the rest of the overview.
    const q = rigId ? `?rigId=${rigId}` : '';
    const pmsQ = rigId ? `?pmsRigId=${rigId}` : '';
    api.get<DashboardData>(`/dashboard${q}`).then(setFleet).catch(() => setFleet(null));
    api.get<{ reports: unknown[] }>(`/drr/reports${q}`).then((d) => setDrrCount(d.reports.length)).catch(() => setDrrCount(null));
    api.get<DprDashboardDataV2>(`/dpr/dashboard${pmsQ}`).then(setDpr).catch(() => setDpr(null));
    api.get<IlmDashboardData>(`/ilm/dashboard${pmsQ}`).then(setIlm).catch(() => setIlm(null));
  }, [rigId]);

  return (
    <div>
      <PageHeader title="Admin Panel" subtitle="Overview — Master Data, Daily Rig Report activity and fleet compliance for GTC Oilfield Pvt Ltd." />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-5 max-w-xs">
        <Field label="Rig" hint="Filters Fleet & Compliance, Daily Reporting and ILM below. Critical Alerts and Accounts & Access always stay fleet-wide.">
          <select className="input" value={rigId} onChange={(e) => setRigId(e.target.value)}>
            <option value="">All Rigs</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
      </div>

      {!users ? <Spinner /> : (
        <OverviewPanel users={users} moduleCount={moduleCount} fleet={fleet} dpr={dpr} ilm={ilm} drrCount={drrCount} notifCounts={notifCounts} />
      )}
    </div>
  );
}

function OverviewPanel({
  users, moduleCount, fleet, dpr, ilm, drrCount, notifCounts,
}: {
  users: User[]; moduleCount: number | null;
  fleet: DashboardData | null; dpr: DprDashboardDataV2 | null; ilm: IlmDashboardData | null; drrCount: number | null;
  notifCounts: Record<string, number> | null;
}) {
  const active = users.filter((u) => u.status === 'Active').length;
  const admins = users.filter((u) => u.role === 'Admin').length;
  const fk = fleet?.kpis;
  const dk = dpr?.kpis;
  const ik = ilm?.kpis;
  const namedAlertTypes = new Set(ADMIN_ALERT_TYPES.map((a) => a.type));
  const otherCritical = notifCounts
    ? Object.entries(notifCounts).filter(([type]) => !namedAlertTypes.has(type)).reduce((sum, [, n]) => sum + n, 0)
    : undefined;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Critical Alerts</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {ADMIN_ALERT_TYPES.map((a) => (
            <Tile key={a.type} to={a.href} label={a.label} value={notifCounts?.[a.type]} icon={AlertOctagon} tone="red" />
          ))}
          <Tile to="/notifications" label="Other Critical Alerts" value={otherCritical} icon={AlertOctagon} tone="red" />
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Fleet &amp; Compliance</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile to="/rigs" label="Total Rigs" value={fk?.totalRigs} icon={Factory} />
          <Tile to="/equipment" label="Total Equipment" value={fk?.totalEquipment} icon={LayoutList} />
          <Tile to="/equipment?status=Overdue" label="Overdue Services" value={fk?.overdueServices} icon={AlertOctagon} tone="red" />
          <Tile to="/equipment?health=Overdue" label="Overdue Health Checks" value={fk?.overdueHealthChecks} icon={HeartPulse} tone="red" />
          <Tile to="/uploads/pending" label="Pending Yesterday Uploads" value={fk?.pendingYesterdayUploads} icon={Upload} tone="red" />
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Daily Reporting (DRR / DPR / HSD)</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile to="/drr/reports" label="Daily Rig Reports" value={drrCount ?? undefined} icon={ClipboardCheck} />
          <Tile to="/dpr/progress-report" label="DPR Activity Reports" value={dk?.totalDpr} icon={ClipboardList} />
          <Tile to="/dpr/operational-data" label="Total Rig Hours" value={dk?.totalRigHours} icon={ClipboardList} format={hours} />
          <Tile to="/dpr/hsd-report" label="Total Diesel (L)" value={dk?.totalDiesel} icon={ClipboardList} format={hours} />
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">ILM (Inter Location Movement)</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile to="/ilm" label="Active ILMs" value={ik?.activeMovements} icon={Package} tone="amber" />
          <Tile to="/ilm" label="Total ILMs" value={ik?.totalMovements} icon={Package} />
          <Tile to="/ilm" label="Total Distance (KM)" value={ik?.totalDistanceKm} icon={Package} format={hours} />
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Accounts &amp; Access</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Tile to="/admin/users" label="Total Accounts" value={users.length} icon={Users} sub={`${count(active)} active`} />
          <Tile to="/admin/users" label="Administrators" value={admins} icon={ShieldCheck} />
          <Tile to="/admin/modules" label="Application Modules" value={moduleCount ?? undefined} icon={Grid3x3} />
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Master Data &amp; Setup</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <QuickLink to="/admin/rigs" icon={Factory} title="Rig Master" subtitle="The primary rig register used across PMS." />
          <QuickLink to="/admin/equipment-master" icon={LayoutList} title="Equipment Master" subtitle="Per-rig equipment roster, linked to Material Master." />
          <QuickLink to="/admin/material-master" icon={Cog} title="Material Master" subtitle="Global Engine / Transmission catalog." />
          <QuickLink to="/admin/oil-lubricants" icon={PackageOpen} title="Oil &amp; Lubricant Master" subtitle="Global oil list and its per-equipment assignment." />
          <QuickLink to="/admin/drr-import" icon={UploadCloud} title="DRR Excel Import" subtitle="Admin-only bulk entry for Daily Rig Reports." />
          <QuickLink to="/admin/user-rights" icon={ShieldCheck} title="User Rights" subtitle="The per-flag PMS permission matrix." />
          <QuickLink to="/admin/modules" icon={Grid3x3} title="Modules" subtitle="Switch PMS / DPR / ILM / DRR on or off fleet-wide." />
          <QuickLink to="/admin/demo-data" icon={FlaskConical} title="Demo Data" subtitle="Load or clear sample data for training/testing." />
        </div>
      </section>
    </div>
  );
}

function Tile({
  to, label, value, icon: Icon, tone = 'slate', sub, format = count,
}: {
  to: string; label: string; value: number | undefined; icon: typeof Users; tone?: 'slate' | 'red' | 'amber'; sub?: string;
  format?: (n: number) => string;
}) {
  const toneClass = value !== undefined && value > 0
    ? (tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : 'text-slate-900')
    : 'text-slate-800';
  return (
    <Link to={to} className="card p-3 block no-underline transition-shadow hover:shadow-md hover:border-rig-300">
      <div className="flex items-start justify-between">
        <div className="text-[11px] font-medium text-slate-500 leading-tight pr-2">{label}</div>
        <Icon size={16} className="text-slate-400" />
      </div>
      <div className={`text-2xl font-semibold mt-1 ${toneClass}`}>{value === undefined ? '-' : format(value)}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div>}
    </Link>
  );
}

function QuickLink({ to, icon: Icon, title, subtitle }: { to: string; icon: typeof Users; title: string; subtitle: string }) {
  return (
    <Link to={to} className="card p-4 flex items-center gap-3 hover:border-rig-400 border border-transparent">
      <Icon size={20} className="text-rig-600 shrink-0" />
      <div>
        <div className="font-medium text-slate-800 text-sm">{title}</div>
        <div className="text-xs text-slate-500">{subtitle}</div>
      </div>
    </Link>
  );
}
