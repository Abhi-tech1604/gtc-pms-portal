import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { rigLabel } from '../../lib/rig';
import { date, todayIso } from '../../lib/format';
import { equipmentStatusPill, followupStatusPill, priorityPill } from '../../lib/ifu';
import type { Equipment, InternalFollowup, Rig, User } from '../../lib/types';
import { IFU_EQUIPMENT_STATUSES, IFU_PRIORITIES, IFU_STATUSES } from '../../lib/types';
import { Empty, ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

interface DraftLine {
  key: number;
  equipmentId: string;
  equipmentStatus: string;
  issue: string;
  discussionNote: string;
  requiredAction: string;
  responsiblePersonId: string;
  priority: string;
  targetDate: string;
  status: string;
  remarks: string;
}

let draftKeySeq = 0;
function blankLine(): DraftLine {
  return {
    key: draftKeySeq++, equipmentId: '', equipmentStatus: 'Working', issue: '', discussionNote: '',
    requiredAction: '', responsiblePersonId: '', priority: 'Medium', targetDate: '', status: 'Open', remarks: '',
  };
}

/**
 * The weekly meeting flow: Meeting Date -> Select Rig -> review that rig's
 * still-open follow-ups from earlier meetings (update or close them) ->
 * record new equipment issues discussed today -> Save. Equipment always
 * comes live from Equipment Master, scoped to whatever is CURRENTLY assigned
 * to the selected rig (a transferred machine follows its new rig here
 * automatically, since this reads equipment.rigId directly, not a snapshot).
 */
export default function NewInternalFollowup() {
  const navigate = useNavigate();
  const [meetingDate, setMeetingDate] = useState(todayIso());
  const [rigId, setRigId] = useState('');
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [openFollowups, setOpenFollowups] = useState<InternalFollowup[] | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, run] = useBusy();
  const [progressBusy, runProgress] = useBusy();

  useEffect(() => {
    Promise.all([
      api.get<{ rigs: Rig[] }>('/rigs'),
      api.get<{ equipment: Equipment[] }>('/equipment'),
      api.get<{ users: User[] }>('/users'),
    ]).then(([r, e, u]) => {
      setRigs(r.rigs.filter((rig) => rig.status === 'Active'));
      setEquipment(e.equipment);
      setUsers(u.users.filter((usr) => usr.status === 'Active'));
    }).catch((e) => setError((e as Error).message));
  }, []);

  async function loadOpenFollowups(rig: string) {
    if (!rig) { setOpenFollowups(null); return; }
    const data = await api.get<{ followups: InternalFollowup[] }>(`/internal-followups?rigId=${rig}`);
    setOpenFollowups(data.followups.filter((f) => f.status !== 'Completed'));
  }

  useEffect(() => { loadOpenFollowups(rigId).catch((e) => setError((e as Error).message)); }, [rigId]);

  const rigEquipment = useMemo(() => equipment.filter((e) => e.rigId === rigId && e.isActive), [equipment, rigId]);

  function updateLine(key: number, patch: Partial<DraftLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function selectEquipment(key: number, equipmentId: string) {
    updateLine(key, { equipmentId });
  }

  async function updateProgress(f: InternalFollowup, patch: Partial<InternalFollowup>) {
    setError('');
    try {
      await runProgress(async () => {
        await api.put(`/internal-followups/${f.id}`, patch);
        await loadOpenFollowups(rigId);
      });
    } catch (e) { setError((e as Error).message); }
  }

  async function saveLines() {
    setError('');
    const toSave = lines.filter((l) => l.equipmentId);
    if (!rigId) { setError('Select a Rig.'); return; }
    if (toSave.length === 0) { setError('Add at least one equipment issue before saving.'); return; }
    try {
      await run(async () => {
        for (const l of toSave) {
          await api.post('/internal-followups', {
            meetingDate, rigId, equipmentId: l.equipmentId, equipmentStatus: l.equipmentStatus,
            issue: l.issue || null, discussionNote: l.discussionNote || null, requiredAction: l.requiredAction || null,
            responsiblePersonId: l.responsiblePersonId || null, priority: l.priority, targetDate: l.targetDate || null,
            status: l.status, remarks: l.remarks || null,
          });
        }
        await loadOpenFollowups(rigId);
      });
      setLines([blankLine()]);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div>
      <PageHeader title="New Follow-up" subtitle="Weekly office review meeting — select a rig, record equipment issues and actions, then save." />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      {saved && <InfoBox>Follow-up entries saved. Unresolved items stay open for next week's meeting.</InfoBox>}

      <div className="card p-4 mb-5">
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          <Field label="Meeting Date">
            <input className="input" type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} />
          </Field>
          <Field label="Rig">
            <select className="input" value={rigId} onChange={(e) => { setRigId(e.target.value); setLines([blankLine()]); }}>
              <option value="">Choose a rig...</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          </Field>
        </div>
      </div>

      {rigId && (
        <>
          <div className="card p-4 mb-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">Open Follow-ups Carried Forward</h3>
            {!openFollowups ? <Spinner /> : openFollowups.length === 0 ? (
              <Empty message="No open follow-ups for this rig — nothing carried forward from earlier meetings." />
            ) : (
              <div className="overflow-x-auto">
                <table className="table text-xs">
                  <thead>
                    <tr>
                      <th>Equipment</th><th>Equipment Status</th><th>Issue</th><th>Action</th>
                      <th>Responsible</th><th>Priority</th><th>Target Date</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openFollowups.map((f) => (
                      <tr key={f.id}>
                        <td className="font-medium whitespace-nowrap">{f.equipmentName}</td>
                        <td><span className={equipmentStatusPill(f.equipmentStatus)}>{f.equipmentStatus}</span></td>
                        <td className="max-w-[200px]">{f.issue || '-'}</td>
                        <td className="max-w-[200px]">{f.requiredAction || '-'}</td>
                        <td className="whitespace-nowrap">{f.responsiblePerson || '-'}</td>
                        <td><span className={priorityPill(f.priority)}>{f.priority}</span></td>
                        <td className="whitespace-nowrap">
                          {date(f.targetDate)}
                          {f.isOverdue && <div className="text-[10px] text-red-600 font-semibold mt-0.5">Overdue</div>}
                        </td>
                        <td>
                          <select
                            className="input py-1 text-xs" value={f.status} disabled={progressBusy}
                            onChange={(e) => void updateProgress(f, { status: e.target.value as InternalFollowup['status'] })}
                          >
                            {IFU_STATUSES.map((s) => <option key={s}>{s}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card p-4 mb-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-800">Equipment Reviewed This Meeting</h3>
              <button className="btn-ghost btn-sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>
                <Plus size={13} /> Add Equipment / Issue
              </button>
            </div>
            <div className="space-y-4">
              {lines.map((l, i) => {
                const eq = rigEquipment.find((e) => e.id === l.equipmentId);
                return (
                  <div key={l.key} className="border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs font-semibold text-slate-500">Line {i + 1}</div>
                      {lines.length > 1 && (
                        <button className="btn-ghost btn-sm" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="col-span-2 md:col-span-1">
                        <Field label="Equipment">
                          <select className="input" value={l.equipmentId} onChange={(e) => selectEquipment(l.key, e.target.value)}>
                            <option value="">Choose from Equipment Master...</option>
                            {rigEquipment.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                        </Field>
                      </div>
                      <Field label="Make" hint="From Equipment Master">
                        <input className="input bg-slate-50" value={eq?.manufacturer ?? ''} readOnly />
                      </Field>
                      <Field label="Model" hint="From Equipment Master">
                        <input className="input bg-slate-50" value={eq?.model ?? ''} readOnly />
                      </Field>
                      <Field label="Serial No." hint="From Equipment Master">
                        <input className="input bg-slate-50" value={eq?.serialNumber ?? ''} readOnly />
                      </Field>

                      <Field label="Equipment Status">
                        <select className="input" value={l.equipmentStatus} onChange={(e) => updateLine(l.key, { equipmentStatus: e.target.value })}>
                          {IFU_EQUIPMENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </Field>
                      <Field label="Priority">
                        <select className="input" value={l.priority} onChange={(e) => updateLine(l.key, { priority: e.target.value })}>
                          {IFU_PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                        </select>
                      </Field>
                      <Field label="Responsible Person">
                        <select className="input" value={l.responsiblePersonId} onChange={(e) => updateLine(l.key, { responsiblePersonId: e.target.value })}>
                          <option value="">Unassigned</option>
                          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      </Field>
                      <Field label="Target Date">
                        <input className="input" type="date" value={l.targetDate} onChange={(e) => updateLine(l.key, { targetDate: e.target.value })} />
                      </Field>

                      <div className="col-span-2">
                        <Field label="Issue / Observation">
                          <textarea className="input" rows={2} value={l.issue} onChange={(e) => updateLine(l.key, { issue: e.target.value })} />
                        </Field>
                      </div>
                      <div className="col-span-2">
                        <Field label="Office Discussion / Follow-up Note">
                          <textarea className="input" rows={2} value={l.discussionNote} onChange={(e) => updateLine(l.key, { discussionNote: e.target.value })} />
                        </Field>
                      </div>
                      <div className="col-span-2">
                        <Field label="Required Action">
                          <textarea className="input" rows={2} value={l.requiredAction} onChange={(e) => updateLine(l.key, { requiredAction: e.target.value })} />
                        </Field>
                      </div>
                      <Field label="Status">
                        <select className="input" value={l.status} onChange={(e) => updateLine(l.key, { status: e.target.value })}>
                          {IFU_STATUSES.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </Field>
                      <div className="col-span-2">
                        <Field label="Remarks">
                          <textarea className="input" rows={2} value={l.remarks} onChange={(e) => updateLine(l.key, { remarks: e.target.value })} />
                        </Field>
                      </div>
                    </div>
                    {l.equipmentStatus && (
                      <div className="mt-2"><span className={equipmentStatusPill(l.equipmentStatus)}>{l.equipmentStatus}</span> <span className={priorityPill(l.priority)}>{l.priority}</span> <span className={followupStatusPill(l.status)}>{l.status}</span></div>
                    )}
                  </div>
                );
              })}
              {rigEquipment.length === 0 && <Empty message="This rig has no active equipment in Equipment Master yet." />}
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button className="btn-ghost" onClick={() => navigate('/admin/followup')}>Cancel</button>
              <button className="btn-primary" onClick={() => void saveLines()} disabled={busy}>Save Follow-up</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
