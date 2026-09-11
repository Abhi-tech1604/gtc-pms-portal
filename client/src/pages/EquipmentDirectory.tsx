import { useEffect, useMemo, useState } from 'react';
import { rigLabel } from '../lib/rig';
import { Link, useSearchParams } from 'react-router-dom';
import { HeartPulse, MapPin, Pencil, Plus, Search, Trash2, Truck, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { count, date, hours, statusClass, todayIso } from '../lib/format';
import type { Equipment, Rig } from '../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, useBusy } from '../components/ui';
import { useAuth } from '../lib/auth';

const PLACE_OPTIONS = ['Bakrol Yard', 'Central Store', 'Other'];

const CATEGORIES = [
  'Rig Carrier Engine', 'Mud Pump Engine', 'Mud Pump', 'DG Set', 'Air Compressor',
  'Fire Pump', 'Transmission', 'Generator', 'BCU', 'Crane', 'Trailer', 'Others',
];
const STATUSES = ['Normal', 'Upcoming', 'Overdue', 'Breakdown'];
const HEALTH_STATUSES = ['Normal', 'Upcoming', 'Overdue'];

export default function EquipmentDirectory() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<Equipment[] | null>(null);
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Partial<Equipment> | null>(null);
  const [deleting, setDeleting] = useState<Equipment | null>(null);
  const [checkup, setCheckup] = useState<Equipment | null>(null);
  const [servicing, setServicing] = useState<Equipment | null>(null);
  const [transferring, setTransferring] = useState<Equipment | null>(null);
  const [busy, run] = useBusy();

  const rigId = params.get('rigId') ?? '';
  const category = params.get('category') ?? '';
  const status = params.get('status') ?? '';
  const health = params.get('health') ?? '';
  const search = params.get('search') ?? '';

  async function load() {
    const [eq, rigData] = await Promise.all([
      api.get<{ equipment: Equipment[] }>('/equipment'),
      api.get<{ rigs: Rig[] }>('/rigs'),
    ]);
    setItems(eq.equipment);
    setRigs(rigData.rigs);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  const filtered = useMemo(() => {
    if (!items) return [];
    const needle = search.trim().toLowerCase();
    return items.filter((e) =>
      (!rigId || e.rigId === rigId) &&
      (!category || e.category === category) &&
      (!status || e.status === status) &&
      (!health || e.healthStatus === health) &&
      (!needle || [e.name, e.serialNumber, e.model, e.manufacturer, e.rigNumber, e.category]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))),
    );
  }, [items, rigId, category, status, health, search]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }

  async function save() {
    if (!editing) return;
    setError('');
    try {
      await run(async () => {
        if (editing.id) await api.put(`/equipment/${editing.id}`, editing);
        else await api.post('/equipment', editing);
        await load();
      });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/equipment/${deleting.id}`); await load(); });
      setDeleting(null);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  if (!items) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Equipment Directory"
        subtitle={`${count(filtered.length)} of ${count(items.length)} machine(s). All hour figures are whole numbers.`}
        actions={can('canManageEquipment') && (
          <button className="btn-primary" onClick={() => setEditing({
            rigId: rigId || rigs[0]?.id, category: 'Others', section: 'diesel',
            serviceInterval: 500, healthCheckInterval: 90,
          })}>
            <Plus size={14} /> New machine
          </button>
        )}
      />

      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-4 grid grid-cols-1 md:grid-cols-5 gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            className="input pl-8" placeholder="Search name, serial, model..."
            value={search} onChange={(e) => setFilter('search', e.target.value)}
          />
        </div>
        <select className="input" value={rigId} onChange={(e) => setFilter('rigId', e.target.value)}>
          <option value="">All rigs</option>
          {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
        </select>
        <select className="input" value={category} onChange={(e) => setFilter('category', e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className="input" value={status} onChange={(e) => setFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="input" value={health} onChange={(e) => setFilter('health', e.target.value)}>
          <option value="">All health statuses</option>
          {HEALTH_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Rig</th>
              <th>Machine</th>
              <th>Serial No</th>
              <th className="text-right">Current Hrs</th>
              <th className="text-right">Since Service</th>
              <th className="text-right">Interval</th>
              <th className="text-right">Remaining</th>
              <th>Status</th>
              <th>Health</th>
              <th>Last Reported</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap">
                  {e.currentPlace ? (
                    <>
                      <span className="pill-place inline-flex items-center gap-1">
                        <MapPin size={10} /> {e.currentPlace}
                      </span>
                      <div className="text-[11px] text-slate-500 mt-0.5">home rig {e.rigNumber}</div>
                    </>
                  ) : e.rigNumber}
                </td>
                <td>
                  <Link to={`/equipment/${e.id}`} className="text-rig-700 hover:underline font-medium">{e.name}</Link>
                  <div className="text-[11px] text-slate-500">{e.category}{e.model ? ` · ${e.model}` : ''}</div>
                </td>
                <td className="text-xs">{e.serialNumber ?? '-'}</td>
                <td className="num">{hours(e.currentRunningHours)}</td>
                <td className="num">{hours(e.runningSinceLastService)}</td>
                <td className="num">{hours(e.serviceInterval)}</td>
                <td className={`num font-semibold ${e.remainingServiceHours <= 0 ? 'text-red-600' : ''}`}>
                  {hours(e.remainingServiceHours)}
                </td>
                <td><span className={statusClass(e.status)}>{e.status}</span></td>
                <td>
                  <span className={statusClass(e.healthStatus)}>{e.healthStatus}</span>
                  <div className="text-[11px] text-slate-500">
                    {e.remainingHealthCheckDays === null ? 'never checked' : `${e.remainingHealthCheckDays} d`}
                  </div>
                </td>
                <td className="whitespace-nowrap text-xs">{date(e.lastReportedDate)}</td>
                <td className="whitespace-nowrap text-right">
                  {can('canManageHealthcheckup') && (
                    <button className="btn-ghost btn-sm mr-1" title="Log a health checkup" onClick={() => setCheckup(e)}>
                      <HeartPulse size={12} />
                    </button>
                  )}
                  {can('canManageEquipment') && (
                    <button className="btn-ghost btn-sm mr-1" title="Log a service" onClick={() => setServicing(e)}>
                      <Wrench size={12} />
                    </button>
                  )}
                  {can('canManageEquipment') && (
                    <>
                      <button className="btn-ghost btn-sm mr-1" title="Transfer" onClick={() => setTransferring(e)}>
                        <Truck size={12} />
                      </button>
                      <button className="btn-ghost btn-sm mr-1" onClick={() => setEditing(e)}>
                        <Pencil size={12} />
                      </button>
                      <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(e)}>
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11}>
                  <Empty message={items.length === 0
                    ? 'No machines yet. They are created automatically when a workbook is imported.'
                    : 'No machine matches these filters.'} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <EquipmentModal
        editing={editing} rigs={rigs} busy={busy}
        onChange={setEditing} onClose={() => setEditing(null)} onSave={() => void save()}
      />

      <CheckupModal
        equipment={checkup}
        onClose={() => setCheckup(null)}
        onSaved={() => { setCheckup(null); void load(); }}
        onError={setError}
      />

      <ServiceModal
        equipment={servicing}
        onClose={() => setServicing(null)}
        onSaved={() => { setServicing(null); void load(); }}
        onError={setError}
      />

      <TransferModal
        equipment={transferring}
        rigs={rigs}
        onClose={() => setTransferring(null)}
        onSaved={() => { setTransferring(null); void load(); }}
        onError={setError}
      />

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title={`Delete ${deleting?.name ?? ''}?`}
        confirmLabel="Delete machine"
        busy={busy}
        body={
          <div>
            <p>
              {deleting?.name} on {deleting?.rigNumber} will be removed, along with its log rows,
              history and health check records.
            </p>
            <p className="mt-2 text-slate-500">
              Current hours {hours(deleting?.currentRunningHours)} · serial {deleting?.serialNumber ?? 'not recorded'}
            </p>
          </div>
        }
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function EquipmentModal({ editing, rigs, busy, onChange, onClose, onSave }: {
  editing: Partial<Equipment> | null;
  rigs: Rig[];
  busy: boolean;
  onChange: (e: Partial<Equipment>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  if (!editing) return null;
  const set = (patch: Partial<Equipment>) => onChange({ ...editing, ...patch });
  return (
    <Modal open title={editing.id ? 'Edit machine' : 'New machine'} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Rig">
          <select className="input" value={editing.rigId ?? ''} onChange={(e) => set({ rigId: e.target.value })}
            disabled={!!editing.id}>
            <option value="">-</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
        <Field label="Name"><input className="input" value={editing.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Category">
          <select className="input" value={editing.category ?? 'Others'} onChange={(e) => set({ category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Section" hint="Which half of the workbook this machine is seeded into">
          <select className="input" value={editing.section ?? 'diesel'} onChange={(e) => set({ section: e.target.value })}>
            <option value="diesel">Diesel Engines</option>
            <option value="generator">Generator</option>
          </select>
        </Field>
        <Field label="Manufacturer"><input className="input" value={editing.manufacturer ?? ''} onChange={(e) => set({ manufacturer: e.target.value })} /></Field>
        <Field label="Make / Model"><input className="input" value={editing.model ?? ''} onChange={(e) => set({ model: e.target.value })} /></Field>
        <Field label="M/C Serial No"><input className="input" value={editing.serialNumber ?? ''} onChange={(e) => set({ serialNumber: e.target.value })} /></Field>
        <Field label="Asset number"><input className="input" value={editing.assetNumber ?? ''} onChange={(e) => set({ assetNumber: e.target.value })} /></Field>
        <Field label="Engine number"><input className="input" value={editing.engineNumber ?? ''} onChange={(e) => set({ engineNumber: e.target.value })} /></Field>
        <Field label="Installation date"><input className="input" type="date" value={editing.installationDate ?? ''} onChange={(e) => set({ installationDate: e.target.value })} /></Field>
        <Field label="Current running hours">
          <input className="input" type="number" step="1" value={editing.currentRunningHours ?? 0}
            onChange={(e) => set({ currentRunningHours: Math.round(Number(e.target.value)) })} />
        </Field>
        <Field label="Last service hours">
          <input className="input" type="number" step="1" value={editing.lastServiceHours ?? 0}
            onChange={(e) => set({ lastServiceHours: Math.round(Number(e.target.value)) })} />
        </Field>
        <Field label="Service interval (hours)">
          <input className="input" type="number" step="1" value={editing.serviceInterval ?? 500}
            onChange={(e) => set({ serviceInterval: Math.round(Number(e.target.value)) })} />
        </Field>
        <Field label="Health check interval (days)">
          <input className="input" type="number" step="1" value={editing.healthCheckInterval ?? 90}
            onChange={(e) => set({ healthCheckInterval: Math.round(Number(e.target.value)) })} />
        </Field>
        <Field label="Last health check date">
          <input className="input" type="date" value={editing.lastHealthCheckDate ?? ''}
            onChange={(e) => set({ lastHealthCheckDate: e.target.value })} />
        </Field>
        <Field label="Breakdown">
          <label className="flex items-center gap-2 text-sm mt-1.5">
            <input type="checkbox" checked={!!editing.isBreakdown} onChange={(e) => set({ isBreakdown: e.target.checked })} />
            Flagged as broken down
          </label>
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={onSave} disabled={busy}>Save</button>
      </div>
    </Modal>
  );
}

/**
 * Same fields as the Engineering Health Log workbook — date, problem, action,
 * remarks — so a checkup logged here and one bulk-imported from Excel read the
 * same way everywhere they're shown. Unlike a workbook row, this one always
 * carries the machine's own id: it was opened from that machine's own record.
 */
export function CheckupModal({ equipment, onClose, onSaved, onError }: {
  equipment: Equipment | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState({ date: todayIso(), problem: '', action: '', remarks: '' });
  const [busy, run] = useBusy();

  useEffect(() => {
    if (equipment) setForm({ date: todayIso(), problem: '', action: '', remarks: '' });
  }, [equipment]);

  if (!equipment) return null;

  async function save() {
    try {
      await run(() => api.post('/health-narratives/manual', { ...form, equipmentId: equipment!.id }));
      onSaved();
    } catch (e) { onError((e as Error).message); onClose(); }
  }

  return (
    <Modal open title={`Log a health checkup - ${equipment.name}`} onClose={onClose} width="max-w-lg">
      <div className="text-sm text-slate-600 mb-3">
        {equipment.rigNumber} · serial {equipment.serialNumber ?? 'not recorded'} ·
        last checked {date(equipment.lastHealthCheckDate)} · next due in 90 days from the last checkup
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date">
          <input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </Field>
        <div />
        <div className="col-span-2">
          <Field label="Problem" hint="Leave blank if nothing was found">
            <textarea className="input" rows={2} value={form.problem} onChange={(e) => setForm({ ...form, problem: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Action">
            <textarea className="input" rows={2} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Remarks">
            <textarea className="input" rows={2} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save checkup</button>
      </div>
    </Modal>
  );
}

/**
 * Head Office / Admin service entry — the Spanner button's counterpart to
 * CheckupModal above. Rig and equipment are already fixed by which row was
 * clicked (same as the health checkup flow), so there's no separate picker;
 * this always appends a new equipment_service_records row and moves the
 * machine's lastServiceHours forward, never overwriting an earlier entry.
 */
export function ServiceModal({ equipment, onClose, onSaved, onError }: {
  equipment: Equipment | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState({ date: todayIso(), serviceHours: 0, remarks: '' });
  const [busy, run] = useBusy();

  useEffect(() => {
    if (equipment) setForm({ date: todayIso(), serviceHours: equipment.currentRunningHours, remarks: '' });
  }, [equipment]);

  if (!equipment) return null;

  async function save() {
    try {
      await run(() => api.post(`/equipment/${equipment!.id}/service`, form));
      onSaved();
    } catch (e) { onError((e as Error).message); }
  }

  return (
    <Modal open title={`Log a service - ${equipment.name}`} onClose={onClose} width="max-w-lg">
      <div className="text-sm text-slate-600 mb-3">
        {equipment.rigNumber} · serial {equipment.serialNumber ?? 'not recorded'} ·
        last serviced at {hours(equipment.lastServiceHours)} hrs
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Service Date">
          <input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </Field>
        <Field label="Service Hours" hint="The hour-meter reading at the time of service">
          <input className="input" type="number" min={0} value={form.serviceHours}
            onChange={(e) => setForm({ ...form, serviceHours: Number(e.target.value) || 0 })} />
        </Field>
        <div className="col-span-2">
          <Field label="Service details / remarks">
            <textarea className="input" rows={2} value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save service</button>
      </div>
    </Modal>
  );
}

/**
 * Moves one machine either to another rig (it becomes that rig's asset going
 * forward) or to a yard/store location (its home rig is unchanged; it is just
 * away). A temporary transfer can carry an expected return date; a permanent
 * one cannot. Moving equipment "back" later is simply another transfer.
 */
function TransferModal({ equipment, rigs, onClose, onSaved, onError }: {
  equipment: Equipment | null;
  rigs: Rig[];
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [destinationType, setDestinationType] = useState<'rig' | 'place'>('rig');
  const [toRigId, setToRigId] = useState('');
  const [placeChoice, setPlaceChoice] = useState(PLACE_OPTIONS[0]);
  const [customPlace, setCustomPlace] = useState('');
  const [transferType, setTransferType] = useState<'Permanent' | 'Temporary'>('Permanent');
  const [transferDate, setTransferDate] = useState(todayIso());
  const [expectedReturnDate, setExpectedReturnDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, run] = useBusy();

  useEffect(() => {
    if (!equipment) return;
    setDestinationType('rig');
    setToRigId('');
    setPlaceChoice(PLACE_OPTIONS[0]);
    setCustomPlace('');
    setTransferType('Permanent');
    setTransferDate(todayIso());
    setExpectedReturnDate('');
    setRemarks('');
  }, [equipment]);

  if (!equipment) return null;

  const toPlace = placeChoice === 'Other' ? customPlace.trim() : placeChoice;

  async function save() {
    try {
      await run(() => api.post('/equipment-transfers', {
        equipmentId: equipment!.id,
        destinationType,
        toRigId: destinationType === 'rig' ? toRigId : undefined,
        toPlace: destinationType === 'place' ? toPlace : undefined,
        transferType,
        date: transferDate,
        expectedReturnDate: transferType === 'Temporary' ? expectedReturnDate : undefined,
        remarks,
      }));
      onSaved();
    } catch (e) { onError((e as Error).message); }
  }

  const canSave = destinationType === 'rig' ? !!toRigId : !!toPlace;

  return (
    <Modal open title={`Transfer ${equipment.name}`} onClose={onClose} width="max-w-lg">
      <div className="text-sm text-slate-600 mb-3">
        Currently {equipment.currentPlace
          ? <>at <span className="font-medium">{equipment.currentPlace}</span> (home rig {equipment.rigNumber})</>
          : <>on <span className="font-medium">{equipment.rigNumber}</span></>}
      </div>
      <div className="space-y-3">
        <Field label="Transfer to">
          <div className="flex gap-4 text-sm mt-1">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={destinationType === 'rig'} onChange={() => setDestinationType('rig')} />
              A rig
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={destinationType === 'place'} onChange={() => setDestinationType('place')} />
              A yard or store
            </label>
          </div>
        </Field>

        {destinationType === 'rig' ? (
          <Field label="Rig">
            <select className="input" value={toRigId} onChange={(e) => setToRigId(e.target.value)}>
              <option value="">Choose a rig...</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Location">
              <select className="input" value={placeChoice} onChange={(e) => setPlaceChoice(e.target.value)}>
                {PLACE_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            {placeChoice === 'Other' && (
              <Field label="Specify">
                <input className="input" value={customPlace} onChange={(e) => setCustomPlace(e.target.value)} />
              </Field>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Transfer type">
            <select className="input" value={transferType} onChange={(e) => setTransferType(e.target.value as 'Permanent' | 'Temporary')}>
              <option>Permanent</option>
              <option>Temporary</option>
            </select>
          </Field>
          <Field label="Date">
            <input className="input" type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
          </Field>
        </div>

        {transferType === 'Temporary' && (
          <Field label="Expected return date" hint="Optional">
            <input className="input" type="date" value={expectedReturnDate} onChange={(e) => setExpectedReturnDate(e.target.value)} />
          </Field>
        )}

        <Field label="Remarks" hint="Optional">
          <textarea className="input" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => void save()} disabled={busy || !canSave}>Save transfer</button>
      </div>
    </Modal>
  );
}
