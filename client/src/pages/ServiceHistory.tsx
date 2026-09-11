import { useEffect, useState } from 'react';
import { rigLabel } from '../lib/rig';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { date, hours } from '../lib/format';
import type { Equipment, FleetServiceRecord, Rig } from '../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../components/ui';

/** PMS > Service History: the fleet-wide list of every service logged from either DRR or a manual PMS entry — one shared table, no duplicate records. */
export default function ServiceHistory() {
  const [params, setParams] = useSearchParams();
  const [records, setRecords] = useState<FleetServiceRecord[] | null>(null);
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [error, setError] = useState('');

  const rigId = params.get('rigId') ?? '';
  const equipmentId = params.get('equipmentId') ?? '';
  const dateFrom = params.get('dateFrom') ?? '';
  const dateTo = params.get('dateTo') ?? '';

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!rigId) { setEquipment([]); return; }
    api.get<{ equipment: Equipment[] }>(`/equipment?rigId=${rigId}`).then((d) => setEquipment(d.equipment)).catch(() => {});
  }, [rigId]);

  async function load() {
    const q = new URLSearchParams();
    if (rigId) q.set('rigId', rigId);
    if (equipmentId) q.set('equipmentId', equipmentId);
    if (dateFrom) q.set('dateFrom', dateFrom);
    if (dateTo) q.set('dateTo', dateTo);
    setRecords((await api.get<{ records: FleetServiceRecord[] }>(`/equipment/service-history?${q}`)).records);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [rigId, equipmentId, dateFrom, dateTo]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key === 'rigId') next.delete('equipmentId');
    setParams(next, { replace: true });
  }

  return (
    <div>
      <PageHeader title="Service History" subtitle="Every service entry across the fleet — logged from DRR's Equipment Running Hours or manually from Equipment Directory, all in one place." />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-4 mb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="Rig">
          <select className="input" value={rigId} onChange={(e) => setFilter('rigId', e.target.value)}>
            <option value="">All rigs</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
        <Field label="Equipment">
          <select className="input" value={equipmentId} onChange={(e) => setFilter('equipmentId', e.target.value)} disabled={!rigId}>
            <option value="">{rigId ? 'All equipment on this rig' : 'Select a rig first'}</option>
            {equipment.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
          </select>
        </Field>
        <Field label="From">
          <input className="input" type="date" value={dateFrom} onChange={(e) => setFilter('dateFrom', e.target.value)} />
        </Field>
        <Field label="To">
          <input className="input" type="date" value={dateTo} onChange={(e) => setFilter('dateTo', e.target.value)} />
        </Field>
      </div>

      {!records ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th><th>Rig</th><th>Equipment</th>
                <th className="text-right">Service Hours</th><th>Method</th><th>Remarks</th><th>Recorded By</th>
              </tr>
            </thead>
            <tbody>
              {records.map((s) => (
                <tr key={s.id}>
                  <td className="whitespace-nowrap">{date(s.date)}</td>
                  <td className="whitespace-nowrap">{s.rigNumber}</td>
                  <td>{s.equipmentName}</td>
                  <td className="num">{hours(s.serviceHours)}</td>
                  <td><span className={s.method === 'Manual' ? 'pill-place' : 'pill-normal'}>{s.method}</span></td>
                  <td className="text-xs max-w-[280px] truncate">{s.remarks ?? '-'}</td>
                  <td className="text-xs">{s.recordedBy}</td>
                </tr>
              ))}
              {records.length === 0 && <tr><td colSpan={7}><Empty message="No service recorded for this filter yet." /></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
