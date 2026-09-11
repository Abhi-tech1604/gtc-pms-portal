import { useEffect, useRef, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload as UploadIcon } from 'lucide-react';
import { api, ApiError, download } from '../../lib/api';
import { count, currentMonth, date, dateTime, monthLabel } from '../../lib/format';
import type { DprIssue, DprRig, HsdImportBatch, HsdReportSummary } from '../../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

/**
 * HSD diesel consumption upload — deliberately the same one rig, one month,
 * one file, one button shape as the DPR pane next to it, backed by /api/hsd
 * instead of /api/dpr. Validation runs across every day-sheet on that single
 * click and nothing is saved unless the whole workbook passes.
 */
export default function HsdDataImport() {
  const [rigs, setRigs] = useState<DprRig[]>([]);
  const [rigId, setRigId] = useState('');
  const [month, setMonth] = useState(currentMonth());
  const [file, setFile] = useState<File | null>(null);
  const [issues, setIssues] = useState<DprIssue[]>([]);
  const [success, setSuccess] = useState<{ daysImported: number; equipmentRows: number } | null>(null);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<{ dates: string[]; message: string } | null>(null);
  const [history, setHistory] = useState<HsdImportBatch[] | null>(null);
  const [imported, setImported] = useState<HsdReportSummary[]>([]);
  const [busy, run] = useBusy();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ rigs: DprRig[] }>('/dpr/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
    void loadHistory();
  }, []);

  async function loadHistory() {
    try {
      const d = await api.get<{ batches: HsdImportBatch[] }>('/hsd/import/history');
      setHistory(d.batches);
    } catch (e) { setError((e as Error).message); }
  }

  async function doImport(confirmReplace = false) {
    if (!rigId || !file) return;
    setError(''); setIssues([]); setSuccess(null); setDuplicate(null); setImported([]);
    const form = new FormData();
    form.append('file', file);
    form.append('rigId', rigId);
    if (confirmReplace) form.append('confirmReplace', 'true');
    try {
      const data = await run(() => api.form<{ daysImported: number; equipmentRows: number }>('/hsd/import', form));
      setSuccess({ daysImported: data.daysImported, equipmentRows: data.equipmentRows });
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      void loadHistory();
      // Show what actually landed for this rig, so the result is verifiable
      // rather than just a count.
      const r = await api.get<{ reports: HsdReportSummary[] }>(`/hsd/reports?rigId=${rigId}`);
      setImported(r.reports);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const d = e.details as { duplicateDates?: string[] } | undefined;
        if (d?.duplicateDates) { setDuplicate({ dates: d.duplicateDates, message: e.message }); return; }
      }
      if (e instanceof ApiError && e.status === 400) {
        const d = e.details as { issues?: DprIssue[] } | undefined;
        if (d?.issues) { setIssues(d.issues); void loadHistory(); return; }
      }
      setError((e as Error).message);
    }
  }

  const selectedRig = rigs.find((r) => r.id === rigId);

  return (
    <div>
      <PageHeader
        title="HSD Diesel Consumption Import"
        subtitle="Rig-wise, month-wise HSD Excel upload — nothing is saved until every day-sheet passes."
        actions={
          <button
            className="btn-ghost"
            disabled={!rigId}
            onClick={() => rigId && void download(`/hsd/template/${rigId}?month=${month}`, 'HSD_Template.xlsx')}
          >
            <Download size={14} /> Download {selectedRig ? `${selectedRig.rigNumber} ` : ''}HSD Template
          </button>
        }
      />

      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-4 mb-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Select Rig">
            <select className="input" value={rigId} onChange={(e) => { setRigId(e.target.value); setSuccess(null); setIssues([]); }}>
              <option value="">Choose a rig...</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          </Field>
          <Field label="Month" hint={monthLabel(month)}>
            <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
          <Field label="Upload Excel" hint={file ? file.name : 'No file chosen'}>
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setSuccess(null); setIssues([]); }}
            />
            <button className="btn-ghost w-full justify-center" onClick={() => fileRef.current?.click()} disabled={!rigId}>
              <FileSpreadsheet size={14} /> Choose Excel File
            </button>
          </Field>
        </div>
        <div className="flex justify-end">
          <button className="btn-primary" disabled={!rigId || !file || busy} onClick={() => void doImport(false)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <UploadIcon size={14} />}
            IMPORT HSD
          </button>
        </div>

        {success && (
          <InfoBox>
            <div className="flex items-center gap-2 text-emerald-800">
              <CheckCircle2 size={16} /> Import successful — {count(success.daysImported)} day(s) and {count(success.equipmentRows)} equipment row(s) saved.
            </div>
          </InfoBox>
        )}

        {issues.length > 0 && (
          <div className="border border-red-200 bg-red-50 rounded-md p-3">
            <div className="flex items-center gap-2 text-red-800 font-medium text-sm mb-2">
              <AlertTriangle size={14} /> Import Failed
            </div>
            <ul className="text-sm text-red-800 space-y-1 list-disc list-inside">
              {issues.map((i, n) => (
                <li key={n}>{i.day ? `Day ${i.day}${i.row ? ` Row ${i.row}` : ''}: ` : ''}{i.message}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {imported.length > 0 && (
        <div className="card mb-4">
          <div className="card-header">
            <h3 className="card-title">HSD Data — {selectedRig?.rigNumber}</h3>
            <span className="text-xs text-slate-500">{count(imported.length)} day(s) on record</span>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th><th>Well</th><th className="text-right">R1</th><th className="text-right">R2</th>
                  <th className="text-right">R3</th><th className="text-right">ILM</th><th className="text-right">Total Hrs</th>
                  <th className="text-right">Equipment</th><th className="text-right">HSD Consumed</th>
                </tr>
              </thead>
              <tbody>
                {imported.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium whitespace-nowrap">{date(r.hsdDate)}</td>
                    <td className="text-xs">{r.wellName ?? '-'}</td>
                    <td className="num">{fmt(r.r1Hours)}</td>
                    <td className="num">{fmt(r.r2Hours)}</td>
                    <td className="num">{fmt(r.r3Hours)}</td>
                    <td className="num">{fmt(r.ilmHours)}</td>
                    <td className="num">{fmt(r.totalHours)}</td>
                    <td className="num">{count(r.equipmentCount)}</td>
                    <td className="num">{fmt(r.totalConsumedHsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header"><h3 className="card-title">HSD Import History</h3></div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>File</th><th>Rig</th><th>Uploaded</th><th>By</th>
                <th className="text-right">Days Imported</th><th className="text-right">Rejected</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {!history ? (
                <tr><td colSpan={8}><Spinner /></td></tr>
              ) : history.length === 0 ? (
                <tr><td colSpan={8}><Empty message="No HSD files have been uploaded yet." /></td></tr>
              ) : history.map((b) => (
                <tr key={b.id}>
                  <td className="max-w-[220px] truncate" title={b.fileName}>{b.fileName}</td>
                  <td className="whitespace-nowrap">{b.rigNumber}</td>
                  <td className="whitespace-nowrap text-xs">{dateTime(b.uploadedAt)}</td>
                  <td className="text-xs">{b.uploadedBy}</td>
                  <td className="num">{count(b.recordCount)}</td>
                  <td className="num">{count(b.errorCount)}</td>
                  <td><span className={b.status === 'Successful' ? 'pill-normal' : 'pill-overdue'}>{b.status}</span></td>
                  <td className="text-right">
                    {b.errorDetail && b.errorDetail.length > 0 && (
                      <details className="inline-block text-left">
                        <summary className="text-xs text-rig-700 cursor-pointer">Details</summary>
                        <ul className="text-[11px] text-slate-600 mt-1 list-disc list-inside">
                          {b.errorDetail.map((i, n) => <li key={n}>{i.day ? `Day ${i.day}${i.row ? ` Row ${i.row}` : ''}: ` : ''}{i.message}</li>)}
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
        open={!!duplicate}
        tone="danger"
        title="HSD data already exists for some of these dates"
        confirmLabel="Replace those days"
        busy={busy}
        body={<p>{duplicate?.message}</p>}
        onConfirm={() => void doImport(true)}
        onCancel={() => setDuplicate(null)}
      />
    </div>
  );
}
