import { useEffect, useState, type ReactNode } from 'react';
import { rigLabel } from '../../lib/rig';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { AlertTriangle, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { date, todayIso } from '../../lib/format';
import { ILM_DELAY_REASON_CATEGORIES } from '../../lib/types';
import type {
  IlmContractDurationResolution, IlmIndividual, IlmIndividualLine, IlmRig, IlmTransaction, IlmTransactionSummary,
} from '../../lib/types';
import { ConfirmDialog, ErrorBox, Field, InfoBox, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';
import { useAuth } from '../../lib/auth';

const blankIndividual: IlmIndividual = {
  area: '', operatorName: '', wellNo: '', movementFromWell: '', movementToWell: '',
  releaseDate: '', releaseTime: '', spudDate: '', spudTime: '', ilmRatePerDay: null, ilmExpenses: null,
  contractDateFrom: null, contractDateTo: null,
  movementDistanceKm: null, contractAllowedHours: null, contractAllowedDays: null, contractRuleId: null,
};


interface DelayForm { reasonForDelay: string; otherReason: string; remarks: string }
const blankDelayForm: DelayForm = { reasonForDelay: '', otherReason: '', remarks: '' };

function blankIndLine(lineNo: number): IlmIndividualLine {
  return {
    lineNo, reasonForDelay: '', totalDelayHours: null,
    hsdStockAccession: null, receivedQtyDuringIlm: null, hsdStockShiftEnd: null, totalHsdConsumption: null,
    ilmDistanceKm: null, totalLoadsMoved: null, cumulativeTrailerKm: null, avgConsumptionPerKm: null,
  };
}

interface NewLoadForm {
  mtGatePassNo: string; trailerNo: string; equipmentId: string | null; trailerType: string; capacityTon: number | null;
  arrivalDate: string; arrivalTime: string; loadingDate: string; loadingTime: string;
  loadDescription: string; totalPackages: number | null; unloadingDate: string; unloadingTime: string;
  driverName: string; driverContact: string;
}
const blankLoadForm: NewLoadForm = {
  mtGatePassNo: '', trailerNo: '', equipmentId: null, trailerType: '', capacityTon: null, arrivalDate: '', arrivalTime: '',
  loadingDate: '', loadingTime: '', loadDescription: '', totalPackages: null, unloadingDate: '', unloadingTime: '',
  driverName: '', driverContact: '',
};

interface NewCraneForm {
  craneNo: string; equipmentId: string | null; capacityTon: number | null; reportingDate: string; rigOrHired: string; registrationNo: string;
  arrivedDate: string; arrivedTime: string; releaseDate: string; releaseTime: string; transporterName: string;
  dayNo: number | null; shiftDate: string; dayShiftHrs: number | null; detailsJobDay: string;
  nightShiftHrs: number | null; detailsJobNight: string; breakdownHrs: number | null; cumulativeHrs: number | null;
  issuedHsdLtrs: number | null; totalWorkingHrs: number | null;
}
const blankCraneForm: NewCraneForm = {
  craneNo: '', equipmentId: null, capacityTon: null, reportingDate: '', rigOrHired: '', registrationNo: '', arrivedDate: '', arrivedTime: '',
  releaseDate: '', releaseTime: '', transporterName: '', dayNo: null, shiftDate: '', dayShiftHrs: null, detailsJobDay: '',
  nightShiftHrs: null, detailsJobNight: '', breakdownHrs: null, cumulativeHrs: null, issuedHsdLtrs: null, totalWorkingHrs: null,
};

/** The Equipment Master rows (category 'Crane'/'Trailer') bridged for this ILM rig — see server/src/routes/ilm.ts's equipmentForIlmRig(). */
function useIlmEquipment(ilmRigId: string | undefined, category: 'Crane' | 'Trailer') {
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!ilmRigId) { setOptions([]); return; }
    api.get<{ equipment: { id: string; name: string }[] }>(`/ilm/equipment?ilmRigId=${ilmRigId}&category=${category}`)
      .then((d) => setOptions(d.equipment)).catch(() => setOptions([]));
  }, [ilmRigId, category]);
  return options;
}

const CUSTOM_ILM_EQUIPMENT = '__custom__';

interface NewMovementForm { fleetReportAt: string; leadDistanceKm: number | null; allowedDurationHrs: number | null }
const blankMovementForm: NewMovementForm = { fleetReportAt: '', leadDistanceKm: null, allowedDurationHrs: null };

/**
 * Live preview of the rig's ILM Contract Duration Rule for a distance —
 * read-only, no side effects. The authoritative calculation happens again,
 * once, on the server when the movement is actually saved (never trusted
 * from this preview); this only lets the form show the number before Save.
 */
function useContractDurationPreview(ilmRigId: string | undefined, distanceKm: number | null) {
  const [preview, setPreview] = useState<IlmContractDurationResolution | null>(null);
  useEffect(() => {
    if (!ilmRigId || distanceKm === null || !Number.isFinite(distanceKm) || distanceKm < 0) { setPreview(null); return; }
    let cancelled = false;
    api.get<IlmContractDurationResolution>(`/ilm/contract-duration-rules/resolve?ilmRigId=${ilmRigId}&distanceKm=${distanceKm}`)
      .then((d) => { if (!cancelled) setPreview(d); })
      .catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [ilmRigId, distanceKm]);
  return preview;
}

/**
 * ILM Add's header-level ILM Contract Duration Rules preview — shown below
 * Release Date/Time, shared between the "New ILM" form and the "Edit
 * Header" form for an existing ILM. Read-only; the authoritative resolution
 * (and freeze onto ilm_individual) happens server-side in createIlm()/
 * updateIlmHeader() when the header is actually saved.
 */
function MovementDistanceAndContract({ individual, setIndividual, disabled, preview }: {
  individual: IlmIndividual; setIndividual: (v: IlmIndividual) => void; disabled: boolean;
  preview: IlmContractDurationResolution | null;
}) {
  const hasDistance = individual.movementDistanceKm !== null;
  return (
    <>
      <Field label="Movement Distance (KM)" hint="Loads this Rig's ILM Contract Duration Rules and previews the allowed duration below.">
        <input
          className="input" type="number" min={0} step="0.1" disabled={disabled}
          value={individual.movementDistanceKm ?? ''}
          onChange={(e) => setIndividual({ ...individual, movementDistanceKm: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </Field>
      <div /><div />
      {hasDistance && preview?.rule && (
        <>
          <Field label="Contract Distance (KM)">
            <input className="input bg-slate-50" disabled value={individual.movementDistanceKm ?? ''} />
          </Field>
          <Field label="Contract Allowed Hours">
            <input className="input bg-slate-50" disabled value={preview.allowedHours ?? ''} title="Auto-calculated from this Rig's Contract Duration Rule" />
          </Field>
          <Field label="Contract Allowed Days">
            <input className="input bg-slate-50" disabled value={preview.contractDays ?? ''} title="Contract Allowed Hours ÷ 24, auto-calculated" />
          </Field>
        </>
      )}
      {hasDistance && preview && !preview.rule && (
        <div className="md:col-span-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 mb-1">
          <AlertTriangle size={16} className="shrink-0" />
          No ILM contract rule configured for this Rig.
        </div>
      )}
    </>
  );
}

function hsdConsumption(accession: number | null, received: number | null, shiftEnd: number | null): number | null {
  if (accession === null || received === null || shiftEnd === null) return null;
  return Math.round((accession + received - shiftEnd) * 100) / 100;
}
function perKm(consumption: number | null, distanceKm: number | null): number | null {
  if (consumption === null || distanceKm === null || distanceKm === 0) return null;
  return Math.round((consumption / distanceKm) * 100) / 100;
}

/**
 * An ILM is a long-lived rig-relocation project (Active -> Completed), not a
 * single day's movement. This page: (1) starts one (header only), (2) lets
 * the user add as many Trailer Movement rounds and Crane Rounds as the
 * relocation actually takes — each one a permanent historical record, never
 * overwritten by the next — and (3) ends it, locking everything down while
 * keeping the full history visible. Manual entry and Excel import both write
 * through the same server functions (services/ilmLifecycle.ts), so both
 * read back identically here.
 */
export default function IlmEntry() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasModuleAction, isAdmin } = useAuth();
  const isNew = id === 'new';

  const [rigs, setRigs] = useState<IlmRig[]>([]);
  const [rigId, setRigId] = useState('');
  const [ilmDate, setIlmDate] = useState(todayIso());
  const [individual, setIndividual] = useState<IlmIndividual>(blankIndividual);
  const [indLines, setIndLines] = useState<IlmIndividualLine[]>([blankIndLine(1)]);
  const [txn, setTxn] = useState<IlmTransaction | null>(null);
  const [activeForRig, setActiveForRig] = useState<IlmTransactionSummary | null>(null);
  const [loaded, setLoaded] = useState(isNew);
  const [error, setError] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [delayPopupOpen, setDelayPopupOpen] = useState(false);
  const [delayForm, setDelayForm] = useState<DelayForm>(blankDelayForm);
  const [busy, run] = useBusy();

  const canCreate = hasModuleAction('ILM', 'create');
  const canEdit = hasModuleAction('ILM', 'edit');
  const isActive = txn?.status === 'Active';
  const canModify = !isNew && isActive && canEdit;

  useEffect(() => {
    api.get<{ rigs: IlmRig[] }>('/ilm/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  async function reloadTransaction(transactionId: string) {
    const d = await api.get<{ transaction: IlmTransaction }>(`/ilm/transactions/${transactionId}`);
    setTxn(d.transaction);
    setIndividual(d.transaction.individual ?? blankIndividual);
    setIndLines(d.transaction.individualLines.length ? d.transaction.individualLines : [blankIndLine(1)]);
  }

  useEffect(() => {
    if (isNew) return;
    reloadTransaction(id!).then(() => setLoaded(true)).catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew]);

  // New-ILM mode: warn (and block) if the chosen rig already has an Active ILM.
  useEffect(() => {
    if (!isNew || !rigId) { setActiveForRig(null); return; }
    api.get<{ transactions: IlmTransactionSummary[] }>(`/ilm/transactions?rigId=${rigId}&status=Active`)
      .then((d) => setActiveForRig(d.transactions[0] ?? null))
      .catch(() => setActiveForRig(null));
  }, [isNew, rigId]);

  // ILM Contract Duration Rules preview for the header — the rig comes from
  // whichever mode is active (New ILM's own rig picker, or the existing
  // ILM's fixed rig); re-resolves whenever the rig or the entered distance changes.
  const contractPreview = useContractDurationPreview(isNew ? rigId : txn?.rigId, individual.movementDistanceKm);

  function updateIndLine(index: number, patch: Partial<IlmIndividualLine>) {
    setIndLines((prev) => prev.map((l, i) => {
      if (i !== index) return l;
      const next = { ...l, ...patch };
      next.totalHsdConsumption = hsdConsumption(next.hsdStockAccession, next.receivedQtyDuringIlm, next.hsdStockShiftEnd);
      next.avgConsumptionPerKm = perKm(next.totalHsdConsumption, next.ilmDistanceKm);
      return next;
    }));
  }
  function addIndLine() { setIndLines((prev) => [...prev, blankIndLine(prev.length + 1)]); }
  function removeIndLine(index: number) { setIndLines((prev) => prev.filter((_, i) => i !== index).map((l, i) => ({ ...l, lineNo: i + 1 }))); }

  async function startIlm() {
    setError('');
    if (!rigId) { setError('Select a rig.'); return; }
    if (!ilmDate) { setError('Select an ILM start date.'); return; }
    if (activeForRig) { setError('An active ILM already exists for this Rig. Please continue the existing ILM.'); return; }
    try {
      const d = await run(() => api.post<{ transaction: IlmTransaction }>('/ilm/transactions', { rigId, date: ilmDate, individual }));
      navigate(`/ilm/entry/${d.transaction.id}`, { replace: true });
    } catch (e) { setError((e as Error).message); }
  }

  async function saveHeader() {
    setError('');
    const meaningfulIndLines = indLines.filter((l) => l.hsdStockAccession !== null || l.ilmDistanceKm !== null || l.totalLoadsMoved !== null || l.cumulativeTrailerKm !== null);
    try {
      await run(() => api.put(`/ilm/transactions/${id}`, { individual, individualLines: meaningfulIndLines }));
      await reloadTransaction(id!);
      // If this ILM has run past its Contract Date To and is still Active,
      // prompt for a Delay record — a nudge, not a hard block: the header
      // save above has already gone through either way.
      if (individual.contractDateTo && isActive && todayIso() > individual.contractDateTo) {
        setDelayForm(blankDelayForm);
        setDelayPopupOpen(true);
      }
    } catch (e) { setError((e as Error).message); }
  }

  const delayHours = individual.contractDateTo
    ? Math.max(0, Math.round(((Date.now() - new Date(individual.contractDateTo).getTime()) / 3600000) * 100) / 100)
    : null;

  async function saveDelayRecord() {
    setError('');
    if (!delayForm.reasonForDelay) { setError('Select a reason for the delay.'); return; }
    try {
      await run(() => api.post(`/ilm/transactions/${id}/delay-records`, {
        reasonForDelay: delayForm.reasonForDelay,
        otherReason: delayForm.reasonForDelay === 'Others' ? (delayForm.otherReason || null) : null,
        delayHours, remarks: delayForm.remarks || null,
      }));
      setDelayPopupOpen(false);
      setDelayForm(blankDelayForm);
      await reloadTransaction(id!);
    } catch (e) { setError((e as Error).message); }
  }

  async function endIlm() {
    try {
      await run(() => api.post(`/ilm/transactions/${id}/end`));
      setConfirmEnd(false);
      await reloadTransaction(id!);
    } catch (e) { setError((e as Error).message); }
  }

  async function reopenIlm() {
    try {
      await run(() => api.post(`/ilm/transactions/${id}/reopen`));
      await reloadTransaction(id!);
    } catch (e) { setError((e as Error).message); }
  }

  if (!loaded) return <Spinner />;

  const selectedRig = rigs.find((r) => r.id === (isNew ? rigId : txn?.rigId));

  if (isNew) {
    return (
      <div>
        <PageHeader title="New ILM" subtitle={!canCreate ? 'You do not have permission to start an ILM.' : undefined} />
        <ErrorBox message={error} onDismiss={() => setError('')} />
        {activeForRig && (
          <InfoBox>
            An active ILM already exists for this Rig. Please continue the existing ILM.{' '}
            <Link className="underline font-medium" to={`/ilm/entry/${activeForRig.id}`}>Open {activeForRig.ilmNumber}</Link>
          </InfoBox>
        )}
        <div className="card p-4 mb-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">ILM Header</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <Field label="Rig">
              <select className="input" disabled={!canCreate} value={rigId} onChange={(e) => setRigId(e.target.value)}>
                <option value="">Choose a rig...</option>
                {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
              </select>
            </Field>
            <div /><div />
            <Field label="Field">
              <input className="input" disabled={!canCreate} value={individual.area ?? ''} onChange={(e) => setIndividual({ ...individual, area: e.target.value })} />
            </Field>
            <Field label="Operator Name">
              <input className="input" disabled={!canCreate} value={individual.operatorName ?? ''} onChange={(e) => setIndividual({ ...individual, operatorName: e.target.value })} />
            </Field>
            <Field label="Well No.">
              <input className="input" disabled={!canCreate} value={individual.wellNo ?? ''} onChange={(e) => setIndividual({ ...individual, wellNo: e.target.value })} />
            </Field>
            <Field label="Current Well">
              <input className="input" disabled={!canCreate} value={individual.movementFromWell ?? ''} onChange={(e) => setIndividual({ ...individual, movementFromWell: e.target.value })} />
            </Field>
            <Field label="Next Well">
              <input className="input" disabled={!canCreate} value={individual.movementToWell ?? ''} onChange={(e) => setIndividual({ ...individual, movementToWell: e.target.value })} />
            </Field>
            <div />
            <Field label="Release Date" hint="Auto-mapped into every Trailer Movement round as its Old/New Location and Rig Release Date &amp; Time — a snapshot, taken fresh each time you add a round.">
              <input className="input" type="date" disabled={!canCreate} value={individual.releaseDate ?? ''} onChange={(e) => setIndividual({ ...individual, releaseDate: e.target.value })} />
            </Field>
            <Field label="Release Time">
              <input className="input" type="time" disabled={!canCreate} value={individual.releaseTime ?? ''} onChange={(e) => setIndividual({ ...individual, releaseTime: e.target.value })} />
            </Field>
            <div />
            <MovementDistanceAndContract individual={individual} setIndividual={setIndividual} disabled={!canCreate} preview={contractPreview} />
            <Field label="Spud Date">
              <input className="input" type="date" disabled={!canCreate} value={individual.spudDate ?? ''} onChange={(e) => setIndividual({ ...individual, spudDate: e.target.value })} />
            </Field>
            <Field label="Spud Time">
              <input className="input" type="time" disabled={!canCreate} value={individual.spudTime ?? ''} onChange={(e) => setIndividual({ ...individual, spudTime: e.target.value })} />
            </Field>
          </div>
        </div>
        {canCreate && (
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => navigate('/ilm/progress-report')}>Cancel</button>
            <button className="btn-primary" onClick={() => void startIlm()} disabled={busy || !!activeForRig}>
              <Save size={14} /> Save &amp; Start ILM
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!txn) return <Spinner />;

  return (
    <div>
      <PageHeader
        title={`${txn.ilmNumber} — ${selectedRig?.rigNumber ?? txn.rigNumber} · Started ${date(txn.date)}`}
        subtitle={!canEdit ? 'View only — you do not have permission to edit ILM entries.' : undefined}
        actions={
          <div className="flex items-center gap-2">
            <span className={`pill-engine ${isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'}`}>
              {isActive ? 'ACTIVE' : 'COMPLETED'}
            </span>
            {isActive && canEdit && (
              <button className="btn-danger btn-sm" onClick={() => setConfirmEnd(true)}>End ILM</button>
            )}
            {!isActive && isAdmin && (
              <button className="btn-ghost btn-sm" onClick={() => void reopenIlm()} disabled={busy}>Reopen ILM</button>
            )}
          </div>
        }
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      {!isActive && (
        <InfoBox>
          {txn.completedAt
            ? <>Completed {date(txn.endDate)} {txn.endTime ?? ''} by {txn.completedBy}.
                {txn.durationHours !== null && ` Total duration: ${txn.durationHours.toLocaleString('en-IN', { maximumFractionDigits: 1 })} hrs.`}{' '}</>
            : 'This ILM predates the End ILM feature, so no completion date/time was recorded. '}
          This ILM is locked — its history is preserved and can still be viewed and exported.
        </InfoBox>
      )}

      <div className="card p-4 mb-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">ILM Header</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <Field label="Rig"><input className="input bg-slate-50" disabled value={rigLabel({ name: txn.rigName, rigNumber: txn.rigNumber })} /></Field>
          <div /><div />
          <Field label="Field">
            <input className="input" disabled={!canModify} value={individual.area ?? ''} onChange={(e) => setIndividual({ ...individual, area: e.target.value })} />
          </Field>
          <Field label="Operator Name">
            <input className="input" disabled={!canModify} value={individual.operatorName ?? ''} onChange={(e) => setIndividual({ ...individual, operatorName: e.target.value })} />
          </Field>
          <Field label="Well No.">
            <input className="input" disabled={!canModify} value={individual.wellNo ?? ''} onChange={(e) => setIndividual({ ...individual, wellNo: e.target.value })} />
          </Field>
          <Field label="Current Well">
            <input className="input" disabled={!canModify} value={individual.movementFromWell ?? ''} onChange={(e) => setIndividual({ ...individual, movementFromWell: e.target.value })} />
          </Field>
          <Field label="Next Well">
            <input className="input" disabled={!canModify} value={individual.movementToWell ?? ''} onChange={(e) => setIndividual({ ...individual, movementToWell: e.target.value })} />
          </Field>
          <div />
          <Field label="Release Date" hint="Snapshotted into the next Trailer Movement round you add.">
            <input className="input" type="date" disabled={!canModify} value={individual.releaseDate ?? ''} onChange={(e) => setIndividual({ ...individual, releaseDate: e.target.value })} />
          </Field>
          <Field label="Release Time">
            <input className="input" type="time" disabled={!canModify} value={individual.releaseTime ?? ''} onChange={(e) => setIndividual({ ...individual, releaseTime: e.target.value })} />
          </Field>
          <div />
          <MovementDistanceAndContract individual={individual} setIndividual={setIndividual} disabled={!canModify} preview={contractPreview} />
          <Field label="Spud Date">
            <input className="input" type="date" disabled={!canModify} value={individual.spudDate ?? ''} onChange={(e) => setIndividual({ ...individual, spudDate: e.target.value })} />
          </Field>
          <Field label="Spud Time">
            <input className="input" type="time" disabled={!canModify} value={individual.spudTime ?? ''} onChange={(e) => setIndividual({ ...individual, spudTime: e.target.value })} />
          </Field>
        </div>
        {canModify && <button className="btn-primary btn-sm" onClick={() => void saveHeader()} disabled={busy}><Save size={12} /> Save Header</button>}
      </div>

      <div className="card mb-4">
        <div className="card-header">
          <h3 className="card-title">Fuel Log</h3>
          {canModify && <button className="btn-ghost btn-sm" onClick={addIndLine}><Plus size={12} /> Add Row</button>}
        </div>
        <div className="overflow-x-auto">
          <table className="table text-xs">
            <thead>
              <tr>
                <th>Opening HSD Stock (L)</th><th>Received Qty (L)</th>
                <th>HSD @ Shift End (L)</th><th>Total Consumption (L)</th><th>ILM Distance (KM)</th>
                <th>Total Loads Moved</th><th>Cumulative Trailer KM</th><th>Avg Consumption/KM</th>
                {canModify && <th />}
              </tr>
            </thead>
            <tbody>
              {indLines.map((l, i) => (
                <tr key={i}>
                  <Cell><input className="input" type="number" disabled={!canModify} value={l.hsdStockAccession ?? ''} onChange={(e) => updateIndLine(i, { hsdStockAccession: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                  <Cell><input className="input" type="number" disabled={!canModify} value={l.receivedQtyDuringIlm ?? ''} onChange={(e) => updateIndLine(i, { receivedQtyDuringIlm: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                  <Cell><input className="input" type="number" disabled={!canModify} value={l.hsdStockShiftEnd ?? ''} onChange={(e) => updateIndLine(i, { hsdStockShiftEnd: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                  <Cell><input className="input bg-slate-50" disabled value={l.totalHsdConsumption ?? ''} /></Cell>
                  <Cell><input className="input" type="number" disabled={!canModify} value={l.ilmDistanceKm ?? ''} onChange={(e) => updateIndLine(i, { ilmDistanceKm: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                  <Cell><input className="input" type="number" disabled={!canModify} value={l.totalLoadsMoved ?? ''} onChange={(e) => updateIndLine(i, { totalLoadsMoved: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                  <Cell><input className="input" type="number" disabled={!canModify} value={l.cumulativeTrailerKm ?? ''} onChange={(e) => updateIndLine(i, { cumulativeTrailerKm: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                  <Cell><input className="input bg-slate-50" disabled value={l.avgConsumptionPerKm ?? ''} /></Cell>
                  {canModify && (
                    <td className="whitespace-nowrap">
                      <button className="btn-ghost btn-sm text-red-700" onClick={() => removeIndLine(i)} disabled={indLines.length <= 1}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canModify && (
          <div className="px-4 py-3 border-t border-slate-200 flex justify-end">
            <button className="btn-primary btn-sm" onClick={() => void saveHeader()} disabled={busy}><Save size={12} /> Save Fuel Log</button>
          </div>
        )}
      </div>

      {txn.delayRecords.length > 0 && (
        <div className="card mb-4">
          <div className="card-header"><h3 className="card-title">Delay Log</h3></div>
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr><th>Reason</th><th>Delay (Hrs)</th><th>Remarks</th><th>Recorded By</th><th>Recorded At</th></tr>
              </thead>
              <tbody>
                {txn.delayRecords.map((d) => (
                  <tr key={d.id}>
                    <td>{d.reasonForDelay === 'Others' ? (d.otherReason || 'Others') : d.reasonForDelay}</td>
                    <td className="num">{d.delayHours ?? '-'}</td>
                    <td>{d.remarks ?? '-'}</td>
                    <td className="text-xs text-slate-500">{d.createdBy}</td>
                    <td className="text-xs text-slate-500 whitespace-nowrap">{d.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <TrailerMovements txn={txn} canModify={canModify} busy={busy} run={run} onChange={() => reloadTransaction(txn.id)} setError={setError} />
      <CraneRounds txn={txn} canModify={canModify} busy={busy} run={run} onChange={() => reloadTransaction(txn.id)} setError={setError} />

      <ConfirmDialog
        open={confirmEnd}
        tone="danger"
        title="End this ILM?"
        confirmLabel="End ILM"
        busy={busy}
        body={<p>Are you sure you want to end this ILM? After completion, new Trailer/Crane entries cannot be added.</p>}
        onConfirm={() => void endIlm()}
        onCancel={() => setConfirmEnd(false)}
      />

      <Modal open={delayPopupOpen} title="This ILM has run past its Contract Date" onClose={() => setDelayPopupOpen(false)} width="max-w-md">
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Log why, so this delay stays on record.</p>
          <Field label="Reason for Delay *">
            <select className="input" value={delayForm.reasonForDelay} onChange={(e) => setDelayForm({ ...delayForm, reasonForDelay: e.target.value })}>
              <option value="">Select...</option>
              {ILM_DELAY_REASON_CATEGORIES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          {delayForm.reasonForDelay === 'Others' && (
            <Field label="Please specify">
              <input className="input" value={delayForm.otherReason} onChange={(e) => setDelayForm({ ...delayForm, otherReason: e.target.value })} />
            </Field>
          )}
          <Field label="Delay Hours">
            <input className="input bg-slate-50" disabled value={delayHours ?? ''} title="Auto-calculated: hours past the Contract Date To" />
          </Field>
          <Field label="Remarks">
            <input className="input" value={delayForm.remarks} onChange={(e) => setDelayForm({ ...delayForm, remarks: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-ghost btn-sm" onClick={() => setDelayPopupOpen(false)}>Cancel</button>
            <button className="btn-primary btn-sm" onClick={() => void saveDelayRecord()} disabled={busy || !delayForm.reasonForDelay}>Save</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function TrailerMovements({ txn, canModify, busy, run, onChange, setError }: {
  txn: IlmTransaction; canModify: boolean; busy: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T>; onChange: () => void; setError: (m: string) => void;
}) {
  const [addingMovement, setAddingMovement] = useState(false);
  const [movementForm, setMovementForm] = useState<NewMovementForm>(blankMovementForm);
  /** null = not editing; loadId null = adding a new row to movementId; loadId set = editing that existing row in place. */
  const [editingLoad, setEditingLoad] = useState<{ movementId: string; loadId: string | null } | null>(null);
  const [loadForm, setLoadForm] = useState<NewLoadForm>(blankLoadForm);
  const trailerEquipment = useIlmEquipment(txn.rigId, 'Trailer');
  const contractPreview = useContractDurationPreview(txn.rigId, movementForm.leadDistanceKm);
  const noRuleForDistance = movementForm.leadDistanceKm !== null && contractPreview !== null && !contractPreview.rule;

  async function saveMovement() {
    try {
      const result = await run(() => api.post<{ contractWarning: boolean }>(`/ilm/transactions/${txn.id}/trailer-movements`, movementForm));
      setAddingMovement(false);
      setMovementForm(blankMovementForm);
      if (result.contractWarning) setError('Saved — but no active ILM Contract Duration Rule matched this rig/distance, so Allowed Duration was kept as entered manually. Configure one in Admin > Master > ILM Contract Duration Rules.');
      onChange();
    } catch (e) { setError((e as Error).message); }
  }
  function startAddLoad(movementId: string) {
    setEditingLoad({ movementId, loadId: null });
    setLoadForm(blankLoadForm);
  }
  function startEditLoad(movementId: string, l: (typeof txn.trailerMovements)[number]['loads'][number]) {
    setEditingLoad({ movementId, loadId: l.id! });
    setLoadForm({
      mtGatePassNo: l.mtGatePassNo ?? '', trailerNo: l.trailerNo ?? '', equipmentId: l.equipmentId, trailerType: l.trailerType ?? '',
      capacityTon: l.capacityTon, arrivalDate: l.arrivalDate ?? '', arrivalTime: l.arrivalTime ?? '',
      loadingDate: l.loadingDate ?? '', loadingTime: l.loadingTime ?? '', loadDescription: l.loadDescription ?? '',
      totalPackages: l.totalPackages, unloadingDate: l.unloadingDate ?? '', unloadingTime: l.unloadingTime ?? '',
      driverName: l.driverName ?? '', driverContact: l.driverContact ?? '',
    });
  }
  async function saveLoad() {
    if (!editingLoad) return;
    try {
      if (editingLoad.loadId) {
        await run(() => api.put(`/ilm/trailer-loads/${editingLoad.loadId}`, loadForm));
      } else {
        await run(() => api.post(`/ilm/trailer-movements/${editingLoad.movementId}/loads`, loadForm));
      }
      setEditingLoad(null);
      setLoadForm(blankLoadForm);
      onChange();
    } catch (e) { setError((e as Error).message); }
  }
  async function removeLoad(loadId: string) {
    try {
      await run(() => api.del(`/ilm/trailer-loads/${loadId}`));
      onChange();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="card mb-4">
      <div className="card-header">
        <h3 className="card-title">Trailer Movements</h3>
        {canModify && !addingMovement && (
          <button className="btn-ghost btn-sm" onClick={() => setAddingMovement(true)}><Plus size={12} /> Add Trailer Movement</button>
        )}
      </div>

      {addingMovement && (
        <div className="p-4 border-b border-slate-200 bg-slate-50">
          <div className="text-xs text-slate-500 mb-2">
            Old Location <strong>{txn.individual?.movementFromWell || '-'}</strong>, New Location <strong>{txn.individual?.movementToWell || '-'}</strong> and
            Rig Release Date &amp; Time will be copied automatically from the ILM header, as a snapshot for this round only.
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <Field label="Fleet Report Date &amp; Time">
              <input className="input" placeholder="DD/MM/YYYY HH:MM" value={movementForm.fleetReportAt}
                onChange={(e) => setMovementForm({ ...movementForm, fleetReportAt: e.target.value })} />
            </Field>
            <Field label="Lead Distance (KM)">
              <input className="input" type="number" value={movementForm.leadDistanceKm ?? ''}
                onChange={(e) => setMovementForm({ ...movementForm, leadDistanceKm: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
            <Field
              label="Allowed Duration (Hrs)"
              hint={contractPreview?.rule ? 'Auto-calculated from this rig\'s Contract Duration Rule' : undefined}
            >
              <input
                className={`input ${contractPreview?.rule ? 'bg-slate-50' : ''}`} type="number"
                disabled={!!contractPreview?.rule}
                value={contractPreview?.rule ? contractPreview.allowedHours ?? '' : movementForm.allowedDurationHrs ?? ''}
                onChange={(e) => setMovementForm({ ...movementForm, allowedDurationHrs: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
            {contractPreview?.rule && (
              <Field label="Contract Days" hint="Allowed Duration ÷ 24, auto-calculated">
                <input className="input bg-slate-50" disabled value={contractPreview.contractDays ?? ''} />
              </Field>
            )}
          </div>
          {noRuleForDistance && (
            <InfoBox>
              No active ILM Contract Duration Rule matches this rig for {movementForm.leadDistanceKm} KM — enter Allowed
              Duration manually, or configure one in Admin &gt; Master &gt; ILM Contract Duration Rules.
            </InfoBox>
          )}
          <div className="flex justify-end gap-2 pt-3">
            <button className="btn-ghost btn-sm" onClick={() => { setAddingMovement(false); setMovementForm(blankMovementForm); }}>Cancel</button>
            <button className="btn-primary btn-sm" onClick={() => void saveMovement()} disabled={busy}>Save Movement</button>
          </div>
        </div>
      )}

      {txn.trailerMovements.length === 0 && !addingMovement && (
        <div className="p-4 text-sm text-slate-400 text-center">No Trailer Movement rounds yet.</div>
      )}

      {txn.trailerMovements.map((m) => (
        <div key={m.id} className="border-b border-slate-200 last:border-b-0">
          <div className="px-4 py-2 bg-slate-50 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-xs text-slate-600">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span className="font-semibold text-slate-800">Movement #{m.movementNo}</span>
              <span>Old Location: <strong>{m.oldLocation || '-'}</strong></span>
              <span>New Location: <strong>{m.newLocation || '-'}</strong></span>
              <span>Rig Release: <strong>{m.rigReleaseAt || '-'}</strong></span>
              <span>Fleet Report: <strong>{m.fleetReportAt || '-'}</strong></span>
              <span>Lead Distance: <strong>{m.leadDistanceKm ?? '-'} KM</strong></span>
              <span>Allowed Duration: <strong>{m.allowedDurationHrs ?? '-'} Hrs</strong></span>
              {m.contractDays !== null && <span>Contract Days: <strong>{m.contractDays}</strong></span>}
              {m.contractRuleId === null && m.leadDistanceKm !== null && (
                <span className="text-amber-600">No Contract Duration Rule matched — entered manually</span>
              )}
            </div>
            {canModify && editingLoad?.movementId !== m.id && (
              <button className="btn-ghost btn-sm" onClick={() => startAddLoad(m.id)}><Plus size={12} /> Add Row</button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Sr No</th><th>MT/Gate Pass</th><th>Trailer No</th><th>Type</th><th>Capacity (Ton)</th>
                  <th>Loading Date</th><th>Loading Time</th><th>Load Description</th><th>Packages</th>
                  <th>Unloading Date</th><th>Unloading Time</th><th>Driver</th><th>Contact</th>
                  {canModify && <th />}
                </tr>
              </thead>
              <tbody>
                {m.loads.map((l) => (
                  editingLoad?.loadId === l.id ? (
                    <tr key={l.id}>
                      <Cell><span className="text-slate-400">{l.srNo}</span></Cell>
                      <Cell><input className="input" value={loadForm.mtGatePassNo} onChange={(e) => setLoadForm({ ...loadForm, mtGatePassNo: e.target.value })} /></Cell>
                      <Cell>
                        <select
                          className="input" value={loadForm.equipmentId ?? CUSTOM_ILM_EQUIPMENT}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === CUSTOM_ILM_EQUIPMENT) { setLoadForm({ ...loadForm, equipmentId: null }); return; }
                            const picked = trailerEquipment.find((eq) => eq.id === val);
                            setLoadForm({ ...loadForm, equipmentId: val, trailerNo: picked?.name ?? '' });
                          }}
                        >
                          <option value={CUSTOM_ILM_EQUIPMENT}>Custom / Other</option>
                          {trailerEquipment.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
                        </select>
                        {loadForm.equipmentId === null && (
                          <input className="input mt-1" placeholder="Trailer No" value={loadForm.trailerNo} onChange={(e) => setLoadForm({ ...loadForm, trailerNo: e.target.value })} />
                        )}
                      </Cell>
                      <Cell>
                        <select className="input" value={loadForm.trailerType} onChange={(e) => setLoadForm({ ...loadForm, trailerType: e.target.value })}>
                          <option value="">-</option><option value="HB">HB</option><option value="LB">LB</option><option value="SEMI">SEMI</option>
                        </select>
                      </Cell>
                      <Cell><input className="input" type="number" value={loadForm.capacityTon ?? ''} onChange={(e) => setLoadForm({ ...loadForm, capacityTon: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                      <Cell><input className="input" type="date" value={loadForm.loadingDate} onChange={(e) => setLoadForm({ ...loadForm, loadingDate: e.target.value })} /></Cell>
                      <Cell><input className="input" type="time" value={loadForm.loadingTime} onChange={(e) => setLoadForm({ ...loadForm, loadingTime: e.target.value })} /></Cell>
                      <Cell><input className="input min-w-[160px]" value={loadForm.loadDescription} onChange={(e) => setLoadForm({ ...loadForm, loadDescription: e.target.value })} /></Cell>
                      <Cell><input className="input" type="number" value={loadForm.totalPackages ?? ''} onChange={(e) => setLoadForm({ ...loadForm, totalPackages: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                      <Cell><input className="input" type="date" value={loadForm.unloadingDate} onChange={(e) => setLoadForm({ ...loadForm, unloadingDate: e.target.value })} /></Cell>
                      <Cell><input className="input" type="time" value={loadForm.unloadingTime} onChange={(e) => setLoadForm({ ...loadForm, unloadingTime: e.target.value })} /></Cell>
                      <Cell><input className="input" value={loadForm.driverName} onChange={(e) => setLoadForm({ ...loadForm, driverName: e.target.value })} /></Cell>
                      <Cell><input className="input" value={loadForm.driverContact} onChange={(e) => setLoadForm({ ...loadForm, driverContact: e.target.value })} /></Cell>
                      <td className="whitespace-nowrap flex gap-1">
                        <button className="btn-primary btn-sm" onClick={() => void saveLoad()} disabled={busy}>Save</button>
                        <button className="btn-ghost btn-sm" onClick={() => { setEditingLoad(null); setLoadForm(blankLoadForm); }}>Cancel</button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={l.id}>
                      <td>{l.srNo}</td><td>{l.mtGatePassNo}</td><td>{l.trailerNo}</td><td>{l.trailerType}</td>
                      <td className="num">{l.capacityTon ?? '-'}</td><td>{l.loadingDate}</td><td>{l.loadingTime}</td>
                      <td>{l.loadDescription}</td><td className="num">{l.totalPackages ?? '-'}</td>
                      <td>{l.unloadingDate}</td><td>{l.unloadingTime}</td><td>{l.driverName}</td><td>{l.driverContact}</td>
                      {canModify && (
                        <td className="whitespace-nowrap flex gap-1">
                          <button className="btn-ghost btn-sm" onClick={() => startEditLoad(m.id, l)}><Pencil size={12} /></button>
                          <button className="btn-ghost btn-sm text-red-700" onClick={() => void removeLoad(l.id!)}><Trash2 size={12} /></button>
                        </td>
                      )}
                    </tr>
                  )
                ))}
                {canModify && editingLoad?.movementId === m.id && editingLoad.loadId === null && (
                  <tr>
                    <Cell><span className="text-slate-400">auto</span></Cell>
                    <Cell><input className="input" value={loadForm.mtGatePassNo} onChange={(e) => setLoadForm({ ...loadForm, mtGatePassNo: e.target.value })} /></Cell>
                    <Cell>
                      <select
                        className="input" value={loadForm.equipmentId ?? CUSTOM_ILM_EQUIPMENT}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === CUSTOM_ILM_EQUIPMENT) { setLoadForm({ ...loadForm, equipmentId: null, trailerNo: '' }); return; }
                          const picked = trailerEquipment.find((eq) => eq.id === val);
                          setLoadForm({ ...loadForm, equipmentId: val, trailerNo: picked?.name ?? '' });
                        }}
                      >
                        <option value={CUSTOM_ILM_EQUIPMENT}>Custom / Other</option>
                        {trailerEquipment.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
                      </select>
                      {loadForm.equipmentId === null && (
                        <input className="input mt-1" placeholder="Trailer No" value={loadForm.trailerNo} onChange={(e) => setLoadForm({ ...loadForm, trailerNo: e.target.value })} />
                      )}
                    </Cell>
                    <Cell>
                      <select className="input" value={loadForm.trailerType} onChange={(e) => setLoadForm({ ...loadForm, trailerType: e.target.value })}>
                        <option value="">-</option><option value="HB">HB</option><option value="LB">LB</option><option value="SEMI">SEMI</option>
                      </select>
                    </Cell>
                    <Cell><input className="input" type="number" value={loadForm.capacityTon ?? ''} onChange={(e) => setLoadForm({ ...loadForm, capacityTon: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input" type="date" value={loadForm.loadingDate} onChange={(e) => setLoadForm({ ...loadForm, loadingDate: e.target.value })} /></Cell>
                    <Cell><input className="input" type="time" value={loadForm.loadingTime} onChange={(e) => setLoadForm({ ...loadForm, loadingTime: e.target.value })} /></Cell>
                    <Cell><input className="input min-w-[160px]" value={loadForm.loadDescription} onChange={(e) => setLoadForm({ ...loadForm, loadDescription: e.target.value })} /></Cell>
                    <Cell><input className="input" type="number" value={loadForm.totalPackages ?? ''} onChange={(e) => setLoadForm({ ...loadForm, totalPackages: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input" type="date" value={loadForm.unloadingDate} onChange={(e) => setLoadForm({ ...loadForm, unloadingDate: e.target.value })} /></Cell>
                    <Cell><input className="input" type="time" value={loadForm.unloadingTime} onChange={(e) => setLoadForm({ ...loadForm, unloadingTime: e.target.value })} /></Cell>
                    <Cell><input className="input" value={loadForm.driverName} onChange={(e) => setLoadForm({ ...loadForm, driverName: e.target.value })} /></Cell>
                    <Cell><input className="input" value={loadForm.driverContact} onChange={(e) => setLoadForm({ ...loadForm, driverContact: e.target.value })} /></Cell>
                    <td className="whitespace-nowrap flex gap-1">
                      <button className="btn-primary btn-sm" onClick={() => void saveLoad()} disabled={busy}>Save</button>
                      <button className="btn-ghost btn-sm" onClick={() => { setEditingLoad(null); setLoadForm(blankLoadForm); }}>Cancel</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function CraneRounds({ txn, canModify, busy, run, onChange, setError }: {
  txn: IlmTransaction; canModify: boolean; busy: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T>; onChange: () => void; setError: (m: string) => void;
}) {
  /** null = not editing; craneId null = adding a new row to roundId; craneId set = editing that existing row in place. */
  const [editingRecord, setEditingRecord] = useState<{ roundId: string; craneId: string | null } | null>(null);
  const [craneForm, setCraneForm] = useState<NewCraneForm>(blankCraneForm);
  const craneEquipment = useIlmEquipment(txn.rigId, 'Crane');

  const [addingRound, setAddingRound] = useState(false);
  const [roundForm, setRoundForm] = useState({ oldLocation: '', newLocation: '', locationType: '' });
  const [roundError, setRoundError] = useState('');

  function startAddRound() {
    setRoundForm({
      oldLocation: txn.individual?.movementFromWell ?? '', newLocation: txn.individual?.movementToWell ?? '',
      locationType: '',
    });
    setRoundError('');
    setAddingRound(true);
  }
  async function saveRound() {
    setRoundError('');
    if (roundForm.locationType === 'New Location' && !roundForm.newLocation.trim()) {
      setRoundError('Enter the new location.');
      return;
    }
    try {
      await run(() => api.post(`/ilm/transactions/${txn.id}/crane-rounds`, roundForm));
      setAddingRound(false);
      onChange();
    } catch (e) { setError((e as Error).message); }
  }
  function startAddRecord(roundId: string) {
    setEditingRecord({ roundId, craneId: null });
    setCraneForm(blankCraneForm);
  }
  function startEditRecord(roundId: string, c: (typeof txn.craneRounds)[number]['records'][number]) {
    setEditingRecord({ roundId, craneId: c.id! });
    setCraneForm({
      craneNo: c.craneNo ?? '', equipmentId: c.equipmentId, capacityTon: c.capacityTon, reportingDate: c.reportingDate ?? '',
      rigOrHired: c.rigOrHired ?? '', registrationNo: c.registrationNo ?? '', arrivedDate: c.arrivedDate ?? '', arrivedTime: c.arrivedTime ?? '',
      releaseDate: c.releaseDate ?? '', releaseTime: c.releaseTime ?? '', transporterName: c.transporterName ?? '',
      dayNo: c.dayNo, shiftDate: c.shiftDate ?? '', dayShiftHrs: c.dayShiftHrs, detailsJobDay: c.detailsJobDay ?? '',
      nightShiftHrs: c.nightShiftHrs, detailsJobNight: c.detailsJobNight ?? '', breakdownHrs: c.breakdownHrs, cumulativeHrs: c.cumulativeHrs,
      issuedHsdLtrs: c.issuedHsdLtrs, totalWorkingHrs: c.totalWorkingHrs,
    });
  }
  async function saveRecord() {
    if (!editingRecord) return;
    try {
      if (editingRecord.craneId) {
        await run(() => api.put(`/ilm/crane-records/${editingRecord.craneId}`, craneForm));
      } else {
        await run(() => api.post(`/ilm/crane-rounds/${editingRecord.roundId}/records`, craneForm));
      }
      setEditingRecord(null);
      setCraneForm(blankCraneForm);
      onChange();
    } catch (e) { setError((e as Error).message); }
  }
  async function removeRecord(craneId: string) {
    try {
      await run(() => api.del(`/ilm/crane-records/${craneId}`));
      onChange();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="card mb-4">
      <div className="card-header">
        <h3 className="card-title">Crane Rounds</h3>
        {canModify && !addingRound && (
          <button className="btn-ghost btn-sm" onClick={startAddRound}><Plus size={12} /> Add Crane Round</button>
        )}
      </div>

      {addingRound && (
        <div className="p-4 border-b border-slate-200 bg-slate-50">
          {roundError && <div className="text-xs text-red-600 mb-2">{roundError}</div>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <Field label="Location">
              <select
                className="input" value={roundForm.locationType}
                onChange={(e) => setRoundForm({ ...roundForm, locationType: e.target.value })}
              >
                <option value="">Choose...</option>
                <option value="Old Location">Old Location</option>
                <option value="New Location">New Location</option>
              </select>
            </Field>
            {roundForm.locationType === 'New Location' && (
              <Field label="Enter New Location">
                <input className="input" value={roundForm.newLocation} onChange={(e) => setRoundForm({ ...roundForm, newLocation: e.target.value })} />
              </Field>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost btn-sm" onClick={() => setAddingRound(false)}>Cancel</button>
            <button className="btn-primary btn-sm" onClick={() => void saveRound()} disabled={busy}>Save Round</button>
          </div>
        </div>
      )}

      {txn.craneRounds.length === 0 && !addingRound && (
        <div className="p-4 text-sm text-slate-400 text-center">No Crane Rounds yet.</div>
      )}

      {txn.craneRounds.map((r) => (
        <div key={r.id} className="border-b border-slate-200 last:border-b-0">
          <div className="px-4 py-2 bg-slate-50 flex flex-wrap items-center justify-between gap-x-6 gap-y-1 text-xs text-slate-600">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              <span className="font-semibold text-slate-800">Round #{r.roundNo}</span>
              <span>Old Location: <strong>{r.oldLocation || '-'}</strong></span>
              <span>New Location: <strong>{r.newLocation || '-'}</strong></span>
            </div>
            {canModify && editingRecord?.roundId !== r.id && (
              <button className="btn-ghost btn-sm" onClick={() => startAddRecord(r.id)}><Plus size={12} /> Add Row</button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Crane No</th><th>Capacity (Ton)</th><th>Reporting Date</th><th>Rig/Hired</th><th>Registration No</th>
                  <th>Arrived Date</th><th>Arrived Time</th><th>Release Date</th><th>Release Time</th><th>Transporter</th>
                  <th>Day Shift Hrs</th><th>Night Shift Hrs</th><th>Breakdown Hrs</th><th>Issued HSD (L)</th><th>Total Working Hrs</th>
                  {canModify && <th />}
                </tr>
              </thead>
              <tbody>
                {r.records.map((c) => (
                  editingRecord?.craneId === c.id ? (
                    <tr key={c.id}>
                      <Cell>
                        <select
                          className="input" value={craneForm.equipmentId ?? CUSTOM_ILM_EQUIPMENT}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === CUSTOM_ILM_EQUIPMENT) { setCraneForm({ ...craneForm, equipmentId: null }); return; }
                            const picked = craneEquipment.find((eq) => eq.id === val);
                            setCraneForm({ ...craneForm, equipmentId: val, craneNo: picked?.name ?? '' });
                          }}
                        >
                          <option value={CUSTOM_ILM_EQUIPMENT}>Custom / Other</option>
                          {craneEquipment.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
                        </select>
                        {craneForm.equipmentId === null && (
                          <input className="input mt-1" placeholder="Crane No" value={craneForm.craneNo} onChange={(e) => setCraneForm({ ...craneForm, craneNo: e.target.value })} />
                        )}
                      </Cell>
                      <Cell><input className="input" type="number" value={craneForm.capacityTon ?? ''} onChange={(e) => setCraneForm({ ...craneForm, capacityTon: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                      <Cell><input className="input" type="date" value={craneForm.reportingDate} onChange={(e) => setCraneForm({ ...craneForm, reportingDate: e.target.value })} /></Cell>
                      <Cell>
                        <select className="input" value={craneForm.rigOrHired} onChange={(e) => setCraneForm({ ...craneForm, rigOrHired: e.target.value })}>
                          <option value="">-</option><option value="Rig">Rig</option><option value="Hired">Hired</option>
                        </select>
                      </Cell>
                      <Cell><input className="input" value={craneForm.registrationNo} onChange={(e) => setCraneForm({ ...craneForm, registrationNo: e.target.value })} /></Cell>
                      <Cell><input className="input" type="date" value={craneForm.arrivedDate} onChange={(e) => setCraneForm({ ...craneForm, arrivedDate: e.target.value })} /></Cell>
                      <Cell><input className="input" type="time" value={craneForm.arrivedTime} onChange={(e) => setCraneForm({ ...craneForm, arrivedTime: e.target.value })} /></Cell>
                      <Cell><input className="input" type="date" value={craneForm.releaseDate} onChange={(e) => setCraneForm({ ...craneForm, releaseDate: e.target.value })} /></Cell>
                      <Cell><input className="input" type="time" value={craneForm.releaseTime} onChange={(e) => setCraneForm({ ...craneForm, releaseTime: e.target.value })} /></Cell>
                      <Cell><input className="input" value={craneForm.transporterName} onChange={(e) => setCraneForm({ ...craneForm, transporterName: e.target.value })} /></Cell>
                      <Cell><input className="input" type="number" value={craneForm.dayShiftHrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, dayShiftHrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                      <Cell><input className="input" type="number" value={craneForm.nightShiftHrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, nightShiftHrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                      <Cell><input className="input" type="number" value={craneForm.breakdownHrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, breakdownHrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                      <Cell><input className="input" type="number" value={craneForm.issuedHsdLtrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, issuedHsdLtrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                      <Cell><input className="input" type="number" value={craneForm.totalWorkingHrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, totalWorkingHrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                      <td className="whitespace-nowrap flex gap-1">
                        <button className="btn-primary btn-sm" onClick={() => void saveRecord()} disabled={busy}>Save</button>
                        <button className="btn-ghost btn-sm" onClick={() => { setEditingRecord(null); setCraneForm(blankCraneForm); }}>Cancel</button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.id}>
                      <td>{c.craneNo}</td><td className="num">{c.capacityTon ?? '-'}</td><td>{c.reportingDate}</td>
                      <td>{c.rigOrHired}</td><td>{c.registrationNo}</td><td>{c.arrivedDate}</td><td>{c.arrivedTime}</td>
                      <td>{c.releaseDate}</td><td>{c.releaseTime}</td><td>{c.transporterName}</td>
                      <td className="num">{c.dayShiftHrs ?? '-'}</td><td className="num">{c.nightShiftHrs ?? '-'}</td>
                      <td className="num">{c.breakdownHrs ?? '-'}</td><td className="num">{c.issuedHsdLtrs ?? '-'}</td>
                      <td className="num">{c.totalWorkingHrs ?? '-'}</td>
                      {canModify && (
                        <td className="whitespace-nowrap flex gap-1">
                          <button className="btn-ghost btn-sm" onClick={() => startEditRecord(r.id, c)}><Pencil size={12} /></button>
                          <button className="btn-ghost btn-sm text-red-700" onClick={() => void removeRecord(c.id!)}><Trash2 size={12} /></button>
                        </td>
                      )}
                    </tr>
                  )
                ))}
                {canModify && editingRecord?.roundId === r.id && editingRecord.craneId === null && (
                  <tr>
                    <Cell>
                      <select
                        className="input" value={craneForm.equipmentId ?? CUSTOM_ILM_EQUIPMENT}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === CUSTOM_ILM_EQUIPMENT) { setCraneForm({ ...craneForm, equipmentId: null, craneNo: '' }); return; }
                          const picked = craneEquipment.find((eq) => eq.id === val);
                          setCraneForm({ ...craneForm, equipmentId: val, craneNo: picked?.name ?? '' });
                        }}
                      >
                        <option value={CUSTOM_ILM_EQUIPMENT}>Custom / Other</option>
                        {craneEquipment.map((eq) => <option key={eq.id} value={eq.id}>{eq.name}</option>)}
                      </select>
                      {craneForm.equipmentId === null && (
                        <input className="input mt-1" placeholder="Crane No" value={craneForm.craneNo} onChange={(e) => setCraneForm({ ...craneForm, craneNo: e.target.value })} />
                      )}
                    </Cell>
                    <Cell><input className="input" type="number" value={craneForm.capacityTon ?? ''} onChange={(e) => setCraneForm({ ...craneForm, capacityTon: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input" type="date" value={craneForm.reportingDate} onChange={(e) => setCraneForm({ ...craneForm, reportingDate: e.target.value })} /></Cell>
                    <Cell>
                      <select className="input" value={craneForm.rigOrHired} onChange={(e) => setCraneForm({ ...craneForm, rigOrHired: e.target.value })}>
                        <option value="">-</option><option value="Rig">Rig</option><option value="Hired">Hired</option>
                      </select>
                    </Cell>
                    <Cell><input className="input" value={craneForm.registrationNo} onChange={(e) => setCraneForm({ ...craneForm, registrationNo: e.target.value })} /></Cell>
                    <Cell><input className="input" type="date" value={craneForm.arrivedDate} onChange={(e) => setCraneForm({ ...craneForm, arrivedDate: e.target.value })} /></Cell>
                    <Cell><input className="input" type="time" value={craneForm.arrivedTime} onChange={(e) => setCraneForm({ ...craneForm, arrivedTime: e.target.value })} /></Cell>
                    <Cell><input className="input" type="date" value={craneForm.releaseDate} onChange={(e) => setCraneForm({ ...craneForm, releaseDate: e.target.value })} /></Cell>
                    <Cell><input className="input" type="time" value={craneForm.releaseTime} onChange={(e) => setCraneForm({ ...craneForm, releaseTime: e.target.value })} /></Cell>
                    <Cell><input className="input" value={craneForm.transporterName} onChange={(e) => setCraneForm({ ...craneForm, transporterName: e.target.value })} /></Cell>
                    <Cell><input className="input" type="number" value={craneForm.dayShiftHrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, dayShiftHrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input" type="number" value={craneForm.nightShiftHrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, nightShiftHrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input" type="number" value={craneForm.breakdownHrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, breakdownHrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input" type="number" value={craneForm.issuedHsdLtrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, issuedHsdLtrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input" type="number" value={craneForm.totalWorkingHrs ?? ''} onChange={(e) => setCraneForm({ ...craneForm, totalWorkingHrs: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <td className="whitespace-nowrap flex gap-1">
                      <button className="btn-primary btn-sm" onClick={() => void saveRecord()} disabled={busy}>Save</button>
                      <button className="btn-ghost btn-sm" onClick={() => { setEditingRecord(null); setCraneForm(blankCraneForm); }}>Cancel</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function Cell({ children }: { children: ReactNode }) {
  return <td className="min-w-[70px]">{children}</td>;
}
