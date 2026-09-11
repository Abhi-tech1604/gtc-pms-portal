import { useEffect, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { UserCheck, UserCog } from 'lucide-react';
import { api } from '../../lib/api';
import type { DrrRigResponsibility, DrrResponsibilityRoleType, DrrResponsibilityTier, Rig, User } from '../../lib/types';
import { ErrorBox, Field, InfoBox, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';

const SLOTS: { roleType: DrrResponsibilityRoleType; tier: DrrResponsibilityTier; label: string }[] = [
  { roleType: 'Storekeeper', tier: 'Primary', label: 'Primary Storekeeper' },
  { roleType: 'Storekeeper', tier: 'Backup', label: 'Backup Storekeeper' },
  { roleType: 'OperationalManager', tier: 'Primary', label: 'Primary Operational Manager' },
  { roleType: 'OperationalManager', tier: 'Backup', label: 'Backup Operational Manager' },
];

/**
 * Admin > DRR > Rig Responsibility. Rig -> (Primary + Backup Storekeeper,
 * Primary + Backup Operational Manager) — the mapping the DRR approval
 * workflow routes on: submitting a report finds its rig's Operational
 * Manager(s) from here, and only they (or Admin) can approve/reject it. One
 * person can hold a slot on many rigs; a slot is exactly one person, never
 * left to a single global assignment.
 */
export default function DrrRigResponsibility() {
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [rigId, setRigId] = useState('');
  const [assignments, setAssignments] = useState<DrrRigResponsibility[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ roleType: DrrResponsibilityRoleType; tier: DrrResponsibilityTier; label: string; current: DrrRigResponsibility | null } | null>(null);
  const [pickedUserId, setPickedUserId] = useState('');
  const [busy, run] = useBusy();

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs.filter((r) => r.status === 'Active'))).catch((e) => setError((e as Error).message));
    api.get<{ users: User[] }>('/users').then((d) => setUsers(d.users.filter((u) => u.status === 'Active'))).catch(() => {});
  }, []);

  async function loadAssignments() {
    if (!rigId) { setAssignments(null); return; }
    setAssignments((await api.get<{ assignments: DrrRigResponsibility[] }>(`/drr/rig-responsibility?rigId=${rigId}`)).assignments);
  }

  useEffect(() => { loadAssignments().catch((e) => setError((e as Error).message)); }, [rigId]);

  function openSlot(slot: typeof SLOTS[number]) {
    const current = (assignments ?? []).find((a) => a.roleType === slot.roleType && a.tier === slot.tier) ?? null;
    setEditing({ ...slot, current });
    setPickedUserId(current?.userId ?? '');
  }

  async function save() {
    if (!editing || !rigId || !pickedUserId) return;
    setError('');
    try {
      await run(async () => {
        await api.post('/drr/rig-responsibility', {
          rigId, roleType: editing.roleType, tier: editing.tier, userId: pickedUserId,
        });
        await loadAssignments();
      });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function unassign() {
    if (!editing?.current) return;
    setError('');
    try {
      await run(async () => { await api.del(`/drr/rig-responsibility/${editing.current!.id}`); await loadAssignments(); });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  const selectedRig = rigs.find((r) => r.id === rigId) ?? null;
  const slotFor = (roleType: DrrResponsibilityRoleType, tier: DrrResponsibilityTier) =>
    (assignments ?? []).find((a) => a.roleType === roleType && a.tier === tier) ?? null;

  return (
    <div>
      <PageHeader
        title="Rig Responsibility"
        subtitle="Which Storekeeper(s) and Operational Manager(s) are responsible for each rig — the DRR approval workflow routes automatically from this."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <InfoBox>
        A Storekeeper submits a rig's Daily Rig Reports for approval; only that rig's assigned Operational
        Manager (Primary or Backup) can approve or reject them. One person can be responsible for several rigs —
        assign a Primary and, optionally, a Backup for each role, per rig.
      </InfoBox>

      <div className="card p-4 mb-5">
        <Field label="Select Rig">
          <select className="input max-w-sm" value={rigId} onChange={(e) => setRigId(e.target.value)}>
            <option value="">Choose a rig...</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
      </div>

      {rigId && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">{selectedRig ? rigLabel(selectedRig) : ''} — Assignments</h3>
          {!assignments ? <Spinner /> : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(['Storekeeper', 'OperationalManager'] as const).map((roleType) => (
                <div key={roleType} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                    {roleType === 'Storekeeper' ? <UserCheck size={14} /> : <UserCog size={14} />}
                    {roleType === 'Storekeeper' ? 'Storekeeper' : 'Operational Manager'}
                  </div>
                  {(['Primary', 'Backup'] as const).map((tier) => {
                    const assigned = slotFor(roleType, tier);
                    const slot = SLOTS.find((s) => s.roleType === roleType && s.tier === tier)!;
                    return (
                      <div key={tier} className="flex items-center justify-between py-1.5 border-t border-slate-100 first:border-t-0">
                        <div>
                          <div className="text-[11px] text-slate-500">{tier}</div>
                          <div className="text-sm font-medium text-slate-800">{assigned ? assigned.userName : 'Unassigned'}</div>
                        </div>
                        <button className="btn-ghost btn-sm" onClick={() => openSlot(slot)}>{assigned ? 'Change' : 'Assign'}</button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Modal open={!!editing} title={editing ? `${editing.label} — ${selectedRig ? rigLabel(selectedRig) : ''}` : ''} onClose={() => setEditing(null)}>
        {editing && (
          <>
            <Field label="User">
              <select className="input" value={pickedUserId} onChange={(e) => setPickedUserId(e.target.value)}>
                <option value="">Choose a user...</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.username})</option>)}
              </select>
            </Field>
            <div className="flex justify-between gap-2 pt-4">
              {editing.current
                ? <button className="btn-ghost text-red-700" onClick={() => void unassign()} disabled={busy}>Unassign</button>
                : <span />}
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                <button className="btn-primary" onClick={() => void save()} disabled={busy || !pickedUserId}>Save</button>
              </div>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
