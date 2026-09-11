import { useEffect, useRef, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload as UploadIcon } from 'lucide-react';
import { api, ApiError, download } from '../../lib/api';
import { count, dateTime } from '../../lib/format';
import type { IlmImportBatch, IlmIssue, IlmRig } from '../../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

const fmtSize = (bytes: number) => bytes < 1024 * 1024
  ? `${(bytes / 1024).toFixed(1)} KB`
  : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

/**
 * One rig, one file, one button — validation happens on that same click
 * across all three ILM sheets together; nothing is saved until the whole
 * file passes every check in ilmIngest.ts.
 */
export default function IlmImportCenter() {
  const [rigs, setRigs] = useState<IlmRig[]>([]);
  const [rigId, setRigId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [issues, setIssues] = useState<IlmIssue[]>([]);
  const [success, setSuccess] = useState<{ ilmNumber: string; recordCount: number } | null>(null);
  const [error, setError] = useState('');
  const [duplicate, setDuplicate] = useState<{ transactionId: string; message: string } | null>(null);
  const [history, setHistory] = useState<IlmImportBatch[] | null>(null);
  const [busy, run] = useBusy();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ rigs: IlmRig[] }>('/ilm/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
    void loadHistory();
  }, []);

  async function loadHistory() {
    try {
      const d = await api.get<{ batches: IlmImportBatch[] }>('/ilm/import/history');
      setHistory(d.batches);
    } catch (e) { setError((e as Error).message); }
  }

  async function doImport(confirmReplace = false) {
    if (!rigId || !file) return;
    setError(''); setIssues([]); setSuccess(null); setDuplicate(null);
    const form = new FormData();
    form.append('file', file);
    form.append('rigId', rigId);
    if (confirmReplace) form.append('confirmReplace', 'true');
    try {
      const data = await run(() => api.form<{ transaction: { ilmNumber: string; individualLines: unknown[]; trailerLoads: unknown[]; cranes: unknown[] } }>('/ilm/import', form));
      const t = data.transaction;
      setSuccess({ ilmNumber: t.ilmNumber, recordCount: t.individualLines.length + t.trailerLoads.length + t.cranes.length });
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      void loadHistory();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const d = e.details as { duplicateTransactionId?: string } | undefined;
        if (d?.duplicateTransactionId) { setDuplicate({ transactionId: d.duplicateTransactionId, message: e.message }); return; }
      }
      if (e instanceof ApiError && e.status === 400) {
        const d = e.details as { issues?: IlmIssue[] } | undefined;
        if (d?.issues) { setIssues(d.issues); void loadHistory(); return; }
      }
      setError((e as Error).message);
    }
  }

  const selectedRig = rigs.find((r) => r.id === rigId);

  return (
    <div>
      <PageHeader
        title="Import Center"
        subtitle="Rig-wise ILM Excel upload — nothing is saved until every check across all three sheets passes."
        actions={
          <button
            className="btn-ghost"
            disabled={!rigId}
            onClick={() => rigId && void download(`/ilm/template/${rigId}`, 'ILM_Template.xlsx')}
          >
            <Download size={14} /> Download {selectedRig ? `${selectedRig.rigNumber} ` : ''}ILM Template
          </button>
        }
      />

      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-4 mb-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Select Rig">
            <select className="input" value={rigId} onChange={(e) => { setRigId(e.target.value); setSuccess(null); setIssues([]); }}>
              <option value="">Choose a rig...</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          </Field>
          <Field label="Upload Excel" hint={file ? `${file.name} (${fmtSize(file.size)})` : 'No file chosen'}>
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setSuccess(null); setIssues([]); }}
            />
            <button className="btn-ghost w-full justify-center" onClick={() => fileRef.current?.click()} disabled={!rigId}>
              <FileSpreadsheet size={14} /> Choose Excel File
            </button>
          </Field>
        </div>

        {file && selectedRig && (
          <div className="text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
            <span>Selected file: <strong className="text-slate-700">{file.name}</strong></span>
            <span>Size: <strong className="text-slate-700">{fmtSize(file.size)}</strong></span>
            <span>Template type: <strong className="text-slate-700">ILM Template</strong></span>
            <span>Rig: <strong className="text-slate-700">{selectedRig.rigNumber}</strong></span>
          </div>
        )}

        <div className="flex justify-end">
          <button className="btn-primary" disabled={!rigId || !file || busy} onClick={() => void doImport(false)}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <UploadIcon size={14} />}
            IMPORT ILM
          </button>
        </div>

        {success && (
          <InfoBox>
            <div className="flex items-center gap-2 text-emerald-800">
              <CheckCircle2 size={16} /> Import successful — {success.ilmNumber}, {count(success.recordCount)} record(s) saved across Individual, Trailer and Crane.
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
                <li key={n}>{i.sheet ? `${i.sheet}${i.row ? ` Row ${i.row}` : ''}: ` : i.row ? `Row ${i.row}: ` : ''}{i.message}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header"><h3 className="card-title">Import History</h3></div>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Import ID</th><th>File</th><th>Rig</th><th>Uploaded</th><th>By</th><th>Version</th>
                <th className="text-right">Imported</th><th className="text-right">Failed</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {!history ? (
                <tr><td colSpan={10}><Spinner /></td></tr>
              ) : history.length === 0 ? (
                <tr><td colSpan={10}><Empty message="No ILM files have been uploaded yet." /></td></tr>
              ) : history.map((b) => (
                <tr key={b.id}>
                  <td className="text-xs whitespace-nowrap">{b.id}</td>
                  <td className="max-w-[200px] truncate" title={b.fileName}>{b.fileName}</td>
                  <td className="whitespace-nowrap">{b.rigNumber}</td>
                  <td className="whitespace-nowrap text-xs">{dateTime(b.uploadedAt)}</td>
                  <td className="text-xs">{b.uploadedBy}</td>
                  <td className="text-xs">{b.templateVersion ?? '-'}</td>
                  <td className="num">{count(b.recordCount)}</td>
                  <td className="num">{count(b.errorCount)}</td>
                  <td><span className={b.status === 'Successful' ? 'pill-normal' : 'pill-overdue'}>{b.status}</span></td>
                  <td className="text-right">
                    {b.errorDetail && b.errorDetail.length > 0 && (
                      <details className="inline-block text-left">
                        <summary className="text-xs text-rig-700 cursor-pointer">View Details</summary>
                        <ul className="text-[11px] text-slate-600 mt-1 list-disc list-inside">
                          {b.errorDetail.map((i, n) => (
                            <li key={n}>{i.sheet ? `${i.sheet}${i.row ? ` Row ${i.row}` : ''}: ` : i.row ? `Row ${i.row}: ` : ''}{i.message}</li>
                          ))}
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
        title="An ILM movement for this rig and date already exists"
        confirmLabel="Replace it"
        busy={busy}
        body={<p>{duplicate?.message}</p>}
        onConfirm={() => void doImport(true)}
        onCancel={() => setDuplicate(null)}
      />
    </div>
  );
}
