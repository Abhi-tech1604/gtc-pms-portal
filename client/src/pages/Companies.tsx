import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { count } from '../lib/format';
import { ConfirmDialog, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, useBusy } from '../components/ui';
import { useAuth } from '../lib/auth';

interface Company {
  id: string; name: string; code: string | null; gstNumber: string | null; pan: string | null;
  contactPerson: string | null; email: string | null; phone: string | null; rigCount?: number;
}

export default function Companies() {
  const { can } = useAuth();
  const [items, setItems] = useState<Company[] | null>(null);
  const [editing, setEditing] = useState<Partial<Company> | null>(null);
  const [deleting, setDeleting] = useState<Company | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  async function load() {
    setItems((await api.get<{ companies: Company[] }>('/companies')).companies);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function save() {
    if (!editing) return;
    setError('');
    try {
      await run(async () => {
        if (editing.id) await api.put(`/companies/${editing.id}`, editing);
        else await api.post('/companies', editing);
        await load();
      });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/companies/${deleting.id}`); await load(); });
      setDeleting(null);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  if (!items) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Companies"
        subtitle="Operating companies that own rigs."
        actions={can('canManageRigs') && (
          <button className="btn-primary" onClick={() => setEditing({})}><Plus size={14} /> New company</button>
        )}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Code</th><th>GST</th><th>PAN</th><th>Contact</th><th>Email</th><th>Phone</th><th className="text-right">Rigs</th><th /></tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name}</td>
                <td>{c.code ?? '-'}</td>
                <td className="text-xs">{c.gstNumber ?? '-'}</td>
                <td className="text-xs">{c.pan ?? '-'}</td>
                <td>{c.contactPerson ?? '-'}</td>
                <td className="text-xs">{c.email ?? '-'}</td>
                <td className="text-xs">{c.phone ?? '-'}</td>
                <td className="num">{count(c.rigCount)}</td>
                {can('canManageRigs') && (
                  <td className="text-right whitespace-nowrap">
                    <button className="btn-ghost btn-sm mr-1" onClick={() => setEditing(c)}><Pencil size={12} /></button>
                    <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(c)}><Trash2 size={12} /></button>
                  </td>
                )}
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={9}><Empty message="No companies registered." /></td></tr>}
          </tbody>
        </table>
      </div>

      <Modal open={!!editing} title={editing?.id ? 'Edit company' : 'New company'} onClose={() => setEditing(null)}>
        {editing && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name"><input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Code"><input className="input" value={editing.code ?? ''} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="GST number"><input className="input" value={editing.gstNumber ?? ''} onChange={(e) => setEditing({ ...editing, gstNumber: e.target.value })} /></Field>
              <Field label="PAN"><input className="input" value={editing.pan ?? ''} onChange={(e) => setEditing({ ...editing, pan: e.target.value })} /></Field>
              <Field label="Contact person"><input className="input" value={editing.contactPerson ?? ''} onChange={(e) => setEditing({ ...editing, contactPerson: e.target.value })} /></Field>
              <Field label="Email"><input className="input" value={editing.email ?? ''} onChange={(e) => setEditing({ ...editing, email: e.target.value })} /></Field>
              <Field label="Phone"><input className="input" value={editing.phone ?? ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} /></Field>
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
        confirmLabel="Delete company"
        busy={busy}
        body={<p>This company will be removed. Rigs must be reassigned first.</p>}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
