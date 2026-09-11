import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { rigLabel } from '../../lib/rig';
import { Download, FileUp, Pencil, Plus, Ruler, Search, Trash2 } from 'lucide-react';
import { api, ApiError, download } from '../../lib/api';
import { count } from '../../lib/format';
import type { IlmRig } from '../../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, InfoBox, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';

const STATUSES = ['Active', 'Idle', 'Maintenance'];

/**
 * ILM's own independent Rig Master — a rig here is a completely separate
 * record from a PMS rig or a DPR rig, even if they share a name/number.
 * Adding, editing or deleting a rig here never touches PMS's or DPR's data.
 */
export default function IlmRigMaster() {
  const [rigs, setRigs] = useState<IlmRig[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Partial<IlmRig> | null>(null);
  const [deleting, setDeleting] = useState<IlmRig | null>(null);
  const [deleteWarning, setDeleteWarning] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [busy, run] = useBusy();
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    const data = await api.get<{ rigs: IlmRig[] }>('/ilm/rigs');
    setRigs(data.rigs);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function save() {
    if (!editing) return;
    setError('');
    try {
      await run(async () => {
        if (editing.id) await api.put(`/ilm/rigs/${editing.id}`, editing);
        else await api.post('/ilm/rigs', editing);
        await load();
      });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function confirmDelete(cascade: boolean) {
    if (!deleting) return;
    setError('');
    try {
      await run(async () => {
        await api.del(`/ilm/rigs/${deleting.id}${cascade ? '?cascade=true' : ''}`);
        await load();
      });
      setDeleting(null);
      setDeleteWarning('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setDeleteWarning(e.message);
        return;
      }
      setError((e as Error).message);
      setDeleting(null);
    }
  }

  async function importFile(file: File) {
    setError('');
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await run(() =>
        api.form<{ created: number; skipped: { row: number; reason: string }[] }>('/ilm/rigs/import', form));
      await load();
      if (result.skipped.length) {
        setError(`${result.created} rig(s) imported. Skipped:\n` +
          result.skipped.map((s) => `Row ${s.row}: ${s.reason}`).join('\n'));
      }
    } catch (e) { setError((e as Error).message); }
  }

  const filtered = useMemo(() => {
    if (!rigs) return [];
    const needle = search.trim().toLowerCase();
    return rigs.filter((r) =>
      (!statusFilter || r.status === statusFilter) &&
      (!needle || [r.rigNumber, r.name].some((v) => v.toLowerCase().includes(needle))),
    );
  }, [rigs, search, statusFilter]);

  if (!rigs) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="ILM Rig Master"
        subtitle={`${count(filtered.length)} of ${count(rigs.length)} rig(s) — independent of PMS and DPR.`}
        actions={(
          <>
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }}
            />
            <button className="btn-ghost" onClick={() => void download('/ilm/rigs/template/download', 'ILM_Rig_Master_Template.xlsx')}>
              <Download size={14} /> Template
            </button>
            <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
              <FileUp size={14} /> Bulk import
            </button>
            <button className="btn-primary" onClick={() => setEditing({ status: 'Active' })}>
              <Plus size={14} /> New rig
            </button>
          </>
        )}
      />

      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="relative md:col-span-2">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            className="input pl-8" placeholder="Search rig number or name..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Rig Number</th>
              <th>Name</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((rig) => (
              <tr key={rig.id}>
                <td className="font-medium text-slate-800 whitespace-nowrap">{rig.rigNumber}</td>
                <td>{rig.name}</td>
                <td>{rig.status}</td>
                <td className="whitespace-nowrap text-right">
                  <Link className="btn-ghost btn-sm mr-1" to={`/admin/ilm-contract-duration-rules?ilmRigId=${rig.id}`} title="Contract Duration Rules">
                    <Ruler size={12} /> Rules
                  </Link>
                  <button className="btn-ghost btn-sm mr-1" onClick={() => setEditing(rig)}>
                    <Pencil size={12} /> Edit
                  </button>
                  <button className="btn-ghost btn-sm text-red-700" onClick={() => { setDeleting(rig); setDeleteWarning(''); }}>
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={4}><Empty message={rigs.length === 0 ? 'No ILM rigs are registered yet.' : 'No rig matches these filters.'} /></td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={!!editing} title={editing?.id ? 'Edit ILM rig' : 'New ILM rig'} onClose={() => setEditing(null)}>
        {editing && (
          <div className="space-y-3">
            <InfoBox>
              This rig exists only in ILM. It is a separate record from any PMS or DPR rig, even one with the same name.
            </InfoBox>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Rig number">
                <input className="input" value={editing.rigNumber ?? ''}
                  onChange={(e) => setEditing({ ...editing, rigNumber: e.target.value })} />
              </Field>
              <Field label="Display name">
                <input className="input" value={editing.name ?? ''}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label="Status">
                <select className="input" value={editing.status ?? 'Active'}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save</button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title={`Delete ${deleting?.rigNumber ?? ''}?`}
        busy={busy}
        confirmLabel={deleteWarning ? 'Delete the rig and all its data' : 'Delete rig'}
        body={
          deleteWarning
            ? <div className="text-red-800 whitespace-pre-wrap">{deleteWarning}</div>
            : <div>{rigLabel(deleting)} will be removed. This cannot be undone.</div>
        }
        onConfirm={() => void confirmDelete(!!deleteWarning)}
        onCancel={() => { setDeleting(null); setDeleteWarning(''); }}
      />
    </div>
  );
}
