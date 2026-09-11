import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { api } from '../../lib/api';
import { rigLabel } from '../../lib/rig';
import { date } from '../../lib/format';
import { equipmentStatusPill, followupStatusPill, priorityPill } from '../../lib/ifu';
import type { Equipment, InternalFollowup, Rig, User } from '../../lib/types';
import { IFU_EQUIPMENT_STATUSES, IFU_PRIORITIES, IFU_STATUSES } from '../../lib/types';
import { Empty, ErrorBox, Field, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';

/**
 * The complete follow-up history — every entry ever recorded, filterable,
 * with the ability to update progress ("office team updates progress;
 * completed items are closed; unresolved items remain open for the next
 * meeting"). Equipment/Rig are locked once created (the frozen snapshot);
 * only the workflow fields (status, action, notes, target date, ...) are
 * ever re-saved from here.
 */
export default function InternalFollowupHistory() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<InternalFollowup[] | null>(null);
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<InternalFollowup | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

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
    const [list, rigData, eqData, userData] = await Promise.all([
      api.get<{ followups: InternalFollowup[] }>('/internal-followups'),
      api.get<{ rigs: Rig[] }>('/rigs'),
      api.get<{ equipment: Equipment[] }>('/equipment'),
      api.get<{ users: User[] }>('/users'),
    ]);
    setRows(list.followups);
    setRigs(rigData.rigs);
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

  async function save() {
    if (!editing) return;
    setError('');
    try {
      await run(async () => {
        await api.put(`/internal-followups/${editing.id}`, {
          equipmentStatus: editing.equipmentStatus,
          issue: editing.issue,
          discussionNote: editing.discussionNote,
          requiredAction: editing.requiredAction,
          responsiblePersonId: editing.responsiblePersonId,
          priority: editing.priority,
          targetDate: editing.targetDate,
          status: editing.status,
          remarks: editing.remarks,
        });
        await load();
      });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div>
      <PageHeader title="Follow-up History" subtitle="Every follow-up entry ever recorded — update progress or close an item as it's resolved." />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      {!rows ? <Spinner /> : (
        <>
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

          <div className="card overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Meeting Date</th><th>Rig</th><th>Equipment</th><th>Equipment Status</th>
                  <th>Issue / Observation</th><th>Action</th><th>Responsible</th><th>Priority</th>
                  <th>Target Date</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
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
                    <td className="text-right">
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(r)}><Pencil size={12} /></button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td colSpan={11}><Empty message="No follow-up entries match these filters." /></td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal open={!!editing} title="Update follow-up" onClose={() => setEditing(null)}>
        {editing && (
          <>
            <div className="text-sm text-slate-700 mb-3">
              <div className="font-medium">{editing.equipmentName}</div>
              <div className="text-xs text-slate-500">{editing.rigName || editing.rigNumber} — meeting {date(editing.meetingDate)}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Equipment Status">
                <select className="input" value={editing.equipmentStatus} onChange={(e) => setEditing({ ...editing, equipmentStatus: e.target.value as InternalFollowup['equipmentStatus'] })}>
                  {IFU_EQUIPMENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Priority">
                <select className="input" value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: e.target.value as InternalFollowup['priority'] })}>
                  {IFU_PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                </select>
              </Field>
              <div className="col-span-2">
                <Field label="Issue / Observation">
                  <textarea className="input" rows={2} value={editing.issue ?? ''} onChange={(e) => setEditing({ ...editing, issue: e.target.value })} />
                </Field>
              </div>
              <div className="col-span-2">
                <Field label="Office Discussion / Follow-up Note">
                  <textarea className="input" rows={2} value={editing.discussionNote ?? ''} onChange={(e) => setEditing({ ...editing, discussionNote: e.target.value })} />
                </Field>
              </div>
              <div className="col-span-2">
                <Field label="Required Action">
                  <textarea className="input" rows={2} value={editing.requiredAction ?? ''} onChange={(e) => setEditing({ ...editing, requiredAction: e.target.value })} />
                </Field>
              </div>
              <Field label="Responsible Person">
                <select className="input" value={editing.responsiblePersonId ?? ''} onChange={(e) => setEditing({ ...editing, responsiblePersonId: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              <Field label="Target Date">
                <input className="input" type="date" value={editing.targetDate ?? ''} onChange={(e) => setEditing({ ...editing, targetDate: e.target.value || null })} />
              </Field>
              <Field label="Status">
                <select className="input" value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as InternalFollowup['status'] })}>
                  {IFU_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <div className="col-span-2">
                <Field label="Remarks">
                  <textarea className="input" rows={2} value={editing.remarks ?? ''} onChange={(e) => setEditing({ ...editing, remarks: e.target.value })} />
                </Field>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
