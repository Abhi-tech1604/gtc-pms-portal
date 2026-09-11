import { useEffect, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { useNavigate, useParams } from 'react-router-dom';
import { Save } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { count, date, todayIso } from '../../lib/format';
import type { DprLineItem, DprReport, DprReportSummary, DprRig } from '../../lib/types';
import { ConfirmDialog, ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import DprLineItemsEditor, { blankDprLine } from '../../components/DprLineItemsEditor';

/**
 * Manual DPR entry, mapped field-for-field from the Excel template (spec 11)
 * — the same fields Excel import produces, saved through the same API the
 * import commit uses server-side, so both sources read back identically.
 */
export default function DprEntry() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasModuleAction } = useAuth();
  const isNew = id === 'new';
  const canEdit = isNew ? hasModuleAction('DPR', 'create') : hasModuleAction('DPR', 'edit');

  const [rigs, setRigs] = useState<DprRig[]>([]);
  const [rigId, setRigId] = useState('');
  const [dprDate, setDprDate] = useState(todayIso());
  const [lines, setLines] = useState<DprLineItem[]>([blankDprLine(1)]);
  const [loaded, setLoaded] = useState(isNew);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<{ reportId: string; message: string } | null>(null);
  const [busy, run] = useBusy();

  // Rig -> DPR data set -> Equipment Master flow: once a rig is picked, load
  // that rig's own DPR history (shown above the activity table) and its
  // active equipment from Equipment Master (the Breakdown Equipment
  // dropdown) — both re-fetched fresh on every rig change, never cached
  // into a second equipment list.
  const [rigReports, setRigReports] = useState<DprReportSummary[] | null>(null);
  const [equipmentOptions, setEquipmentOptions] = useState<{ id: string; name: string }[]>([]);
  const [equipmentLinked, setEquipmentLinked] = useState(true);

  useEffect(() => {
    api.get<{ rigs: DprRig[] }>('/dpr/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (isNew) return;
    api.get<{ report: DprReport }>(`/dpr/reports/${id}`)
      .then((d) => {
        setRigId(d.report.rigId);
        setDprDate(d.report.dprDate);
        setLines(d.report.lines.length ? d.report.lines : [blankDprLine(1)]);
        setLoaded(true);
      })
      .catch((e) => setError((e as Error).message));
  }, [id, isNew]);

  useEffect(() => {
    if (!rigId) { setRigReports(null); setEquipmentOptions([]); setEquipmentLinked(true); return; }
    api.get<{ reports: DprReportSummary[] }>(`/dpr/reports?rigId=${rigId}`)
      .then((d) => setRigReports(d.reports))
      .catch((e) => setError((e as Error).message));
    api.get<{ equipment: { id: string; name: string }[]; linked: boolean }>(`/dpr/equipment?rigId=${rigId}`)
      .then((d) => { setEquipmentOptions(d.equipment); setEquipmentLinked(d.linked); })
      .catch((e) => setError((e as Error).message));
  }, [rigId]);

  async function save(confirmReplace = false) {
    setError('');
    if (!rigId) { setError('Select a rig.'); return; }
    if (!dprDate) { setError('Select a DPR date.'); return; }
    const meaningful = lines.filter((l) => l.wellName || l.operationCode || l.startTime || l.endTime || l.description);
    if (meaningful.length === 0) { setError('Add at least one activity row.'); return; }

    const payload = { rigId, dprDate, lines: meaningful, confirmReplace };
    try {
      await run(() => (
        isNew
          ? api.post<{ report: DprReport }>('/dpr/reports', payload)
          : api.put<{ report: DprReport }>(`/dpr/reports/${id}`, payload)
      ));
      navigate('/dpr/progress-report');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const d = e.details as { duplicateReportId?: string } | undefined;
        if (d?.duplicateReportId) { setDuplicate({ reportId: d.duplicateReportId, message: e.message }); return; }
      }
      setError((e as Error).message);
    }
  }

  if (!loaded) return <Spinner />;

  const selectedRig = rigs.find((r) => r.id === rigId);

  return (
    <div>
      <PageHeader
        title={isNew ? 'New DPR' : `DPR — ${selectedRig?.rigNumber ?? ''} · ${date(dprDate)}`}
        subtitle={!canEdit ? 'View only — you do not have permission to edit DPR entries.' : undefined}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-4 mb-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">DPR Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Rig">
            <select className="input" value={rigId} disabled={!isNew || !canEdit}
              onChange={(e) => setRigId(e.target.value)}>
              <option value="">Choose a rig...</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          </Field>
          <Field label="DPR Date">
            <input className="input" type="date" value={dprDate} disabled={!canEdit}
              onChange={(e) => setDprDate(e.target.value)} />
          </Field>
        </div>
      </div>

      {rigId && (
        <div className="card p-4 mb-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">DPR Data Set — {selectedRig?.rigNumber}</h3>
          {!rigReports ? (
            <Spinner label="Loading this rig's DPR history..." />
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600">
              <span><span className="font-medium text-slate-900">{count(rigReports.length)}</span> DPR report(s) on record for this rig</span>
              <span>Last DPR: <span className="font-medium text-slate-900">{rigReports[0] ? date(rigReports[0].dprDate) : 'None yet'}</span></span>
            </div>
          )}
          {!equipmentLinked && (
            <div className="mt-2 text-xs text-amber-700">
              No matching Equipment Master rig for {selectedRig?.rigNumber} — the Breakdown Equipment list will be empty until an admin adds it in DPR Rig Master with a matching rig number.
            </div>
          )}
        </div>
      )}

      <DprLineItemsEditor lines={lines} canEdit={canEdit} onChange={setLines} equipmentOptions={equipmentOptions} />

      {canEdit && (
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => navigate('/dpr/progress-report')}>Cancel</button>
          <button className="btn-primary" onClick={() => void save(false)} disabled={busy}>
            <Save size={14} /> Save DPR
          </button>
        </div>
      )}

      {!canEdit && (
        <InfoBox>Ask an administrator for DPR {isNew ? 'create' : 'edit'} access to save changes here.</InfoBox>
      )}

      <ConfirmDialog
        open={!!duplicate}
        tone="danger"
        title="A DPR for this rig and date already exists"
        confirmLabel="Replace it"
        busy={busy}
        body={<p>{duplicate?.message}</p>}
        onConfirm={() => void save(true)}
        onCancel={() => setDuplicate(null)}
      />
    </div>
  );
}
