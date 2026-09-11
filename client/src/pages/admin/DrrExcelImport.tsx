import { useEffect, useRef, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload as UploadIcon } from 'lucide-react';
import { api, download } from '../../lib/api';
import { count, date, dateTime, todayIso } from '../../lib/format';
import type { DrrImportBatch, DrrImportPreview, Rig } from '../../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

/**
 * Admin-only bulk alternative to the manual DRR form (DRR -> New Daily
 * Report). Every import goes through the same saveReport() path a manual
 * submission uses (routes/dailyRigReport.ts) — this page only previews what
 * was parsed and lets an admin confirm it. Never linked from any non-admin
 * nav; the server also hard-requires Admin on every /api/drr-import route.
 */
export default function DrrExcelImport() {
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [rigId, setRigId] = useState('');
  const [templateDate, setTemplateDate] = useState(todayIso());
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DrrImportPreview | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ recordCount: number } | null>(null);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [history, setHistory] = useState<DrrImportBatch[] | null>(null);
  const [busy, run] = useBusy();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
    void loadHistory();
  }, []);

  async function loadHistory() {
    try {
      const d = await api.get<{ batches: DrrImportBatch[] }>('/drr-import/history');
      setHistory(d.batches);
    } catch (e) { setError((e as Error).message); }
  }

  async function doPreview() {
    if (!rigId || !file) return;
    setError(''); setPreview(null); setSuccess(null);
    const form = new FormData();
    form.append('file', file);
    form.append('rigId', rigId);
    try {
      const data = await run(() => api.form<DrrImportPreview>('/drr-import/preview', form));
      setPreview(data);
    } catch (e) { setError((e as Error).message); }
  }

  async function doConfirm() {
    if (!preview?.planId) return;
    setError('');
    try {
      await run(() => api.post(`/drr-import/import/${preview.planId}`, {}));
      const recordCount = (preview.preview?.equipmentLines.length ?? 0) + (preview.preview?.oilLines.length ?? 0)
        + (preview.preview?.hydraulicLines.length ?? 0) + (preview.preview?.dprLines.length ?? 0);
      setSuccess({ recordCount });
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setConfirmingReplace(false);
      void loadHistory();
    } catch (e) {
      setConfirmingReplace(false);
      setError((e as Error).message);
    }
  }

  const selectedRig = rigs.find((r) => r.id === rigId);
  const fatalIssues = preview?.issues.filter((i) => i.level === 'fatal') ?? [];
  const warnings = preview?.issues.filter((i) => i.level === 'warning') ?? [];
  const canConfirm = !!preview?.planId && fatalIssues.length === 0;

  return (
    <div>
      <PageHeader
        title="DRR Excel Import"
        subtitle="Admin-only bulk entry for Daily Rig Reports — every import writes through the exact same path a manual DRR submission uses."
        actions={
          <button
            className="btn-ghost"
            disabled={!rigId || !templateDate}
            onClick={() => rigId && void download(`/drr-import/template/${rigId}?date=${templateDate}`, 'DRR_Template.xlsx')}
          >
            <Download size={14} /> Download {selectedRig ? `${selectedRig.rigNumber} ` : ''}DRR Template
          </button>
        }
      />

      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-4 mb-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Select Rig">
            <select className="input" value={rigId} onChange={(e) => { setRigId(e.target.value); setPreview(null); setSuccess(null); }}>
              <option value="">Choose a rig...</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          </Field>
          <Field label="Template Date">
            <input className="input" type="date" value={templateDate} onChange={(e) => setTemplateDate(e.target.value)} />
          </Field>
          <Field label="Upload Completed Excel" hint={file ? file.name : 'No file chosen'}>
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setSuccess(null); }}
            />
            <button className="btn-ghost w-full justify-center" onClick={() => fileRef.current?.click()} disabled={!rigId}>
              <FileSpreadsheet size={14} /> Choose Excel File
            </button>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-primary" disabled={!rigId || !file || busy} onClick={() => void doPreview()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <UploadIcon size={14} />}
            PREVIEW
          </button>
        </div>

        {success && (
          <InfoBox>
            <div className="flex items-center gap-2 text-emerald-800">
              <CheckCircle2 size={16} /> Import successful — {count(success.recordCount)} record(s) saved. The report is now visible in DRR, the DPR Dashboard, HSD Report and PMS Service History.
            </div>
          </InfoBox>
        )}
      </div>

      {preview && (
        <div className="card p-4 mb-4 space-y-4">
          <h3 className="text-sm font-semibold text-slate-800">Preview — {preview.rig.rigNumber}</h3>

          {fatalIssues.length > 0 && (
            <div className="border border-red-200 bg-red-50 rounded-md p-3">
              <div className="flex items-center gap-2 text-red-800 font-medium text-sm mb-2">
                <AlertTriangle size={14} /> This file cannot be imported
              </div>
              <ul className="text-sm text-red-800 space-y-1 list-disc list-inside">
                {fatalIssues.map((i, n) => <li key={n} className="whitespace-pre-wrap">{i.row ? `Row ${i.row}: ` : ''}{i.message}</li>)}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="border border-amber-200 bg-amber-50 rounded-md p-3">
              <div className="flex items-center gap-2 text-amber-800 font-medium text-sm mb-2">
                <AlertTriangle size={14} /> Warnings
              </div>
              <ul className="text-sm text-amber-800 space-y-1 list-disc list-inside">
                {warnings.map((i, n) => <li key={n}>{i.message}</li>)}
              </ul>
            </div>
          )}

          {preview.preview && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div><div className="text-[11px] text-slate-500">Date</div>{date(preview.preview.reportDate)}</div>
                <div><div className="text-[11px] text-slate-500">Well No.</div>{preview.preview.wellNo || '-'}</div>
                <div><div className="text-[11px] text-slate-500">Shift</div>{preview.preview.shift}</div>
                <div><div className="text-[11px] text-slate-500">HSD Received</div>{fmt(preview.preview.hsdReceived)}</div>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">DPR Activity ({preview.preview.dprLines.length})</div>
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead><tr><th>Well</th><th>Operation</th><th>Work Type</th><th>Start</th><th>End</th></tr></thead>
                    <tbody>
                      {preview.preview.dprLines.map((l, i) => (
                        <tr key={i}><td>{l.wellName ?? '-'}</td><td>{l.operationCode ?? '-'}</td><td>{l.workType ?? '-'}</td><td>{l.startTime ?? '-'}</td><td>{l.endTime ?? '-'}</td></tr>
                      ))}
                      {preview.preview.dprLines.length === 0 && <tr><td colSpan={5}><Empty message="No activity rows in this file." /></td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">Equipment Running Hours ({preview.preview.equipmentLines.length})</div>
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead><tr><th className="text-right">Day Hrs</th><th className="text-right">Night Hrs</th><th className="text-right">HSD</th><th>Status</th><th>Service</th></tr></thead>
                    <tbody>
                      {preview.preview.equipmentLines.map((l, i) => (
                        <tr key={i}>
                          <td className="num">{fmt(l.dayHours)}</td><td className="num">{fmt(l.nightHours)}</td>
                          <td className="num">{fmt(l.hsdConsumption)}</td><td>{l.status}</td>
                          <td>{l.serviceDoneToday ? `Yes (${fmt(l.serviceHours)})` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-600 mb-1">Lubricating Oil ({preview.preview.oilLines.length})</div>
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead><tr><th>Oil Type</th><th className="text-right">Opening</th><th className="text-right">Added</th><th className="text-right">Consumed</th></tr></thead>
                    <tbody>
                      {preview.preview.oilLines.map((l, i) => (
                        <tr key={i}><td>{l.oilType}</td><td className="num">{fmt(l.openingBalance)}</td><td className="num">{fmt(l.oilAdded)}</td><td className="num">{fmt(l.oilConsumed)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          <div className="flex justify-end">
            <button
              className="btn-primary"
              disabled={!canConfirm || busy}
              onClick={() => (preview.duplicate ? setConfirmingReplace(true) : void doConfirm())}
            >
              Confirm Import
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header"><h3 className="card-title">Import History</h3></div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>File</th><th>Rig</th><th>Date</th><th>Uploaded</th><th>By</th>
                <th className="text-right">Records</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {!history ? (
                <tr><td colSpan={8}><Spinner /></td></tr>
              ) : history.length === 0 ? (
                <tr><td colSpan={8}><Empty message="No DRR files have been uploaded yet." /></td></tr>
              ) : history.map((b) => (
                <tr key={b.id}>
                  <td className="max-w-[200px] truncate" title={b.fileName}>{b.fileName}</td>
                  <td className="whitespace-nowrap">{b.rigNumber}</td>
                  <td className="whitespace-nowrap text-xs">{b.reportDate ? date(b.reportDate) : '-'}</td>
                  <td className="whitespace-nowrap text-xs">{dateTime(b.uploadedAt)}</td>
                  <td className="text-xs">{b.uploadedBy}</td>
                  <td className="num">{count(b.recordCount)}</td>
                  <td><span className={b.status === 'Successful' ? 'pill-normal' : 'pill-overdue'}>{b.status}</span></td>
                  <td className="text-right">
                    {b.errorDetail && b.errorDetail.length > 0 && (
                      <details className="inline-block text-left">
                        <summary className="text-xs text-rig-700 cursor-pointer">Details</summary>
                        <ul className="text-[11px] text-slate-600 mt-1 list-disc list-inside">
                          {b.errorDetail.map((i, n) => <li key={n}>{i.message}</li>)}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={confirmingReplace}
        tone="danger"
        title="A Daily Rig Report already exists for this rig/date/shift"
        confirmLabel="Replace it"
        busy={busy}
        body={<p>{preview?.duplicate?.message}</p>}
        onConfirm={() => void doConfirm()}
        onCancel={() => setConfirmingReplace(false)}
      />
    </div>
  );
}
