import { useEffect, useState } from 'react';
import { Cog, Pencil, Plus, Wrench } from 'lucide-react';
import { api } from '../../lib/api';
import { count } from '../../lib/format';
import type { MaterialMasterRecord } from '../../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';

type MaterialTab = 'engine' | 'transmission';

/**
 * Material Master: the global Engine/Transmission catalog, independent of
 * any single rig — one record here can be linked from many Equipment Master
 * rows across every rig. Split out of Equipment Master into its own screen
 * so Equipment Master stays equipment-only.
 */
export default function MaterialMaster() {
  const [tab, setTab] = useState<MaterialTab>('engine');

  return (
    <div>
      <PageHeader
        title="Material Master"
        subtitle="Global Engine and Transmission specification records — linkable from any equipment, on any rig. Not tied to a single machine."
      />
      <div className="flex gap-2 mb-4">
        <button
          className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 ${tab === 'engine' ? 'bg-rig-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
          onClick={() => setTab('engine')}
        >
          <Cog size={14} /> Engine
        </button>
        <button
          className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 ${tab === 'transmission' ? 'bg-rig-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
          onClick={() => setTab('transmission')}
        >
          <Wrench size={14} /> Transmission
        </button>
      </div>
      {tab === 'engine' ? <MaterialTypeTab materialType="Engine" /> : <MaterialTypeTab materialType="Transmission" />}
    </div>
  );
}

type MaterialEditing = Partial<MaterialMasterRecord>;

function MaterialTypeTab({ materialType }: { materialType: 'Engine' | 'Transmission' }) {
  const [items, setItems] = useState<MaterialMasterRecord[] | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [makeFilter, setMakeFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [serialFilter, setSerialFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [editing, setEditing] = useState<MaterialEditing | null>(null);
  const [deactivating, setDeactivating] = useState<MaterialMasterRecord | null>(null);
  const [busy, run] = useBusy();

  async function reload() {
    // Every filter is applied by the database query, not to an already-loaded
    // page — so results always reflect current data, including derived Location.
    const q = new URLSearchParams({ materialType });
    if (statusFilter) q.set('status', statusFilter);
    if (search.trim()) q.set('search', search.trim());
    for (const [key, value] of [
      ['name', nameFilter], ['make', makeFilter], ['model', modelFilter],
      ['serialNumber', serialFilter], ['location', locationFilter],
    ] as const) {
      if (value.trim()) q.set(key, value.trim());
    }
    const d = await api.get<{ items: MaterialMasterRecord[] }>(`/material-master?${q}`);
    setItems(d.items);
  }

  useEffect(() => {
    setLoadError('');
    reload().catch((e) => setLoadError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialType, statusFilter, search, nameFilter, makeFilter, modelFilter, serialFilter, locationFilter]);

  async function save() {
    if (!editing) return;
    setSaveError('');
    if (!editing.name?.trim()) { setSaveError(`A ${materialType.toLowerCase()} name is required.`); return; }
    try {
      await run(async () => {
        const payload = {
          materialType,
          name: editing.name!.trim(),
          make: editing.make || null,
          model: editing.model || null,
          serialNumber: editing.serialNumber || null,
          status: editing.status === 'Inactive' ? 'Inactive' : 'Active',
          // Ignored server-side whenever the record is linked to equipment.
          manualLocation: editing.derivedLocation ? null : (editing.manualLocation?.trim() || null),
        };
        if (editing.id) await api.put(`/material-master/${editing.id}`, payload);
        else await api.post('/material-master', payload);
        await reload();
      });
      setEditing(null);
    } catch (e) { setSaveError((e as Error).message); }
  }

  async function deactivate() {
    if (!deactivating) return;
    try {
      await run(async () => {
        await api.put(`/material-master/${deactivating.id}`, { status: 'Inactive' });
        await reload();
      });
      setDeactivating(null);
    } catch (e) { setLoadError((e as Error).message); setDeactivating(null); }
  }

  return (
    <div>
      <ErrorBox message={loadError} onDismiss={() => setLoadError('')} />

      <div className="card p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div className="md:col-span-2">
            <Field label="Search">
              <input
                className="input" placeholder={`Search ${materialType.toLowerCase()} name, make, model, serial, location...`}
                value={search} onChange={(e) => setSearch(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Status">
            <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end mt-3">
          <Field label={`${materialType} Name`}>
            <input className="input" placeholder="Any name" value={nameFilter} onChange={(e) => setNameFilter(e.target.value)} />
          </Field>
          <Field label="Make">
            <input className="input" placeholder="Any make" value={makeFilter} onChange={(e) => setMakeFilter(e.target.value)} />
          </Field>
          <Field label="Model">
            <input className="input" placeholder="Any model" value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} />
          </Field>
          <Field label="Serial No.">
            <input className="input" placeholder="Any serial" value={serialFilter} onChange={(e) => setSerialFilter(e.target.value)} />
          </Field>
          <Field label="Location" hint="Rig name, or &quot;Not Assigned&quot;">
            <input className="input" placeholder="Any rig" value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} />
          </Field>
        </div>
        {(search || statusFilter || nameFilter || makeFilter || modelFilter || serialFilter || locationFilter) && (
          <button
            className="btn-ghost btn-sm mt-3"
            onClick={() => {
              setSearch(''); setStatusFilter(''); setNameFilter('');
              setMakeFilter(''); setModelFilter(''); setSerialFilter(''); setLocationFilter('');
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <PageHeader
        title={`${materialType} Master`}
        subtitle={items ? `${count(items.length)} record(s) — global, not tied to any rig.` : undefined}
        actions={
          <button className="btn-primary" onClick={() => setEditing({ materialType, status: 'Active' })}>
            <Plus size={14} /> Add New {materialType}
          </button>
        }
      />

      <div className="card overflow-x-auto">
        {!items ? (
          <Spinner label={`Loading ${materialType.toLowerCase()} records...`} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{materialType} Name</th>
                <th>Make</th>
                <th>Model</th>
                <th>Serial No.</th>
                <th>Status</th>
                <th>Location</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td className="font-medium text-slate-800">{m.name}</td>
                  <td>{m.make ?? '-'}</td>
                  <td>{m.model ?? '-'}</td>
                  <td className="text-xs">{m.serialNumber ?? '-'}</td>
                  <td>
                    <span className={m.status === 'Active' ? 'pill-normal' : 'pill-place'}>{m.status}</span>
                  </td>
                  <td>
                    {m.derivedLocation
                      ? <span className="pill-place">{m.derivedLocation}</span>
                      : m.manualLocation
                        ? <span className="text-slate-600" title="Recorded manually — not linked to any equipment">{m.manualLocation}</span>
                        : <span className="text-slate-400">Not Assigned</span>}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <button className="btn-ghost btn-sm mr-1" onClick={() => setEditing(m)}>
                      <Pencil size={12} /> Edit
                    </button>
                    {m.status === 'Active' && (
                      <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeactivating(m)}>
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <Empty message={`No ${materialType.toLowerCase()} records yet — use "Add New ${materialType}" to create one.`} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={!!editing} title={editing?.id ? `Edit ${materialType.toLowerCase()}` : `Add New ${materialType}`} onClose={() => setEditing(null)}>
        {editing && (
          <div className="space-y-3">
            <ErrorBox message={saveError} onDismiss={() => setSaveError('')} />
            <Field label={`${materialType} Name`} hint="e.g. Carrier engine, Mud pump engine, DG Set - 1 (125 KVA)">
              <input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Make">
                <input className="input" value={editing.make ?? ''} onChange={(e) => setEditing({ ...editing, make: e.target.value })} />
              </Field>
              <Field label="Model">
                <input className="input" value={editing.model ?? ''} onChange={(e) => setEditing({ ...editing, model: e.target.value })} />
              </Field>
              <Field label="Serial No.">
                <input className="input" value={editing.serialNumber ?? ''} onChange={(e) => setEditing({ ...editing, serialNumber: e.target.value })} />
              </Field>
              <Field label="Status">
                <select
                  className="input" value={editing.status === 'Inactive' ? 'Inactive' : 'Active'}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value as 'Active' | 'Inactive' })}
                >
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </Field>
            </div>
            {/*
              While this record is fitted to equipment, its rig IS its location —
              typing something else could only ever be wrong, so the field is
              read-only and changes by linking/transferring that equipment in
              Equipment Master. Unassigned (a spare in a yard), there is nothing
              to derive from, so Admin can record where it actually is.
            */}
            {editing.derivedLocation ? (
              <Field label="Location" hint="From the rig of the equipment this record is linked to. To change it, link or transfer that equipment in Equipment Master.">
                <input className="input bg-slate-50 text-slate-600" readOnly value={editing.derivedLocation} />
              </Field>
            ) : (
              <Field label="Location" hint='Not linked to any equipment, so you can record where it is (e.g. "Bakrol Yard"). Once linked to equipment, the rig takes over automatically.'>
                <input
                  className="input" placeholder="Not Assigned"
                  value={editing.manualLocation ?? ''}
                  onChange={(e) => setEditing({ ...editing, manualLocation: e.target.value })}
                />
              </Field>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save</button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deactivating}
        tone="danger"
        title={`Deactivate ${deactivating?.name ?? ''}?`}
        confirmLabel="Deactivate"
        busy={busy}
        body={<p>Equipment already linked to this record keeps the link — it just won't be offered for new links while inactive.</p>}
        onConfirm={() => void deactivate()}
        onCancel={() => setDeactivating(null)}
      />
    </div>
  );
}
