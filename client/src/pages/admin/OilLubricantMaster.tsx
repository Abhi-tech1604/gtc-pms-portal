import { useEffect, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import type { Equipment, EquipmentOilMapping, OilLubricant, Rig } from '../../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';

const STATUSES = ['Active', 'Inactive'];

/** A simple named reference list (e.g. "Engine Oil 15W40"), shared by every module. */
export default function OilLubricantMaster() {
  const [items, setItems] = useState<OilLubricant[] | null>(null);
  /** Every machine in Equipment Master — the only source the Add/Edit form offers. */
  const [allEquipment, setAllEquipment] = useState<Equipment[]>([]);
  const [editing, setEditing] = useState<Partial<OilLubricant> | null>(null);
  /** Equipment ids assigned to the record being edited, as picked in the form. */
  const [editEquipmentIds, setEditEquipmentIds] = useState<string[]>([]);
  const [editRigId, setEditRigId] = useState('');
  const [deleting, setDeleting] = useState<OilLubricant | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  const [rigs, setRigs] = useState<Rig[]>([]);
  const [rigId, setRigId] = useState('');
  const [equipmentOptions, setEquipmentOptions] = useState<Equipment[]>([]);
  const [equipmentId, setEquipmentId] = useState('');
  const [mappings, setMappings] = useState<EquipmentOilMapping[] | null>(null);
  const [addOilId, setAddOilId] = useState('');
  const [mappingBusy, runMapping] = useBusy();

  async function load() {
    setItems((await api.get<{ oilLubricants: OilLubricant[] }>('/admin/oil-lubricants')).oilLubricants);
  }

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
    // Admin is unrestricted, so this returns every rig's equipment. The form
    // assigns oils to these real records by id — never to a typed-in name.
    api.get<{ equipment: Equipment[] }>('/equipment')
      .then((d) => setAllEquipment(d.equipment.filter((e) => e.isActive)))
      .catch(() => {});
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs.filter((r) => r.status === 'Active'))).catch(() => {});
  }, []);

  useEffect(() => {
    setEquipmentId('');
    setEquipmentOptions([]);
    if (!rigId) return;
    api.get<{ equipment: Equipment[] }>(`/equipment?rigId=${rigId}`)
      .then((d) => setEquipmentOptions(d.equipment.filter((e) => e.isActive)))
      .catch((e) => setError((e as Error).message));
  }, [rigId]);

  async function loadMappings() {
    if (!equipmentId) { setMappings(null); return; }
    setMappings((await api.get<{ mappings: EquipmentOilMapping[] }>(`/equipment-oil-lubricants?equipmentId=${equipmentId}`)).mappings);
  }

  useEffect(() => {
    loadMappings().catch((e) => setError((e as Error).message));
  }, [equipmentId]);

  async function addMapping() {
    if (!equipmentId || !addOilId) return;
    setError('');
    try {
      await runMapping(async () => {
        await api.post('/equipment-oil-lubricants', { equipmentId, oilLubricantId: addOilId });
        await loadMappings();
        await load(); // keep the list's derived "Used By" column in step
      });
      setAddOilId('');
    } catch (e) { setError((e as Error).message); }
  }

  async function removeMapping(mappingId: string) {
    setError('');
    try {
      await runMapping(async () => { await api.del(`/equipment-oil-lubricants/${mappingId}`); await loadMappings(); await load(); });
    } catch (e) { setError((e as Error).message); }
  }

  /** Opens the form with this record's CURRENT equipment assignments pre-selected. */
  function openEditor(oil: Partial<OilLubricant> | null) {
    setEditing(oil ?? { status: 'Active' });
    setEditEquipmentIds((oil?.usage ?? []).map((u) => u.equipmentId));
    setEditRigId('');
  }

  async function save() {
    if (!editing) return;
    setError('');
    try {
      await run(async () => {
        // equipmentIds is the full intended assignment list; the server
        // reconciles it against the existing mappings, so re-saving an
        // unchanged record can't create a duplicate.
        const payload = { ...editing, equipmentIds: editEquipmentIds };
        if (editing.id) await api.put(`/admin/oil-lubricants/${editing.id}`, payload);
        else await api.post('/admin/oil-lubricants', payload);
        await load();
        if (equipmentId) await loadMappings();
      });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/admin/oil-lubricants/${deleting.id}`); await load(); });
      setDeleting(null);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  if (!items) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Oil & Lubricant Master"
        subtitle="A reference list of oil and lubricant types — the same list DRR's Lubricating Oil section reads live."
        actions={
          <button className="btn-primary" onClick={() => openEditor(null)}><Plus size={14} /> New entry</button>
        }
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-4 mb-5 grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Select Rig">
          <select className="input" value={rigId} onChange={(e) => setRigId(e.target.value)}>
            <option value="">All Equipment / All Oils</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
        <Field label="Select Equipment">
          <select className="input" value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)} disabled={!rigId}>
            <option value="">{rigId ? 'All equipment on this rig' : 'Select a rig first'}</option>
            {equipmentOptions.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
          </select>
        </Field>
      </div>

      {equipmentId && mappings && (() => {
        const selected = equipmentOptions.find((eq) => eq.id === equipmentId);
        const available = items.filter((o) => o.status === 'Active' && !mappings.some((m) => m.oilLubricantId === o.id));
        return (
          <div className="card p-4 mb-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">Assigned Lubricants{selected ? ` — ${selected.name}` : ''}</h3>
            <div className="flex flex-wrap gap-2 mb-3">
              {mappings.map((m) => (
                <span key={m.id} className="pill-normal inline-flex items-center gap-1">
                  {m.name}
                  <button className="hover:text-red-700" onClick={() => void removeMapping(m.id)} disabled={mappingBusy} title="Remove">
                    <X size={12} />
                  </button>
                </span>
              ))}
              {mappings.length === 0 && <span className="text-sm text-slate-500">No oils/lubricants assigned yet.</span>}
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 max-w-xs">
                <Field label="Add Oil/Lubricant">
                  <select className="input" value={addOilId} onChange={(e) => setAddOilId(e.target.value)}>
                    <option value="">Select from Global Oil & Lubricant Master</option>
                    {available.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </Field>
              </div>
              <button className="btn-primary" onClick={() => void addMapping()} disabled={!addOilId || mappingBusy}>
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        );
      })()}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Used By (Equipment → Rig)</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id}>
                <td className="font-medium">{o.name}</td>
                <td>
                  {o.usage && o.usage.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {o.usage.map((u) => (
                        <span key={u.mappingId} className="pill-place text-xs">
                          {u.equipmentName} <span className="opacity-60">→ {u.rigName}</span>
                        </span>
                      ))}
                    </div>
                  ) : <span className="text-slate-400">Not assigned to any equipment</span>}
                </td>
                <td>{o.status}</td>
                <td className="text-right whitespace-nowrap">
                  <button className="btn-ghost btn-sm mr-1" onClick={() => openEditor(o)}><Pencil size={12} /></button>
                  <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(o)}><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4}><Empty message="No oil/lubricant entries created yet." /></td></tr>}
          </tbody>
        </table>
      </div>

      <Modal open={!!editing} title={editing?.id ? 'Edit entry' : 'New entry'} onClose={() => setEditing(null)}>
        {editing && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Field label="Name">
                  <input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                </Field>
              </div>
              {/*
                Equipment comes from Equipment Master by id, so an assignment
                always points at a real machine and carries that machine's
                current rig with it. Picking one already assigned is impossible
                — it's simply not offered — which is what keeps the mapping
                table free of duplicates.
              */}
              <div className="col-span-2">
                <Field label="Used By Equipment" hint="Optional. Pick from Equipment Master — the rig comes from the equipment, and follows it if it's transferred.">
                  <div className="flex flex-wrap gap-1 mb-2">
                    {editEquipmentIds.map((id) => {
                      const eq = allEquipment.find((e) => e.id === id);
                      return (
                        <span key={id} className="pill-normal inline-flex items-center gap-1">
                          {eq ? `${eq.name} → ${eq.rigName}` : id}
                          <button className="hover:text-red-700" title="Remove"
                            onClick={() => setEditEquipmentIds(editEquipmentIds.filter((x) => x !== id))}>
                            <X size={12} />
                          </button>
                        </span>
                      );
                    })}
                    {editEquipmentIds.length === 0 && <span className="text-sm text-slate-500">Not assigned to any equipment.</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <select className="input" value={editRigId} onChange={(e) => setEditRigId(e.target.value)}>
                      <option value="">Select a rig...</option>
                      {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
                    </select>
                    <select
                      className="input" value="" disabled={!editRigId}
                      onChange={(e) => {
                        if (!e.target.value) return;
                        setEditEquipmentIds([...editEquipmentIds, e.target.value]);
                      }}
                    >
                      <option value="">{editRigId ? 'Add equipment...' : 'Select a rig first'}</option>
                      {allEquipment
                        .filter((eq) => eq.rigId === editRigId && !editEquipmentIds.includes(eq.id))
                        .map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
                    </select>
                  </div>
                </Field>
              </div>
              <Field label="Status">
                <select className="input" value={editing.status ?? 'Active'}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
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
        confirmLabel="Delete entry"
        busy={busy}
        body={<p>This entry will be removed. This cannot be undone.</p>}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
