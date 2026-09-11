import { useEffect, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { Pencil, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { date } from '../../lib/format';
import type { Employee, ManpowerRosterEntry, Rig } from '../../lib/types';
import { Empty, ErrorBox, Field, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';

const STATUSES = ['Active', 'Inactive'];
const SHIFT_OPTIONS = ['Day', 'Night', '24 Hour'];
const ROTATION_PRESETS: { label: string; onDays: number | null; offDays: number | null }[] = [
  { label: '4 ON / 6 OFF', onDays: 4, offDays: 6 },
  { label: '6 ON / 4 OFF', onDays: 6, offDays: 4 },
  { label: '14 ON / 14 OFF', onDays: 14, offDays: 14 },
  { label: '28 ON / 28 OFF', onDays: 28, offDays: 28 },
  { label: 'Custom', onDays: null, offDays: null },
];

/**
 * Manpower Roster: a global Employee Master (same tier as Oil & Lubricant
 * Master's global list) plus a rig-scoped Roster Assignments panel below it
 * (Employee -> Rig ON/OFF rotation) — mirrors OilLubricantMaster.tsx's
 * two-tier layout exactly.
 */
export default function ManpowerRoster() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [editingEmployee, setEditingEmployee] = useState<Partial<Employee> | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  const [rigs, setRigs] = useState<Rig[]>([]);
  const [rigId, setRigId] = useState('');
  const [roster, setRoster] = useState<ManpowerRosterEntry[] | null>(null);
  const [editingRoster, setEditingRoster] = useState<Partial<ManpowerRosterEntry> & { rotationLabel?: string } | null>(null);
  const [rosterBusy, runRoster] = useBusy();

  async function loadEmployees() {
    setEmployees((await api.get<{ employees: Employee[] }>('/employees')).employees);
  }

  useEffect(() => {
    loadEmployees().catch((e) => setError((e as Error).message));
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs.filter((r) => r.status === 'Active'))).catch(() => {});
  }, []);

  async function loadRoster() {
    if (!rigId) { setRoster(null); return; }
    setRoster((await api.get<{ roster: ManpowerRosterEntry[] }>(`/manpower-roster?rigId=${rigId}`)).roster);
  }

  useEffect(() => { loadRoster().catch((e) => setError((e as Error).message)); }, [rigId]);

  async function saveEmployee() {
    if (!editingEmployee) return;
    setError('');
    try {
      await run(async () => {
        if (editingEmployee.id) await api.put(`/employees/${editingEmployee.id}`, editingEmployee);
        else await api.post('/employees', editingEmployee);
        await loadEmployees();
      });
      setEditingEmployee(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function saveRoster() {
    if (!editingRoster || !rigId) return;
    setError('');
    try {
      await runRoster(async () => {
        const body = { ...editingRoster, rigId, rotationType: editingRoster.rotationLabel };
        if (editingRoster.id) await api.put(`/manpower-roster/${editingRoster.id}`, body);
        else await api.post('/manpower-roster', body);
        await loadRoster();
      });
      setEditingRoster(null);
    } catch (e) { setError((e as Error).message); }
  }

  const activeEmployees = (employees ?? []).filter((e) => e.status === 'Active');

  if (!employees) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Manpower Roster"
        subtitle="Employee Master and per-rig rotation assignments — DRR's Site Attendance reads this live to show who's scheduled each day."
        actions={<button className="btn-primary" onClick={() => setEditingEmployee({ status: 'Active' })}><Plus size={14} /> New Employee</button>}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card overflow-x-auto mb-5">
        <table className="table">
          <thead><tr><th>Name</th><th>Employee Code</th><th>Default Designation</th><th>Status</th><th /></tr></thead>
          <tbody>
            {employees.map((emp) => (
              <tr key={emp.id}>
                <td className="font-medium">{emp.name}</td>
                <td>{emp.employeeCode ?? '-'}</td>
                <td>{emp.defaultDesignation ?? '-'}</td>
                <td>{emp.status}</td>
                <td className="text-right whitespace-nowrap">
                  <button className="btn-ghost btn-sm" onClick={() => setEditingEmployee(emp)}><Pencil size={12} /></button>
                </td>
              </tr>
            ))}
            {employees.length === 0 && <tr><td colSpan={5}><Empty message="No employees created yet." /></td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card p-4 mb-5">
        <Field label="Select Rig">
          <select className="input max-w-sm" value={rigId} onChange={(e) => setRigId(e.target.value)}>
            <option value="">Choose a rig...</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
      </div>

      {rigId && (
        <div className="card p-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-800">Roster Assignments</h3>
            <button
              className="btn-primary btn-sm" disabled={activeEmployees.length === 0}
              onClick={() => setEditingRoster({ status: 'Active', shift: 'Day', rotationLabel: '4 ON / 6 OFF', onDays: 4, offDays: 6 })}
            >
              <Plus size={14} /> Add Assignment
            </button>
          </div>
          {!roster ? <Spinner /> : (
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th>Employee</th><th>Designation</th><th>Rotation</th><th className="text-right">ON</th><th className="text-right">OFF</th>
                    <th>Start Date</th><th>Shift</th><th>Effective From</th><th>Effective To</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {roster.map((r) => (
                    <tr key={r.id}>
                      <td className="font-medium whitespace-nowrap">{r.employeeName}</td>
                      <td>{r.designation}</td>
                      <td>{r.rotationType}</td>
                      <td className="num">{r.onDays}</td>
                      <td className="num">{r.offDays}</td>
                      <td className="whitespace-nowrap">{date(r.rotationStartDate)}</td>
                      <td>{r.shift}</td>
                      <td className="whitespace-nowrap">{date(r.effectiveFrom)}</td>
                      <td className="whitespace-nowrap">{r.effectiveTo ? date(r.effectiveTo) : '-'}</td>
                      <td><span className={r.status === 'Active' ? 'pill-normal' : 'pill-place'}>{r.status}</span></td>
                      <td className="text-right">
                        <button className="btn-ghost btn-sm" onClick={() => setEditingRoster({ ...r, rotationLabel: r.rotationType })}><Pencil size={12} /></button>
                      </td>
                    </tr>
                  ))}
                  {roster.length === 0 && <tr><td colSpan={11}><Empty message="No roster assignments for this rig yet." /></td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <Modal open={!!editingEmployee} title={editingEmployee?.id ? 'Edit employee' : 'New employee'} onClose={() => setEditingEmployee(null)}>
        {editingEmployee && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Field label="Name">
                  <input className="input" value={editingEmployee.name ?? ''} onChange={(e) => setEditingEmployee({ ...editingEmployee, name: e.target.value })} />
                </Field>
              </div>
              <Field label="Employee Code" hint="Optional">
                <input className="input" value={editingEmployee.employeeCode ?? ''} onChange={(e) => setEditingEmployee({ ...editingEmployee, employeeCode: e.target.value || null })} />
              </Field>
              <Field label="Default Designation" hint="Optional">
                <input className="input" value={editingEmployee.defaultDesignation ?? ''} onChange={(e) => setEditingEmployee({ ...editingEmployee, defaultDesignation: e.target.value || null })} />
              </Field>
              <Field label="Status">
                <select className="input" value={editingEmployee.status ?? 'Active'} onChange={(e) => setEditingEmployee({ ...editingEmployee, status: e.target.value as Employee['status'] })}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button className="btn-ghost" onClick={() => setEditingEmployee(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => void saveEmployee()} disabled={busy}>Save</button>
            </div>
          </>
        )}
      </Modal>

      <Modal open={!!editingRoster} title={editingRoster?.id ? 'Edit roster assignment' : 'Add roster assignment'} onClose={() => setEditingRoster(null)}>
        {editingRoster && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Field label="Employee">
                  <select className="input" value={editingRoster.employeeId ?? ''} onChange={(e) => setEditingRoster({ ...editingRoster, employeeId: e.target.value })}>
                    <option value="">Choose from Employee Master...</option>
                    {activeEmployees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Designation / Position">
                <input className="input" value={editingRoster.designation ?? ''} onChange={(e) => setEditingRoster({ ...editingRoster, designation: e.target.value })} />
              </Field>
              <Field label="Shift">
                <select className="input" value={editingRoster.shift ?? 'Day'} onChange={(e) => setEditingRoster({ ...editingRoster, shift: e.target.value })}>
                  {SHIFT_OPTIONS.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Rotation Type">
                <select
                  className="input" value={editingRoster.rotationLabel ?? 'Custom'}
                  onChange={(e) => {
                    const preset = ROTATION_PRESETS.find((p) => p.label === e.target.value);
                    setEditingRoster({
                      ...editingRoster, rotationLabel: e.target.value,
                      onDays: preset?.onDays ?? editingRoster.onDays, offDays: preset?.offDays ?? editingRoster.offDays,
                    });
                  }}
                >
                  {ROTATION_PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
                </select>
              </Field>
              <div />
              <Field label="ON Days">
                <input className="input" type="number" min={1} value={editingRoster.onDays ?? ''} onChange={(e) => setEditingRoster({ ...editingRoster, onDays: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="OFF Days">
                <input className="input" type="number" min={1} value={editingRoster.offDays ?? ''} onChange={(e) => setEditingRoster({ ...editingRoster, offDays: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="Rotation Start Date" hint="Anchor date the ON/OFF cycle is counted from">
                <input className="input" type="date" value={editingRoster.rotationStartDate ?? ''} onChange={(e) => setEditingRoster({ ...editingRoster, rotationStartDate: e.target.value })} />
              </Field>
              <Field label="Status">
                <select className="input" value={editingRoster.status ?? 'Active'} onChange={(e) => setEditingRoster({ ...editingRoster, status: e.target.value as ManpowerRosterEntry['status'] })}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Effective From">
                <input className="input" type="date" value={editingRoster.effectiveFrom ?? ''} onChange={(e) => setEditingRoster({ ...editingRoster, effectiveFrom: e.target.value })} />
              </Field>
              <Field label="Effective To" hint="Leave blank if ongoing">
                <input className="input" type="date" value={editingRoster.effectiveTo ?? ''} onChange={(e) => setEditingRoster({ ...editingRoster, effectiveTo: e.target.value || null })} />
              </Field>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button className="btn-ghost" onClick={() => setEditingRoster(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => void saveRoster()} disabled={rosterBusy}>Save</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
