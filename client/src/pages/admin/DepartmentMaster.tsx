import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { MODULE_CODES, MODULE_LABELS } from '../../lib/types';
import type { Department } from '../../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';

const STATUSES = ['Active', 'Inactive'];

/**
 * Module -> Department -> User -> (future) rig-wise rights. A department is
 * created by picking its module first, then naming it — the same name may
 * exist under two different modules (they're genuinely different
 * departments) but not twice within the same one.
 */
export default function DepartmentMaster() {
  const [items, setItems] = useState<Department[] | null>(null);
  const [editing, setEditing] = useState<Partial<Department> | null>(null);
  const [deleting, setDeleting] = useState<Department | null>(null);
  const [deleteWarning, setDeleteWarning] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  async function load() {
    setItems((await api.get<{ departments: Department[] }>('/admin/departments')).departments);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function save() {
    if (!editing) return;
    setError('');
    try {
      await run(async () => {
        if (editing.id) await api.put(`/admin/departments/${editing.id}`, editing);
        else await api.post('/admin/departments', editing);
        await load();
      });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/admin/departments/${deleting.id}`); await load(); });
      setDeleting(null);
      setDeleteWarning('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setDeleteWarning(e.message); return; }
      setError((e as Error).message);
      setDeleting(null);
    }
  }

  if (!items) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Department Master"
        subtitle="Module → Department → User — every department belongs to exactly one module."
        actions={<button className="btn-primary" onClick={() => setEditing({ moduleCode: 'PMS', status: 'Active' })}><Plus size={14} /> New department</button>}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr><th>Module</th><th>Department</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id}>
                <td><span className="pill-engine">{MODULE_LABELS[d.moduleCode] ?? d.moduleCode}</span></td>
                <td className="font-medium">{d.name}</td>
                <td>{d.status}</td>
                <td className="text-right whitespace-nowrap">
                  <button className="btn-ghost btn-sm mr-1" onClick={() => setEditing(d)}><Pencil size={12} /></button>
                  <button className="btn-ghost btn-sm text-red-700" onClick={() => { setDeleting(d); setDeleteWarning(''); }}><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4}><Empty message="No departments created yet." /></td></tr>}
          </tbody>
        </table>
      </div>

      <Modal open={!!editing} title={editing?.id ? 'Edit department' : 'New department'} onClose={() => setEditing(null)}>
        {editing && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Module">
                <select className="input" value={editing.moduleCode ?? 'PMS'} disabled={!!editing.id}
                  onChange={(e) => setEditing({ ...editing, moduleCode: e.target.value as Department['moduleCode'] })}>
                  {MODULE_CODES.map((code) => <option key={code} value={code}>{MODULE_LABELS[code]}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <select className="input" value={editing.status ?? 'Active'}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <div className="col-span-2">
                <Field label="Department name">
                  <input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
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

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title={`Delete ${deleting?.name ?? ''}?`}
        confirmLabel="Delete department"
        busy={busy}
        body={
          deleteWarning
            ? <div className="text-red-800 whitespace-pre-wrap">{deleteWarning}</div>
            : <p>This department will be removed. Users must be reassigned first.</p>
        }
        onConfirm={() => void remove()}
        onCancel={() => { setDeleting(null); setDeleteWarning(''); }}
      />
    </div>
  );
}
