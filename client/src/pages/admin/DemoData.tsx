import { useEffect, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { api } from '../../lib/api';
import { date as fmtDate } from '../../lib/format';
import { ConfirmDialog, ErrorBox, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

interface DemoStatus { loaded: boolean; rigCount: number; loadedAt: string | null }
interface LoadResult { rigsCreated: number; usersCreated: number; reportsCreated: number; ilmMovementsCreated: number }

/**
 * Admin > Master > Demo Data: one click builds a complete, linked demo
 * fleet (2 rigs, 2 rig-scoped users, equipment, ~19 Daily Rig Reports each
 * and several ILM movements) through the exact same save functions the real
 * forms use — Excel import and manual entry both still write into these
 * same tables, untouched. One click removes exactly those rows again.
 */
export default function DemoData() {
  const [status, setStatus] = useState<DemoStatus | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<LoadResult | null>(null);
  const [cleared, setCleared] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, run] = useBusy();

  async function load() {
    setStatus(await api.get<DemoStatus>('/admin/demo/status'));
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function loadDemo() {
    setError(''); setResult(null); setCleared(false);
    try {
      const r = await run(() => api.post<LoadResult>('/admin/demo/load', {}));
      setResult(r);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function clearDemo() {
    setError(''); setResult(null);
    try {
      await run(() => api.post('/admin/demo/clear', {}));
      setCleared(true);
      await load();
    } catch (e) { setError((e as Error).message); }
    setConfirmClear(false);
  }

  if (!status) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Demo Data"
        subtitle="Load a complete, linked sample fleet to test the whole app — or clear it again — without touching any real data."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-5 mb-5">
        <div className="flex items-center gap-3 mb-4">
          <span className="shrink-0 h-10 w-10 rounded-lg grid place-items-center bg-violet-100 text-violet-600">
            <FlaskConical size={18} />
          </span>
          <div>
            <div className="font-semibold text-slate-900">{status.loaded ? 'Demo data is loaded' : 'No demo data loaded'}</div>
            <div className="text-xs text-slate-500">
              {status.loaded
                ? `${status.rigCount} demo rig(s), loaded ${status.loadedAt ? fmtDate(status.loadedAt) : ''}`
                : 'Click "Load Demo Data" to create a sample fleet.'}
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <button className="btn-primary" onClick={() => void loadDemo()} disabled={busy || status.loaded}>
            Load Demo Data
          </button>
          <button className="btn-ghost text-red-700" onClick={() => setConfirmClear(true)} disabled={busy || !status.loaded}>
            Clear Demo Data
          </button>
        </div>

        {cleared && <InfoBox>Demo data removed — every demo rig, user, equipment record, DPR/DRR/HSD report and ILM movement has been deleted. Real data was never touched.</InfoBox>}

        {result && (
          <InfoBox>
            Created 2 demo rigs (<strong>DEMO RIG-01</strong> Drilling, <strong>DEMO RIG-02</strong> Work-Over), 2 rig-scoped users,
            equipment for each rig, {result.reportsCreated} submitted Daily Rig Reports (feeding DPR, HSD/diesel, Mechanical Log
            and Lubricating/Hydraulic Oil together) and {result.ilmMovementsCreated} ILM movements with crane/trailer records and cost figures.
            <div className="mt-2 text-xs">
              Demo logins — username <code className="bg-white px-1 rounded">demo.rig01</code> / password{' '}
              <code className="bg-white px-1 rounded">Demo@12345</code> (sees only DEMO RIG-01), and{' '}
              <code className="bg-white px-1 rounded">demo.rig02</code> / same password (sees only DEMO RIG-02).
            </div>
          </InfoBox>
        )}
      </div>

      <div className="card p-5 text-sm text-slate-600 space-y-2">
        <h3 className="font-semibold text-slate-800">What gets created</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>2 rigs (in the PMS, DPR and ILM rig masters, bridged the same way real rigs are) and 2 users, each assigned to one rig</li>
          <li>3 pieces of equipment per rig (Equipment Master), with Make/Model/Serial and running hours that build up over time</li>
          <li>~19 submitted Daily Rig Reports per rig, spread across the last 8 weeks — each one writes into DPR, HSD/diesel, Mechanical Log and Oil/Hydraulic consumption together, exactly like a real DRR save</li>
          <li>A handful of ILM movements per rig with trailer loads, crane records, delay reasons and ILM Rate/Expenses (for the ILM cost/effective-day-rate figures)</li>
          <li>One new Oil &amp; Lubricant Master entry, alongside the existing real lubricant types reused for consumption</li>
        </ul>
        <p className="text-xs text-slate-500 pt-2">
          Every record is created through the same save functions the real forms and Excel import use — nothing is
          hardcoded into any dashboard. Clearing removes exactly what was created (found by the demo rigs, not by
          guessing) and never touches anything you entered yourself.
        </p>
      </div>

      <ConfirmDialog
        open={confirmClear}
        tone="danger"
        title="Clear all demo data?"
        confirmLabel="Clear demo data"
        busy={busy}
        body={<p>This removes the 2 demo rigs, their users, equipment, reports and ILM movements. Real data is never affected.</p>}
        onConfirm={() => void clearDemo()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
