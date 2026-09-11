import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Pencil, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import type { IlmContractDurationRule, IlmRig } from '../../lib/types';
import { Empty, ErrorBox, Field, InfoBox, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';

const STATUSES = ['Active', 'Inactive'];

/**
 * Admin > Master > ILM Contract Duration Rules — every ILM rig configures
 * its own distance-banded allowed-hours rules independently (spec: "Never
 * use another Rig's rule"). Nothing here is a fleet-wide default; a Trailer
 * Movement resolves against these once, at creation, and freezes the result
 * (services/ilmLifecycle.ts's addTrailerMovement()) — editing or
 * deactivating a rule afterward never recalculates an already-created
 * movement.
 */
export default function IlmContractDurationRules() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [rigs, setRigs] = useState<IlmRig[]>([]);
  const [ilmRigId, setIlmRigId] = useState(searchParams.get('ilmRigId') ?? '');
  const [rules, setRules] = useState<IlmContractDurationRule[] | null>(null);
  const [editing, setEditing] = useState<Partial<IlmContractDurationRule> | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  useEffect(() => {
    api.get<{ rigs: IlmRig[] }>('/ilm/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  async function loadRules() {
    if (!ilmRigId) { setRules(null); return; }
    setRules((await api.get<{ rules: IlmContractDurationRule[] }>(`/ilm/contract-duration-rules?ilmRigId=${ilmRigId}`)).rules);
  }

  useEffect(() => { loadRules().catch((e) => setError((e as Error).message)); }, [ilmRigId]);

  function pickRig(id: string) {
    setIlmRigId(id);
    setSearchParams(id ? { ilmRigId: id } : {});
  }

  async function save() {
    if (!editing || !ilmRigId) return;
    setError('');
    if (editing.fromDistanceKm === undefined || editing.fromDistanceKm === null || editing.fromDistanceKm < 0) {
      setError('Distance From (KM) is required and cannot be negative.'); return;
    }
    if (editing.toDistanceKm !== undefined && editing.toDistanceKm !== null && editing.toDistanceKm <= editing.fromDistanceKm) {
      setError('Distance To (KM) must be greater than Distance From, or left blank for an open-ended "above X KM" rule.'); return;
    }
    if (editing.baseHours === undefined || editing.baseHours === null || editing.baseHours < 0) {
      setError('Base Allowed Hours is required and cannot be negative.'); return;
    }
    try {
      await run(async () => {
        const body = {
          ilmRigId,
          fromDistanceKm: editing.fromDistanceKm,
          toDistanceKm: editing.toDistanceKm ?? null,
          baseHours: editing.baseHours,
          extraHoursPerKm: editing.extraHoursPerKm ?? 0,
          roundPerKm: editing.roundPerKm !== false,
          status: editing.status ?? 'Active',
        };
        if (editing.id) await api.put(`/ilm/contract-duration-rules/${editing.id}`, body);
        else await api.post('/ilm/contract-duration-rules', body);
        await loadRules();
      });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  const selectedRig = rigs.find((r) => r.id === ilmRigId) ?? null;

  return (
    <div>
      <PageHeader
        title="ILM Contract Duration Rules"
        subtitle="Per-rig distance bands — how many hours an ILM movement is allowed, by how far it travels. Each rig is configured independently."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-4 mb-5">
        <Field label="Select ILM Rig">
          <select className="input max-w-sm" value={ilmRigId} onChange={(e) => pickRig(e.target.value)}>
            <option value="">Choose a rig...</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{r.name || r.rigNumber}</option>)}
          </select>
        </Field>
      </div>

      {!ilmRigId ? (
        <div className="card"><Empty message="Select a rig above to view or configure its Contract Duration Rules." /></div>
      ) : !rules ? <Spinner /> : (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-800">Rules for {selectedRig?.name || selectedRig?.rigNumber}</h3>
            <button
              className="btn-primary btn-sm"
              onClick={() => setEditing({ status: 'Active', extraHoursPerKm: 0, roundPerKm: true })}
            >
              <Plus size={14} /> Add Rule
            </button>
          </div>
          {rules.length === 0 && (
            <InfoBox>
              No rules configured yet for this rig — until one is added, ILM movements for this rig will show a warning
              and require Allowed Duration to be entered manually.
            </InfoBox>
          )}
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th className="text-right">Distance From (KM)</th>
                  <th className="text-right">Distance To (KM)</th>
                  <th className="text-right">Base Allowed Hours</th>
                  <th className="text-right">Additional Hours / KM</th>
                  <th>Rounding</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td className="num">{r.fromDistanceKm}</td>
                    <td className="num">{r.toDistanceKm ?? 'Above'}</td>
                    <td className="num">{r.baseHours}</td>
                    <td className="num">{r.extraHoursPerKm}</td>
                    <td>{r.roundPerKm ? 'Per KM or part thereof' : 'Exact'}</td>
                    <td><span className={r.status === 'Active' ? 'pill-normal' : 'pill-place'}>{r.status}</span></td>
                    <td className="whitespace-nowrap text-slate-500">{dateTime(r.updatedAt)}</td>
                    <td className="text-right">
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(r)}><Pencil size={12} /></button>
                    </td>
                  </tr>
                ))}
                {rules.length === 0 && <tr><td colSpan={8}><Empty message="No rules yet." /></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={!!editing} title={editing?.id ? 'Edit contract duration rule' : 'Add contract duration rule'} onClose={() => setEditing(null)}>
        {editing && (
          <div className="space-y-3">
            <InfoBox>
              Editing or deactivating this rule never changes any ILM movement already created — only new movements
              created after this change will use it.
            </InfoBox>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Distance From (KM)">
                <input className="input" type="number" min={0} step="0.1" value={editing.fromDistanceKm ?? ''}
                  onChange={(e) => setEditing({ ...editing, fromDistanceKm: e.target.value === '' ? undefined : Number(e.target.value) })} />
              </Field>
              <Field label="Distance To (KM)" hint="Leave blank for an open-ended 'above X KM' rule">
                <input className="input" type="number" min={0} step="0.1" value={editing.toDistanceKm ?? ''}
                  onChange={(e) => setEditing({ ...editing, toDistanceKm: e.target.value === '' ? null : Number(e.target.value) })} />
              </Field>
              <Field label="Base Allowed Hours">
                <input className="input" type="number" min={0} step="0.5" value={editing.baseHours ?? ''}
                  onChange={(e) => setEditing({ ...editing, baseHours: e.target.value === '' ? undefined : Number(e.target.value) })} />
              </Field>
              <Field label="Additional Hours per KM" hint="0 for a flat rule">
                <input className="input" type="number" min={0} step="0.1" value={editing.extraHoursPerKm ?? 0}
                  onChange={(e) => setEditing({ ...editing, extraHoursPerKm: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="Status">
                <select className="input" value={editing.status ?? 'Active'}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value as IlmContractDurationRule['status'] })}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input type="checkbox" checked={editing.roundPerKm !== false}
                    onChange={(e) => setEditing({ ...editing, roundPerKm: e.target.checked })} />
                  Per KM or part thereof
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
