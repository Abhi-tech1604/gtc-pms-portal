import { useEffect, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { api } from '../lib/api';
import { count, date, todayIso } from '../lib/format';
import { ConfirmDialog, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, useBusy } from '../components/ui';
import { useAuth } from '../lib/auth';

interface Transfer {
  id: string; transferNumber: string; materialName: string; quantity: number; unit: string | null;
  source: string | null; destination: string | null; transferType: string | null;
  status: string; date: string; remarks: string | null; createdBy: string | null;
  approvedBy: string | null; approvedAt: string | null;
}

const TYPES = ['Rig to Rig', 'Rig to Yard', 'Yard to Rig', 'Purchase', 'Scrap'];

export default function Transfers() {
  const { can } = useAuth();
  const [items, setItems] = useState<Transfer[] | null>(null);
  const [creating, setCreating] = useState<Partial<Transfer> | null>(null);
  const [decision, setDecision] = useState<{ transfer: Transfer; status: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  async function load() {
    setItems((await api.get<{ transfers: Transfer[] }>('/transfers')).transfers);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function create() {
    if (!creating) return;
    setError('');
    try {
      await run(async () => { await api.post('/transfers', creating); await load(); });
      setCreating(null);
    } catch (e) { setError((e as Error).message); }
  }

  async function decide() {
    if (!decision) return;
    try {
      await run(async () => {
        await api.post(`/transfers/${decision.transfer.id}/status`, { status: decision.status });
        await load();
      });
      setDecision(null);
    } catch (e) { setError((e as Error).message); setDecision(null); }
  }

  if (!items) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Material Transfers"
        subtitle="Movements of parts between rigs and the yard."
        actions={can('canManageTransfers') && (
          <button className="btn-primary" onClick={() => setCreating({ date: todayIso(), quantity: 1, transferType: TYPES[0] })}>
            <Plus size={14} /> New transfer
          </button>
        )}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Number</th><th>Date</th><th>Material</th><th className="text-right">Qty</th>
              <th>Type</th><th>Source</th><th>Destination</th><th>Status</th><th>Raised by</th><th />
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td className="font-medium">{t.transferNumber}</td>
                <td className="whitespace-nowrap">{date(t.date)}</td>
                <td>{t.materialName}</td>
                <td className="num">{count(t.quantity)}{t.unit ? ` ${t.unit}` : ''}</td>
                <td className="text-xs">{t.transferType ?? '-'}</td>
                <td className="text-xs">{t.source ?? '-'}</td>
                <td className="text-xs">{t.destination ?? '-'}</td>
                <td>
                  <span className={
                    t.status === 'Approved' || t.status === 'Completed' ? 'pill-normal'
                      : t.status === 'Rejected' ? 'pill-overdue' : 'pill-upcoming'
                  }>{t.status}</span>
                </td>
                <td className="text-xs">{t.createdBy ?? '-'}</td>
                <td className="text-right whitespace-nowrap">
                  {can('canManageTransfers') && t.status === 'Pending' && (
                    <>
                      <button className="btn-ghost btn-sm mr-1" onClick={() => setDecision({ transfer: t, status: 'Approved' })}>
                        <Check size={12} /> Approve
                      </button>
                      <button className="btn-ghost btn-sm text-red-700" onClick={() => setDecision({ transfer: t, status: 'Rejected' })}>
                        <X size={12} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={10}><Empty message="No material transfers recorded." /></td></tr>}
          </tbody>
        </table>
      </div>

      <Modal open={!!creating} title="New material transfer" onClose={() => setCreating(null)}>
        {creating && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Transfer number" hint="Left blank, one is generated">
                <input className="input" value={creating.transferNumber ?? ''} onChange={(e) => setCreating({ ...creating, transferNumber: e.target.value })} />
              </Field>
              <Field label="Date"><input className="input" type="date" value={creating.date ?? ''} onChange={(e) => setCreating({ ...creating, date: e.target.value })} /></Field>
              <Field label="Material"><input className="input" value={creating.materialName ?? ''} onChange={(e) => setCreating({ ...creating, materialName: e.target.value })} /></Field>
              <Field label="Quantity">
                <input className="input" type="number" min={1} value={creating.quantity ?? 1}
                  onChange={(e) => setCreating({ ...creating, quantity: Number(e.target.value) })} />
              </Field>
              <Field label="Unit"><input className="input" value={creating.unit ?? ''} onChange={(e) => setCreating({ ...creating, unit: e.target.value })} /></Field>
              <Field label="Type">
                <select className="input" value={creating.transferType ?? ''} onChange={(e) => setCreating({ ...creating, transferType: e.target.value })}>
                  {TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Source"><input className="input" value={creating.source ?? ''} onChange={(e) => setCreating({ ...creating, source: e.target.value })} /></Field>
              <Field label="Destination"><input className="input" value={creating.destination ?? ''} onChange={(e) => setCreating({ ...creating, destination: e.target.value })} /></Field>
              <div className="col-span-2">
                <Field label="Remarks">
                  <textarea className="input" rows={2} value={creating.remarks ?? ''} onChange={(e) => setCreating({ ...creating, remarks: e.target.value })} />
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
        open={!!decision}
        title={`${decision?.status} this transfer?`}
        confirmLabel={decision?.status ?? 'Confirm'}
        tone={decision?.status === 'Rejected' ? 'danger' : 'primary'}
        busy={busy}
        body={
          <p>
            {decision?.transfer.transferNumber}: {count(decision?.transfer.quantity)} ×{' '}
            {decision?.transfer.materialName} from {decision?.transfer.source ?? 'unspecified'} to{' '}
            {decision?.transfer.destination ?? 'unspecified'}.
          </p>
        }
        onConfirm={() => void decide()}
        onCancel={() => setDecision(null)}
      />
    </div>
  );
}
