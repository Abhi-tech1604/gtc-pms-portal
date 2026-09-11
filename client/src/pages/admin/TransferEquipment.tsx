import { useEffect, useState } from 'react';
import { List, Repeat } from 'lucide-react';
import { rigLabel } from '../../lib/rig';
import { api } from '../../lib/api';
import { date, dateTime, todayIso } from '../../lib/format';
import type { Equipment, EquipmentTransfer, Rig } from '../../lib/types';
import { Empty, ErrorBox, Field, InfoBox, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';

type DestinationType = 'rig' | 'yard' | 'other';

/**
 * Admin > Master > Transfer Equipment — the single centralized place every
 * equipment move (to another rig, to a yard, or to any other location) is
 * recorded. It is a thin UI over the existing equipment_transfers table/API
 * (server/src/routes/equipmentTransfers.ts) — the same store Equipment
 * Detail's own "Transfers" tab already reads — so a transfer made here is
 * immediately visible everywhere else, and there is exactly one transfer
 * mechanism in the whole app. Saving a transfer updates the equipment's
 * current rig/location server-side; Material Master's Location and every
 * DRR/PMS/ILM screen derive from that same equipment row live, so they never
 * need a separate update here.
 */
export default function TransferEquipment() {
  const [view, setView] = useState<'form' | 'list'>('form');

  return (
    <div>
      <PageHeader
        title="Transfer Equipment"
        subtitle="Move a machine to another rig, a yard, or any other location — recorded once, reflected everywhere."
        actions={
          <button className="btn-ghost" onClick={() => setView((v) => (v === 'form' ? 'list' : 'form'))}>
            {view === 'form' ? <><List size={14} /> List</> : <><Repeat size={14} /> New Transfer</>}
          </button>
        }
      />
      {view === 'form' ? <TransferForm onSaved={() => setView('list')} /> : <TransferList />}
    </div>
  );
}

function TransferForm({ onSaved }: { onSaved: () => void }) {
  const [rigs, setRigs] = useState<Rig[] | null>(null);
  const [places, setPlaces] = useState<string[]>([]);
  const [rigId, setRigId] = useState('');
  const [equipment, setEquipment] = useState<Equipment[] | null>(null);
  const [equipmentId, setEquipmentId] = useState('');
  const [destinationType, setDestinationType] = useState<DestinationType>('rig');
  const [toRigId, setToRigId] = useState('');
  const [toPlace, setToPlace] = useState('');
  const [transferDate, setTransferDate] = useState(todayIso());
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, run] = useBusy();

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
    api.get<{ places: string[] }>('/equipment-transfers/places').then((d) => setPlaces(d.places)).catch(() => {});
  }, []);

  useEffect(() => {
    setEquipmentId('');
    if (!rigId) { setEquipment(null); return; }
    setEquipment(null);
    api.get<{ equipment: Equipment[] }>(`/equipment?rigId=${rigId}`)
      .then((d) => setEquipment(d.equipment))
      .catch((e) => setError((e as Error).message));
  }, [rigId]);

  const selectedEquipment = equipment?.find((e) => e.id === equipmentId) ?? null;

  function reset() {
    setEquipmentId('');
    setDestinationType('rig');
    setToRigId('');
    setToPlace('');
    setTransferDate(todayIso());
    setRemarks('');
  }

  async function save() {
    setError('');
    setSuccess('');
    if (!rigId) { setError('Select the current rig.'); return; }
    if (!equipmentId) { setError('Select the equipment to transfer.'); return; }
    if (destinationType === 'rig' && !toRigId) { setError('Select the destination rig.'); return; }
    if (destinationType !== 'rig' && !toPlace.trim()) {
      setError(destinationType === 'yard' ? 'Select the destination yard.' : 'Enter the destination location.');
      return;
    }
    try {
      await run(async () => {
        await api.post('/equipment-transfers', {
          equipmentId,
          destinationType,
          toRigId: destinationType === 'rig' ? toRigId : undefined,
          toPlace: destinationType !== 'rig' ? toPlace.trim() : undefined,
          transferType: 'Permanent',
          date: transferDate,
          remarks: remarks.trim() || undefined,
        });
        if (destinationType !== 'rig' && !places.includes(toPlace.trim())) {
          setPlaces((prev) => [...prev, toPlace.trim()].sort());
        }
      });
      setSuccess(`${selectedEquipment?.name ?? 'Equipment'} transferred successfully.`);
      // Refresh this rig's equipment list — a transferred-out machine no longer belongs here.
      const d = await api.get<{ equipment: Equipment[] }>(`/equipment?rigId=${rigId}`);
      setEquipment(d.equipment);
      reset();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="card p-4 max-w-2xl space-y-3">
      <ErrorBox message={error} onDismiss={() => setError('')} />
      {success && <InfoBox>{success}</InfoBox>}

      <Field label="Select Current Rig">
        {!rigs ? <Spinner label="Loading rigs..." /> : (
          <select className="input" value={rigId} onChange={(e) => setRigId(e.target.value)}>
            <option value="">Choose a rig...</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        )}
      </Field>

      <Field label="Select Equipment" hint={rigId ? undefined : 'Choose a rig first.'}>
        {!rigId ? (
          <select className="input" disabled><option>Choose a rig first...</option></select>
        ) : !equipment ? <Spinner label="Loading equipment..." /> : (
          <select className="input" value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
            <option value="">Choose equipment...</option>
            {equipment.map((e) => <option key={e.id} value={e.id}>{e.name}{e.serialNumber ? ` (${e.serialNumber})` : ''}</option>)}
          </select>
        )}
        {rigId && equipment && equipment.length === 0 && (
          <div className="text-[11px] text-slate-500 mt-1">No equipment currently assigned to this rig.</div>
        )}
      </Field>

      <Field label="Transfer To / Location Type">
        <div className="flex items-center gap-4 text-sm mt-1">
          {(['rig', 'yard', 'other'] as DestinationType[]).map((t) => (
            <label key={t} className="flex items-center gap-1.5 cursor-pointer">
              <input type="radio" checked={destinationType === t} onChange={() => { setDestinationType(t); setToRigId(''); setToPlace(''); }} />
              {t === 'rig' ? 'Rig' : t === 'yard' ? 'Yard' : 'Other'}
            </label>
          ))}
        </div>
      </Field>

      {destinationType === 'rig' && (
        <Field label="Destination Rig">
          <select className="input" value={toRigId} onChange={(e) => setToRigId(e.target.value)}>
            <option value="">Choose a rig...</option>
            {rigs?.filter((r) => r.id !== rigId).map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
      )}
      {destinationType === 'yard' && (
        <Field label="Destination Yard" hint={places.length === 0 ? 'No yards recorded yet — use "Other" to name the first one.' : undefined}>
          <select className="input" value={toPlace} onChange={(e) => setToPlace(e.target.value)}>
            <option value="">Choose a yard...</option>
            {places.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
      )}
      {destinationType === 'other' && (
        <Field label="Destination">
          <input className="input" value={toPlace} onChange={(e) => setToPlace(e.target.value)} placeholder="Enter the destination or location" />
        </Field>
      )}

      <Field label="Transfer Date">
        <input className="input max-w-xs" type="date" value={transferDate} onChange={(e) => setTransferDate(e.target.value)} />
      </Field>

      <Field label="Remarks">
        <textarea className="input" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </Field>

      <div className="flex justify-end pt-2">
        <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save Transfer</button>
      </div>
    </div>
  );
}

function TransferList() {
  const [items, setItems] = useState<EquipmentTransfer[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<EquipmentTransfer | null>(null);
  const [history, setHistory] = useState<EquipmentTransfer[] | null>(null);

  async function load() {
    const d = await api.get<{ transfers: EquipmentTransfer[] }>('/equipment-transfers/list');
    setItems(d.transfers);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function open(t: EquipmentTransfer) {
    setSelected(t);
    setHistory(null);
    try {
      const d = await api.get<{ transfers: EquipmentTransfer[] }>(`/equipment-transfers?equipmentId=${t.equipmentId}`);
      setHistory(d.transfers);
    } catch (e) { setError((e as Error).message); }
  }

  function locationLabel(rigNumber: string | null | undefined, rigName: string | null | undefined, place: string | null | undefined): string {
    if (place) return place;
    if (rigNumber || rigName) return rigLabel({ name: rigName, rigNumber });
    return '-';
  }

  return (
    <div>
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <div className="card overflow-x-auto">
        {!items ? <Spinner label="Loading transfers..." /> : (
          <table className="table">
            <thead>
              <tr>
                <th>Equipment</th><th>From Rig/Location</th><th>To Rig/Location</th>
                <th>Transfer Date</th><th>Transferred By</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => void open(t)}>
                  <td className="font-medium text-slate-800">{t.equipmentName ?? '-'}</td>
                  <td className="text-xs">{locationLabel(t.fromRigNumber, t.fromRigName, t.fromPlace)}</td>
                  <td className="text-xs font-medium">{locationLabel(t.toRigNumber, t.toRigName, t.toPlace)}</td>
                  <td className="whitespace-nowrap">{date(t.date)}</td>
                  <td className="text-xs">{t.createdBy ?? '-'}</td>
                  <td>
                    <span className={t.status === 'Current' ? 'pill-normal' : 'pill-place'}>{t.status}</span>
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={6}><Empty message="No equipment transfers recorded yet." /></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={!!selected} title="Transfer details" onClose={() => setSelected(null)} width="max-w-3xl">
        {selected && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><div className="label">Equipment</div><div className="font-medium">{selected.equipmentName ?? '-'}</div></div>
              <div><div className="label">Status</div><span className={selected.status === 'Current' ? 'pill-normal' : 'pill-place'}>{selected.status}</span></div>
              <div><div className="label">From</div><div>{locationLabel(selected.fromRigNumber, selected.fromRigName, selected.fromPlace)}</div></div>
              <div><div className="label">To</div><div className="font-medium">{locationLabel(selected.toRigNumber, selected.toRigName, selected.toPlace)}</div></div>
              <div><div className="label">Transfer Date</div><div>{date(selected.date)}</div></div>
              <div><div className="label">Transferred By</div><div>{selected.createdBy ?? '-'}</div></div>
              <div className="col-span-2"><div className="label">Remarks</div><div>{selected.remarks ?? '-'}</div></div>
              <div className="col-span-2 text-[11px] text-slate-400">Recorded {dateTime(selected.createdAt)}</div>
            </div>

            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                Full transfer history — {selected.equipmentName}
              </div>
              {!history ? <Spinner label="Loading history..." /> : (
                <div className="overflow-x-auto border border-slate-200 rounded-md">
                  <table className="table text-xs">
                    <thead>
                      <tr><th>Date</th><th>From</th><th>To</th><th>Type</th><th>Remarks</th><th>By</th></tr>
                    </thead>
                    <tbody>
                      {history.map((h) => (
                        <tr key={h.id} className={h.id === selected.id ? 'bg-rig-50' : ''}>
                          <td className="whitespace-nowrap">{date(h.date)}</td>
                          <td>{locationLabel(h.fromRigNumber, h.fromRigName, h.fromPlace)}</td>
                          <td className="font-medium">{locationLabel(h.toRigNumber, h.toRigName, h.toPlace)}</td>
                          <td>{h.transferType}</td>
                          <td className="max-w-[200px] truncate">{h.remarks ?? '-'}</td>
                          <td>{h.createdBy ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <button className="btn-ghost" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
