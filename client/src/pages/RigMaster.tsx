import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileUp, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api, ApiError, download } from '../lib/api';
import { count, date } from '../lib/format';
import type { Rig } from '../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, InfoBox, Modal, PageHeader, Spinner, useBusy } from '../components/ui';
import { useAuth } from '../lib/auth';

const STATUSES = ['Active', 'Idle', 'Maintenance'];
const TYPES = ['Workover', 'Drilling'];
const CLIENT_PRESETS = ['ONGC', 'OIL'];
const REMARKS_OPTIONS = ['On Going Project', 'Rig Under Commissioning', 'Project will start further'];

export default function RigMaster() {
  const { can } = useAuth();
  const [rigs, setRigs] = useState<Rig[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Partial<Rig> | null>(null);
  const [deleting, setDeleting] = useState<Rig | null>(null);
  const [deleteWarning, setDeleteWarning] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [busy, run] = useBusy();
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    const rigData = await api.get<{ rigs: Rig[] }>('/rigs');
    setRigs(rigData.rigs);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function save() {
    if (!editing) return;
    setError('');
    if (!editing.name?.trim()) { setError('Rig Name is required.'); return; }
    if (!editing.rigType?.trim()) { setError('Type is required.'); return; }
    if (!editing.client?.trim()) { setError('Client is required.'); return; }
    if (editing.startDate && editing.completionDate && editing.completionDate < editing.startDate) {
      setError('Completion Date cannot be before Start Date.');
      return;
    }
    try {
      await run(async () => {
        if (editing.id) await api.put(`/rigs/${editing.id}`, editing);
        else await api.post('/rigs', editing);
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
        await api.del(`/rigs/${deleting.id}${cascade ? '?cascade=true' : ''}`);
        await load();
      });
      setDeleting(null);
      setDeleteWarning('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // The rig still has data; the message names exactly what would go.
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
        api.form<{ created: number; updated: number; skipped: { row: number; reason: string }[] }>('/rigs/import', form));
      await load();
      const summary = `${result.created} new rig(s) created, ${result.updated} existing rig(s) updated.`;
      setError(result.skipped.length
        ? `${summary} Skipped:\n${result.skipped.map((s) => `Row ${s.row}: ${s.reason}`).join('\n')}`
        : summary);
    } catch (e) { setError((e as Error).message); }
  }

  const filtered = useMemo(() => {
    if (!rigs) return [];
    const needle = search.trim().toLowerCase();
    return rigs.filter((r) =>
      (!statusFilter || r.status === statusFilter) &&
      (!needle || [r.name, r.location, r.client].filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))),
    );
  }, [rigs, search, statusFilter]);

  if (!rigs) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Rig Master"
        subtitle={`${count(filtered.length)} of ${count(rigs.length)} rig(s).`}
        actions={can('canManageRigs') && (
          <>
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }}
            />
            <button className="btn-ghost" onClick={() => void download('/rigs/template/download', 'Rig_Master_Template.xlsx')}>
              <Download size={14} /> Template
            </button>
            <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
              <FileUp size={14} /> Bulk import
            </button>
            <button className="btn-primary" onClick={() => setEditing({ status: 'Active', rigType: 'Drilling' })}>
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
            className="input pl-8" placeholder="Search rig name, location, client..."
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
              <th>Rig Name</th>
              <th>Type</th>
              <th>Client</th>
              <th>Location</th>
              <th>Start Date</th>
              <th>Completion Date</th>
              <th>Remarks</th>
              <th>Coordinator</th>
              <th>Status</th>
              <th className="text-right">Machines</th>
              <th>Last Reported</th>
              {can('canManageRigs') && <th />}
            </tr>
          </thead>
          <tbody>
            {filtered.map((rig) => (
              <tr key={rig.id}>
                <td className="font-medium text-slate-800 whitespace-nowrap">{rig.name}</td>
                <td>{rig.rigType ?? '-'}</td>
                <td>{rig.client ?? '-'}</td>
                <td>{rig.location ?? '-'}</td>
                <td className="whitespace-nowrap">{rig.startDate ? date(rig.startDate) : '-'}</td>
                <td className="whitespace-nowrap">{rig.completionDate ? date(rig.completionDate) : '-'}</td>
                <td>{rig.remarksStatus ?? '-'}</td>
                <td>{rig.projectCoordinator ?? '-'}</td>
                <td>{rig.status}</td>
                <td className="num">{count(rig.equipmentCount)}</td>
                <td className="whitespace-nowrap">{date(rig.lastReportedDate)}</td>
                {can('canManageRigs') && (
                  <td className="whitespace-nowrap text-right">
                    <button className="btn-ghost btn-sm mr-1" onClick={() => setEditing(rig)}>
                      <Pencil size={12} /> Edit
                    </button>
                    <button className="btn-ghost btn-sm text-red-700" onClick={() => { setDeleting(rig); setDeleteWarning(''); }}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={12}><Empty message={rigs.length === 0 ? 'No rigs are registered yet.' : 'No rig matches these filters.'} /></td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal open={!!editing} title={editing?.id ? 'Edit rig' : 'New rig'} onClose={() => setEditing(null)}>
        {editing && (
          <div className="space-y-3">
            <InfoBox>
              The Rig Name is what uploaded workbooks are matched against, so it must be unique.
            </InfoBox>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Rig Name *">
                <input className="input" value={editing.name ?? ''}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label="Type *">
                <select className="input" value={editing.rigType ?? ''}
                  onChange={(e) => setEditing({ ...editing, rigType: e.target.value })}>
                  <option value="">-</option>
                  {TYPES.map((t) => <option key={t}>{t}</option>)}
                  {editing.rigType && !TYPES.includes(editing.rigType) && <option value={editing.rigType}>{editing.rigType}</option>}
                </select>
              </Field>
              <Field label="Status">
                <select className="input" value={editing.status ?? 'Active'}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Location">
                <input className="input" value={editing.location ?? ''}
                  onChange={(e) => setEditing({ ...editing, location: e.target.value })} />
              </Field>
              <Field label="Commission date">
                <input className="input" type="date" value={editing.commissionDate ?? ''}
                  onChange={(e) => setEditing({ ...editing, commissionDate: e.target.value })} />
              </Field>
              <Field label="Client *">
                <select
                  className="input"
                  value={editing.client === 'ONGC' || editing.client === 'OIL' ? editing.client : 'Others'}
                  onChange={(e) => setEditing({ ...editing, client: e.target.value === 'Others' ? '' : e.target.value })}
                >
                  {CLIENT_PRESETS.map((c) => <option key={c}>{c}</option>)}
                  <option value="Others">Others</option>
                </select>
                {(editing.client === 'ONGC' || editing.client === 'OIL') ? null : (
                  <input
                    className="input mt-1" placeholder="Enter client name" value={editing.client ?? ''}
                    onChange={(e) => setEditing({ ...editing, client: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Start Date">
                <input className="input" type="date" value={editing.startDate ?? ''}
                  onChange={(e) => setEditing({ ...editing, startDate: e.target.value || null })} />
              </Field>
              <Field label="Completion Date" hint="Leave blank while the project is ongoing.">
                <input className="input" type="date" value={editing.completionDate ?? ''}
                  onChange={(e) => setEditing({ ...editing, completionDate: e.target.value || null })} />
              </Field>
              <Field label="Remarks">
                <select className="input" value={editing.remarksStatus ?? ''}
                  onChange={(e) => setEditing({ ...editing, remarksStatus: e.target.value || null })}>
                  <option value="">-</option>
                  {REMARKS_OPTIONS.map((r) => <option key={r}>{r}</option>)}
                  {editing.remarksStatus && !REMARKS_OPTIONS.includes(editing.remarksStatus) && (
                    <option value={editing.remarksStatus}>{editing.remarksStatus}</option>
                  )}
                </select>
              </Field>
              <Field label="Project Coordinator Name">
                <input className="input" value={editing.projectCoordinator ?? ''}
                  onChange={(e) => setEditing({ ...editing, projectCoordinator: e.target.value })} />
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
        title={`Delete ${deleting?.name ?? ''}?`}
        busy={busy}
        confirmLabel={deleteWarning ? 'Delete the rig and all its data' : 'Delete rig'}
        body={
          deleteWarning
            ? <div className="text-red-800 whitespace-pre-wrap">{deleteWarning}</div>
            : <div>
                {deleting?.name} will be removed. This cannot be undone.
              </div>
        }
        onConfirm={() => void confirmDelete(!!deleteWarning)}
        onCancel={() => { setDeleting(null); setDeleteWarning(''); }}
      />
    </div>
  );
}
