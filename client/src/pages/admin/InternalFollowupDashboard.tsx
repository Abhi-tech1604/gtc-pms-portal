import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertOctagon, CheckCircle2, Clock, Factory, ListTodo, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { rigLabel } from '../../lib/rig';
import { date } from '../../lib/format';
import { equipmentStatusPill, followupStatusPill, priorityPill } from '../../lib/ifu';
import type { Equipment, InternalFollowup, InternalFollowupDashboard as Kpis, Rig, User } from '../../lib/types';
import { IFU_PRIORITIES, IFU_STATUSES } from '../../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../../components/ui';

/**
 * Management summary + filterable follow-up table + a Rig-wise drill-down —
 * "Admin should be able to select a Rig and immediately see: Rig -> Equipment
 * -> Current Status -> Issues -> ... -> Follow-up Status" is folded into this
 * page's Rig filter rather than a separate nav item, since the sidebar only
 * asks for three entries (Dashboard / New / History).
 */
export default function InternalFollowupDashboard() {
  const [params, setParams] = useSearchParams();
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [rows, setRows] = useState<InternalFollowup[] | null>(null);
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');

  const rigId = params.get('rigId') ?? '';
  const equipmentId = params.get('equipmentId') ?? '';
  const status = params.get('status') ?? '';
  const priority = params.get('priority') ?? '';
  const responsiblePersonId = params.get('responsiblePersonId') ?? '';
  const dateFrom = params.get('dateFrom') ?? '';
  const dateTo = params.get('dateTo') ?? '';

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }

  async function load() {
    const [k, list, rigData, eqData, userData] = await Promise.all([
      api.get<{ dashboard: Kpis }>('/internal-followups/dashboard'),
      api.get<{ followups: InternalFollowup[] }>('/internal-followups'),
      api.get<{ rigs: Rig[] }>('/rigs'),
      api.get<{ equipment: Equipment[] }>('/equipment'),
      api.get<{ users: User[] }>('/users'),
    ]);
    setKpis(k.dashboard);
    setRows(list.followups);
    setRigs(rigData.rigs.filter((r) => r.status === 'Active'));
    setEquipment(eqData.equipment);
    setUsers(userData.users.filter((u) => u.status === 'Active'));
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  const equipmentOptions = useMemo(
    () => (rigId ? equipment.filter((e) => e.rigId === rigId) : equipment),
    [equipment, rigId],
  );

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) =>
      (!rigId || r.rigId === rigId) &&
      (!equipmentId || r.equipmentId === equipmentId) &&
      (!status || r.status === status) &&
      (!priority || r.priority === priority) &&
      (!responsiblePersonId || r.responsiblePersonId === responsiblePersonId) &&
      (!dateFrom || r.meetingDate >= dateFrom) &&
      (!dateTo || r.meetingDate <= dateTo),
    );
  }, [rows, rigId, equipmentId, status, priority, responsiblePersonId, dateFrom, dateTo]);

  const rigSummary = useMemo(() => {
    const byRig = new Map<string, { rigId: string; rigName: string; open: number; inProgress: number; overdue: number; completed: number; total: number }>();
    for (const r of filtered) {
      const row = byRig.get(r.rigId) ?? { rigId: r.rigId, rigName: r.rigName || r.rigNumber, open: 0, inProgress: 0, overdue: 0, completed: 0, total: 0 };
      row.total++;
      if (r.status === 'Open') row.open++;
      if (r.status === 'In Progress') row.inProgress++;
      if (r.status === 'Completed') row.completed++;
      if (r.isOverdue) row.overdue++;
      byRig.set(r.rigId, row);
    }
    return [...byRig.values()].sort((a, b) => b.total - a.total);
  }, [filtered]);

  const equipmentSummary = useMemo(() => {
    const byEquipment = new Map<string, { equipmentId: string; equipmentName: string; rigName: string; open: number; total: number }>();
    for (const r of filtered) {
      const row = byEquipment.get(r.equipmentId) ?? { equipmentId: r.equipmentId, equipmentName: r.equipmentName, rigName: r.rigName || r.rigNumber, open: 0, total: 0 };
      row.total++;
      if (r.status !== 'Completed') row.open++;
      byEquipment.set(r.equipmentId, row);
    }
    return [...byEquipment.values()].sort((a, b) => b.open - a.open || b.total - a.total);
  }, [filtered]);

  const pendingActions = useMemo(() => {
    return filtered
      .filter((r) => r.status !== 'Completed' && r.requiredAction)
      .sort((a, b) => (a.targetDate ?? '9999-99-99').localeCompare(b.targetDate ?? '9999-99-99'));
  }, [filtered]);

  return (
    <div>
      <PageHeader
        title="Follow-up Dashboard"
        subtitle="Weekly office review — every Rig's equipment issues, actions and follow-up status in one place."
        actions={<Link className="btn-primary" to="/admin/followup/new"><Plus size={14} /> New Follow-up</Link>}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      {!kpis || !rows ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
            <Tile label="Total Open" value={kpis.totalOpen} icon={ListTodo} />
            <Tile label="In Progress" value={kpis.inProgress} icon={Clock} tone="amber" />
            <Tile label="Overdue" value={kpis.overdue} icon={AlertOctagon} tone="red" />
            <Tile label="Completed" value={kpis.completed} icon={CheckCircle2} tone="emerald" />
            <Tile label="High / Critical" value={kpis.highCriticalOpen} icon={AlertOctagon} tone="red" />
          </div>

          <div className="card p-4 mb-5">
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
              <Field label="From">
                <input className="input" type="date" value={dateFrom} onChange={(e) => setFilter('dateFrom', e.target.value)} />
              </Field>
              <Field label="To">
                <input className="input" type="date" value={dateTo} onChange={(e) => setFilter('dateTo', e.target.value)} />
              </Field>
              <Field label="Rig">
                <select className="input" value={rigId} onChange={(e) => { setFilter('rigId', e.target.value); setFilter('equipmentId', ''); }}>
                  <option value="">All Rigs</option>
                  {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
                </select>
              </Field>
              <Field label="Equipment">
                <select className="input" value={equipmentId} onChange={(e) => setFilter('equipmentId', e.target.value)}>
                  <option value="">All Equipment</option>
                  {equipmentOptions.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <select className="input" value={status} onChange={(e) => setFilter('status', e.target.value)}>
                  <option value="">All Statuses</option>
                  {IFU_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Priority">
                <select className="input" value={priority} onChange={(e) => setFilter('priority', e.target.value)}>
                  <option value="">All Priorities</option>
                  {IFU_PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                </select>
              </Field>
              <Field label="Responsible Person">
                <select className="input" value={responsiblePersonId} onChange={(e) => setFilter('responsiblePersonId', e.target.value)}>
                  <option value="">Everyone</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
            </div>
          </div>

          {rigId && (
            <div className="flex items-center gap-2 text-sm text-slate-600 mb-2">
              <Factory size={14} /> Rig-wise view: <span className="font-medium text-slate-900">{rigLabel(rigs.find((r) => r.id === rigId))}</span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-800 mb-3">Rig-wise Follow-ups</h3>
              <div className="overflow-x-auto">
                <table className="table text-xs">
                  <thead>
                    <tr><th>Rig</th><th className="text-right">Open</th><th className="text-right">In Progress</th><th className="text-right">Overdue</th><th className="text-right">Completed</th><th className="text-right">Total</th></tr>
                  </thead>
                  <tbody>
                    {rigSummary.map((r) => (
                      <tr key={r.rigId}>
                        <td className="font-medium whitespace-nowrap">{r.rigName}</td>
                        <td className="num">{r.open}</td>
                        <td className="num">{r.inProgress}</td>
                        <td className="num text-red-600 font-semibold">{r.overdue || '-'}</td>
                        <td className="num">{r.completed}</td>
                        <td className="num font-semibold">{r.total}</td>
                      </tr>
                    ))}
                    {rigSummary.length === 0 && <tr><td colSpan={6}><Empty message="No follow-up entries yet." /></td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-800 mb-3">Equipment-wise Issues</h3>
              <div className="overflow-x-auto">
                <table className="table text-xs">
                  <thead>
                    <tr><th>Equipment</th><th>Rig</th><th className="text-right">Open</th><th className="text-right">Total</th></tr>
                  </thead>
                  <tbody>
                    {equipmentSummary.map((e) => (
                      <tr key={e.equipmentId}>
                        <td className="font-medium whitespace-nowrap">{e.equipmentName}</td>
                        <td className="whitespace-nowrap">{e.rigName}</td>
                        <td className="num">{e.open || '-'}</td>
                        <td className="num font-semibold">{e.total}</td>
                      </tr>
                    ))}
                    {equipmentSummary.length === 0 && <tr><td colSpan={4}><Empty message="No follow-up entries yet." /></td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="card p-4 mb-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">Pending Actions</h3>
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr><th>Rig</th><th>Equipment</th><th>Required Action</th><th>Responsible</th><th>Priority</th><th>Target Date</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {pendingActions.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{r.rigName || r.rigNumber}</td>
                      <td className="font-medium whitespace-nowrap">{r.equipmentName}</td>
                      <td className="max-w-[260px]">{r.requiredAction}</td>
                      <td className="whitespace-nowrap">{r.responsiblePerson || '-'}</td>
                      <td><span className={priorityPill(r.priority)}>{r.priority}</span></td>
                      <td className="whitespace-nowrap">
                        {date(r.targetDate)}
                        {r.isOverdue && <div className="text-[10px] text-red-600 font-semibold mt-0.5">Overdue</div>}
                      </td>
                      <td><span className={followupStatusPill(r.status)}>{r.status}</span></td>
                    </tr>
                  ))}
                  {pendingActions.length === 0 && <tr><td colSpan={7}><Empty message="No pending actions." /></td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <FollowupTable rows={filtered} />
        </>
      )}
    </div>
  );
}

export function FollowupTable({ rows }: { rows: InternalFollowup[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="table text-xs">
        <thead>
          <tr>
            <th>Meeting Date</th><th>Rig</th><th>Equipment</th><th>Equipment Status</th>
            <th>Issue / Observation</th><th>Action</th><th>Responsible</th><th>Priority</th>
            <th>Target Date</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap">{date(r.meetingDate)}</td>
              <td className="whitespace-nowrap">{r.rigName || r.rigNumber}</td>
              <td className="font-medium whitespace-nowrap">
                {r.equipmentName}
                <div className="text-[10px] text-slate-500">{[r.equipmentMake, r.equipmentModel].filter(Boolean).join(' / ') || '-'}</div>
              </td>
              <td><span className={equipmentStatusPill(r.equipmentStatus)}>{r.equipmentStatus}</span></td>
              <td className="max-w-[220px]">{r.issue || '-'}</td>
              <td className="max-w-[220px]">{r.requiredAction || '-'}</td>
              <td className="whitespace-nowrap">{r.responsiblePerson || '-'}</td>
              <td><span className={priorityPill(r.priority)}>{r.priority}</span></td>
              <td className="whitespace-nowrap">
                {date(r.targetDate)}
                {r.isOverdue && <div className="text-[10px] text-red-600 font-semibold mt-0.5">Overdue</div>}
              </td>
              <td><span className={followupStatusPill(r.status)}>{r.status}</span></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={10}><Empty message="No follow-up entries match these filters." /></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Tile({ label, value, icon: Icon, tone = 'slate' }: {
  label: string; value: number; icon: typeof ListTodo; tone?: 'slate' | 'red' | 'amber' | 'emerald';
}) {
  const toneClass = value > 0
    ? (tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-slate-900')
    : 'text-slate-800';
  return (
    <div className="card p-3">
      <div className="flex items-start justify-between">
        <div className="text-[11px] font-medium text-slate-500 leading-tight pr-2">{label}</div>
        <Icon size={16} className="text-slate-400" />
      </div>
      <div className={`text-2xl font-semibold mt-1 ${toneClass}`}>{value}</div>
    </div>
  );
}
