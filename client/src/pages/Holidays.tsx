import { useEffect, useState } from 'react';
import { rigLabel } from '../lib/rig';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { date, todayIso } from '../lib/format';
import type { Rig } from '../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, InfoBox, Modal, PageHeader, Spinner, useBusy } from '../components/ui';
import { useAuth } from '../lib/auth';

interface Holiday {
  id: string; rigId: string; rigNumber: string | null; date: string;
  type: string | null; description: string | null;
}

const TYPES = ['Holiday', 'Rig move', 'Shutdown', 'Maintenance', 'Other'];

export default function Holidays() {
  const { can } = useAuth();
  const [items, setItems] = useState<Holiday[] | null>(null);
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [creating, setCreating] = useState<Partial<Holiday> | null>(null);
  const [deleting, setDeleting] = useState<Holiday | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  async function load() {
    const [h, r] = await Promise.all([
      api.get<{ holidays: Holiday[] }>('/holidays'),
      api.get<{ rigs: Rig[] }>('/rigs'),
    ]);
    setItems(h.holidays);
    setRigs(r.rigs);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function create() {
    if (!creating) return;
    setError('');
    try {
      await run(async () => { await api.post('/holidays', creating); await load(); });
      setCreating(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/holidays/${deleting.id}`); await load(); });
      setDeleting(null);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  if (!items) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Rig Holidays"
        subtitle="Days a rig is not expected to report."
        actions={can('canManageHolidays') && (
          <button className="btn-primary" onClick={() => setCreating({ rigId: 'all', date: todayIso(), type: 'Holiday' })}>
            <Plus size={14} /> New non-reporting day
          </button>
        )}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <InfoBox>
        On a declared non-reporting day the rig shows as Exempt on the dashboard and in the compliance
        report rather than Pending.
      </InfoBox>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Date</th><th>Applies to</th><th>Type</th><th>Description</th><th /></tr></thead>
          <tbody>
            {items.map((h) => (
              <tr key={h.id}>
                <td className="whitespace-nowrap">{date(h.date)}</td>
                <td>{h.rigId === 'all' ? <span className="font-medium">Whole fleet</span> : (h.rigNumber ?? h.rigId)}</td>
                <td>{h.type ?? '-'}</td>
                <td className="text-sm">{h.description ?? '-'}</td>
                <td className="text-right">
                  {can('canManageHolidays') && (
                    <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(h)}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5}><Empty message="No non-reporting days declared." /></td></tr>}
          </tbody>
        </table>
      </div>

      <Modal open={!!creating} title="New non-reporting day" onClose={() => setCreating(null)} width="max-w-lg">
        {creating && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Applies to">
                <select className="input" value={creating.rigId ?? 'all'} onChange={(e) => setCreating({ ...creating, rigId: e.target.value })}>
                  <option value="all">Whole fleet</option>
                  {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
                </select>
              </Field>
              <Field label="Date">
                <input className="input" type="date" value={creating.date ?? ''} onChange={(e) => setCreating({ ...creating, date: e.target.value })} />
              </Field>
              <Field label="Type">
                <select className="input" value={creating.type ?? 'Holiday'} onChange={(e) => setCreating({ ...creating, type: e.target.value })}>
                  {TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <div className="col-span-2">
                <Field label="Description">
                  <input className="input" value={creating.description ?? ''} onChange={(e) => setCreating({ ...creating, description: e.target.value })} />
                </Field>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <button className="btn-ghost" onClick={() => setCreating(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => void create()} disabled={busy}>Save</button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title="Remove this non-reporting day?"
        confirmLabel="Remove"
        busy={busy}
        body={
          <p>
            {date(deleting?.date)} for{' '}
            {deleting?.rigId === 'all' ? 'the whole fleet' : (deleting?.rigNumber ?? 'this rig')} will no
            longer be exempt, and the rig will show as Pending if it did not report.
          </p>
        }
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
