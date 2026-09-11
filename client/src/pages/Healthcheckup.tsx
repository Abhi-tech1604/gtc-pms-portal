import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rigLabel } from '../lib/rig';
import { Link } from 'react-router-dom';
import { FileSpreadsheet, Link2, Loader2, MapPin, Trash2, Upload as UploadIcon, X } from 'lucide-react';
import { api } from '../lib/api';
import { count, date, dateTime } from '../lib/format';
import type { HealthNarrative, HealthNarrativePreview, Rig } from '../lib/types';
import {
  ConfirmDialog, Empty, ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy,
} from '../components/ui';
import { useAuth } from '../lib/auth';

/**
 * Manual, single-machine checkups are logged from that machine's own record
 * (Equipment Directory / Equipment Detail) — see CheckupModal in
 * EquipmentDirectory.tsx. This page's only job is bulk import: upload the
 * Engineering Health Check-up workbook and browse what has been uploaded.
 */
export default function Healthcheckup() {
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div>
      <PageHeader
        title="Healthcheckup Logs"
        subtitle="Bulk import the Engine / Transmission Health Check-up workbook, and browse what has been logged."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <NarrativeTab rigs={rigs} />
    </div>
  );
}

/* ------------------------------- engineering narrative log ------------------------------- */

/**
 * A different kind of health data from the rest of this page: a free-form
 * engineering log (Engine / Transmission health check-up sheets, plus a yard
 * and central-store sheet) with prose problem/action/outcome history per
 * engine or transmission, rather than a simple per-day Normal/Breakdown
 * reading. Shown as cards, not a dense table, because the content is prose —
 * a table would truncate exactly the findings and actions this data exists to
 * preserve. Every entry keeps the rig (or, for off-rig equipment, the physical
 * place, with the rig shown only as a secondary reference) exactly as recorded.
 */
function NarrativeTab({ rigs }: { rigs: Rig[] }) {
  const { can } = useAuth();
  const [items, setItems] = useState<HealthNarrative[] | null>(null);
  const [uploads, setUploads] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<HealthNarrativePreview | null>(null);
  const [deleting, setDeleting] = useState<Record<string, unknown> | null>(null);
  const [busy, run] = useBusy();
  const fileRef = useRef<HTMLInputElement>(null);

  const [filterRig, setFilterRig] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterLocation, setFilterLocation] = useState<'' | 'onRig' | 'offRig'>('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    const [narrativeData, uploadData] = await Promise.all([
      api.get<{ narratives: HealthNarrative[] }>('/health-narratives'),
      can('canManageHealthcheckup')
        ? api.get<{ uploads: Record<string, unknown>[] }>('/health-narratives/uploads')
        : Promise.resolve({ uploads: [] }),
    ]);
    setItems(narrativeData.narratives);
    setUploads(uploadData.uploads);
  }, [can]);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  async function upload(file: File) {
    setError('');
    setPreview(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const data = await run(() => api.form<{ preview: HealthNarrativePreview }>('/health-narratives/preview', form));
      setPreview(data.preview);
    } catch (e) { setError((e as Error).message); }
  }

  async function doImport() {
    if (!preview) return;
    setError('');
    try {
      await run(() => api.post(`/health-narratives/import/${preview.planId}`));
      setPreview(null);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function removeUpload() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/health-narratives/uploads/${deleting.id}`); await load(); });
      setDeleting(null);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  const filtered = useMemo(() => {
    if (!items) return [];
    const needle = search.trim().toLowerCase();
    return items.filter((n) =>
      (!filterRig || n.rigId === filterRig)
      && (!filterCategory || n.category === filterCategory)
      && (!filterLocation || (filterLocation === 'offRig' ? !!n.place : !n.place))
      && (!needle || [n.application, n.make, n.problem, n.action, n.outcomeNotes, n.place, n.rigNumber, n.rigText]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))),
    );
  }, [items, filterRig, filterCategory, filterLocation, search]);

  return (
    <div className="space-y-4">
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <InfoBox>
        This log preserves the workbook's own findings and actions as written. When a row's serial number or
        name matches a tracked machine on the resolved rig, it is linked (<Link2 size={11} className="inline text-emerald-600 align-text-top" /> icon) and updates that
        machine's health countdown; otherwise the entry stays informational, attached only to the rig or, for
        equipment currently off a rig, its yard or store location.
      </InfoBox>

      {can('canManageHealthcheckup') && (
        <div className="card p-4">
          <div className="text-sm font-medium text-slate-700 mb-2">Upload an Engine / Transmission Health Check-up workbook</div>
          <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center">
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
            />
            {busy ? (
              <div className="flex items-center justify-center gap-2 text-slate-600 text-sm">
                <Loader2 size={16} className="animate-spin" /> Reading the workbook...
              </div>
            ) : (
              <>
                <FileSpreadsheet size={24} className="mx-auto text-slate-400 mb-2" />
                <button className="text-rig-700 font-medium hover:underline text-sm" onClick={() => fileRef.current?.click()}>
                  Choose a workbook
                </button>
                <div className="text-[11px] text-slate-500 mt-1">
                  Reads the Engine, Transmission, and Bakrol &amp; Central Store sheets automatically.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {preview && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">{preview.fileName}</h3>
              <div className="text-[11px] text-slate-500">
                Sheets: {preview.sheetsFound.join(', ')} · {count(preview.totalRows)} row(s) ·
                {' '}{count(preview.matchedToRig)} matched to a rig ·
                {' '}{count(preview.matchedToEquipment)} matched to a tracked machine (their health countdown will
                update){preview.toCreateEquipment > 0 && (
                  <> · <span className="text-amber-700 font-medium">{count(preview.toCreateEquipment)} new
                    machine(s) will be created</span></>
                )} · {count(preview.withPlace)} with a place
              </div>
            </div>
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={() => setPreview(null)}><X size={14} /> Discard</button>
              <button className="btn-primary" disabled={busy || preview.rows.length === 0} onClick={() => void doImport()}>
                <UploadIcon size={14} /> Import {count(preview.rows.length)} entr{preview.rows.length === 1 ? 'y' : 'ies'}
              </button>
            </div>
          </div>
          {preview.issues.length > 0 && (
            <ul className="px-4 py-3 text-sm space-y-1 border-b border-slate-200 text-amber-700">
              {preview.issues.map((i, n) => <li key={n}>{i.message}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="card p-3 grid grid-cols-1 md:grid-cols-4 gap-3">
        <Field label="Search"><input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Application, make, problem..." /></Field>
        <Field label="Rig">
          <select className="input" value={filterRig} onChange={(e) => setFilterRig(e.target.value)}>
            <option value="">All rigs</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className="input" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
            <option value="">Engine &amp; Transmission</option>
            <option value="Engine">Engine</option>
            <option value="Transmission">Transmission</option>
          </select>
        </Field>
        <Field label="Location">
          <select className="input" value={filterLocation} onChange={(e) => setFilterLocation(e.target.value as 'onRig' | 'offRig' | '')}>
            <option value="">On a rig or off</option>
            <option value="onRig">On a rig</option>
            <option value="offRig">At a yard or store</option>
          </select>
        </Field>
      </div>

      {!items ? <Spinner /> : filtered.length === 0 ? (
        <Empty message={items.length === 0
          ? 'No engineering health check-up entries have been uploaded yet.'
          : 'No entry matches these filters.'} />
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-slate-500">{count(filtered.length)} of {count(items.length)} entries</div>
          {filtered.map((n) => <NarrativeCard key={n.id} n={n} />)}
        </div>
      )}

      {uploads.length > 0 && (
        <div className="card">
          <div className="card-header"><h3 className="card-title">Engineering health log workbooks</h3></div>
          <table className="table">
            <thead>
              <tr><th>File</th><th>Uploaded</th><th>By</th><th className="text-right">Entries</th><th /></tr>
            </thead>
            <tbody>
              {uploads.map((u) => (
                <tr key={String(u.id)}>
                  <td className="max-w-[320px] truncate">{String(u.fileName)}</td>
                  <td className="whitespace-nowrap text-xs">{dateTime(String(u.uploadDate))}</td>
                  <td className="text-xs">{String(u.uploadedBy)}</td>
                  <td className="num">{count(u.recordsImported as number)}</td>
                  <td className="text-right">
                    <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(u)}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title="Delete this workbook's entries?"
        confirmLabel="Delete these entries"
        busy={busy}
        body={
          <p>
            "{String(deleting?.fileName ?? '')}" and its {count(deleting?.recordsImported as number)} entries will be
            removed from the log. This does not affect any other workbook.
          </p>
        }
        onConfirm={() => void removeUpload()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  'Manual Entry': 'Remarks',
  'Transmission Health Check up ': 'Status',
};

function categoryPill(category: string): string {
  if (category === 'Engine') return 'pill-engine';
  if (category === 'Transmission') return 'pill-transmission';
  return 'pill-place';
}

export function NarrativeCard({ n }: { n: HealthNarrative }) {
  const outcomeLabel = OUTCOME_LABEL[n.sourceSheet] ?? 'Overhauling Details';
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <span className={categoryPill(n.category)}>{n.category}</span>
            {n.sourceSheet === 'Manual Entry' && <span className="pill-normal">Manual</span>}
            {n.place ? (
              <span className="pill-place inline-flex items-center gap-1">
                <MapPin size={10} /> {n.place}
              </span>
            ) : null}
            {n.rigNumber ? (
              <span className={n.place ? 'text-xs text-slate-500' : 'font-medium text-slate-800 text-sm'}>
                {n.place ? 'also ' : ''}{n.rigNumber}
              </span>
            ) : n.rigText ? (
              <span className="text-xs text-amber-700" title="This rig is not registered in the portal">
                "{n.rigText}" (unregistered rig)
              </span>
            ) : !n.place ? (
              <span className="text-xs text-slate-400">No rig recorded</span>
            ) : null}
          </div>
          <div className="font-semibold text-slate-800 flex items-center gap-1.5">
            {n.equipmentId ? (
              <Link to={`/equipment/${n.equipmentId}`} className="text-rig-700 hover:underline" title="Open this tracked machine">
                {n.application ?? 'Unnamed component'}
              </Link>
            ) : (
              n.application ?? 'Unnamed component'
            )}
            {n.equipmentId && (
              <span title="Linked to a tracked machine — this entry updates its health countdown">
                <Link2 size={12} className="text-emerald-600 shrink-0" />
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500">
            {n.make ?? '-'}{n.serialNumber ? ` · Serial ${n.serialNumber}` : ''}
          </div>
        </div>
        <div className="text-right text-[11px] text-slate-500 shrink-0">
          {n.previousDate && <div>Previous: <span className="font-medium text-slate-700">{date(n.previousDate)}</span></div>}
          {n.lastDate && <div>Last: <span className="font-medium text-slate-700">{date(n.lastDate)}</span></div>}
          {!n.previousDate && !n.lastDate && <div>No date recorded</div>}
        </div>
      </div>

      {(n.problem || n.action || n.outcomeNotes) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-2">
          {n.problem && (
            <div className="bg-red-50 border border-red-100 rounded-md p-2">
              <div className="text-[10px] font-semibold uppercase text-red-700 mb-1">Problem</div>
              <div className="text-xs text-slate-700 whitespace-pre-line">{n.problem}</div>
            </div>
          )}
          {n.action && (
            <div className="bg-sky-50 border border-sky-100 rounded-md p-2">
              <div className="text-[10px] font-semibold uppercase text-sky-700 mb-1">Action</div>
              <div className="text-xs text-slate-700 whitespace-pre-line">{n.action}</div>
            </div>
          )}
          {n.outcomeNotes && (
            <div className="bg-emerald-50 border border-emerald-100 rounded-md p-2">
              <div className="text-[10px] font-semibold uppercase text-emerald-700 mb-1">{outcomeLabel}</div>
              <div className="text-xs text-slate-700 whitespace-pre-line">{n.outcomeNotes}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
