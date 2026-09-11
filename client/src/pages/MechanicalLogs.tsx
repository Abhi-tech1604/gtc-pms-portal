import { useCallback, useEffect, useRef, useState } from 'react';
import { rigLabel } from '../lib/rig';
import {
  AlertTriangle, Download, FileSpreadsheet, Loader2, Trash2, Upload as UploadIcon, X,
} from 'lucide-react';
import { api, ApiError, download } from '../lib/api';
import { count, currentMonth, date, dateTime, hours, monthLabel } from '../lib/format';
import type { Gate, Preview, Rig, Upload } from '../lib/types';
import {
  ConfirmDialog, Empty, ErrorBox, Field, InfoBox, PageHeader, Spinner, Tabs, useBusy,
} from '../components/ui';
import { useAuth } from '../lib/auth';

type Tab = 'upload' | 'registry' | 'data';

export default function MechanicalLogs() {
  const [tab, setTab] = useState<Tab>('upload');
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div>
      <PageHeader
        title="Mechanical Logs"
        subtitle="Upload the Daily Mechanical Report, review what will be imported, then commit it."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'upload', label: 'Upload' },
          { key: 'registry', label: 'Upload registry' },
          { key: 'data', label: 'Log data' },
        ]}
      />
      {tab === 'upload' && <UploadTab rigs={rigs} onImported={() => setTab('registry')} />}
      {tab === 'registry' && <RegistryTab rigs={rigs} />}
      {tab === 'data' && <LogDataTab rigs={rigs} />}
    </div>
  );
}

/* ------------------------------- upload ------------------------------- */

function UploadTab({ rigs, onImported }: { rigs: Rig[]; onImported: () => void }) {
  const { can, rigScope } = useAuth();
  const [rigId, setRigId] = useState(rigScope ?? '');
  const [month, setMonth] = useState(currentMonth());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [gate, setGate] = useState<Gate | null>(null);
  const [chosenRig, setChosenRig] = useState('');
  const [busy, run] = useBusy();
  const fileRef = useRef<HTMLInputElement>(null);

  function toggleExcluded(groupKey: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  const mayUpload = can('canUploadMechanicalLogs');

  const upload = useCallback(async (file: File) => {
    setError('');
    setPreview(null);
    const form = new FormData();
    form.append('file', file);
    if (rigId) form.append('rigId', rigId);
    form.append('logMonth', month);
    try {
      const data = await run(() => api.form<{ preview: Preview }>('/mechanical-logs/preview', form));
      applyPreview(data.preview);
    } catch (e) { setError((e as Error).message); }
  }, [rigId, month, run]);

  function applyPreview(p: Preview) {
    setPreview(p);
    setExcluded(new Set());
    setSelectedDay(p.days.length ? p.days[p.days.length - 1].day : null);
    const mismatch = p.gates.find((g) => g.kind === 'rigMismatch');
    if (mismatch && p.rigResolvedFrom !== 'user') {
      setChosenRig('');
      setGate(mismatch);
    } else {
      setGate(null);
    }
  }

  async function resolveRig() {
    if (!preview || !chosenRig) return;
    setError('');
    try {
      const data = await run(() => api.post<{ preview: Preview }>(
        `/mechanical-logs/preview/${preview.planId}/resolve`,
        { confirmedRigId: chosenRig, logMonth: preview.logMonth },
      ));
      setGate(null);
      applyPreview(data.preview);
    } catch (e) { setError((e as Error).message); }
  }

  async function resolveDataThrough(day: number | null) {
    if (!preview) return;
    setError('');
    try {
      const data = await run(() => api.post<{ preview: Preview }>(
        `/mechanical-logs/preview/${preview.planId}/resolve`,
        { logMonth: preview.logMonth, lastFilledDayOverride: day },
      ));
      applyPreview(data.preview);
    } catch (e) { setError((e as Error).message); }
  }

  async function doImport(confirmations: { confirmLastFilledDay?: boolean; confirmOverwrite?: boolean } = {}) {
    if (!preview) return;
    setError('');
    try {
      await run(() => api.post(`/mechanical-logs/import/${preview.planId}`, {
        ...confirmations,
        excludedKeys: [...excluded],
      }));
      setPreview(null);
      setGate(null);
      setExcluded(new Set());
      onImported();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const gates = (e.details as { gates?: Gate[] } | undefined)?.gates;
        if (gates?.length) { setGate(gates[0]); return; }
      }
      setError((e as Error).message);
    }
  }

  function confirmGate() {
    if (!gate) return;
    if (gate.kind === 'rigMismatch') { void resolveRig(); return; }
    const next = { confirmLastFilledDay: true, confirmOverwrite: true };
    setGate(null);
    void doImport(next);
  }

  const fatal = preview?.issues.filter((i) => i.level === 'fatal') ?? [];
  const warnings = preview?.issues.filter((i) => i.level === 'warning') ?? [];
  const activeMachines = preview?.machines.filter((m) => !excluded.has(m.groupKey)) ?? [];
  const activeRows = activeMachines.reduce((n, m) => n + m.dayCount, 0);
  const activeDays = preview
    ? preview.days
        .map((d) => ({ day: d.day, rows: d.rows.filter((r) => !excluded.has(r.groupKey)) }))
        .filter((d) => d.rows.length > 0)
    : [];
  const day = activeDays.find((d) => d.day === selectedDay) ?? activeDays[activeDays.length - 1];

  return (
    <div className="space-y-4">
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <Field label="Rig" hint="Only used if the workbook does not name a rig we recognise">
            <select className="input" value={rigId} onChange={(e) => setRigId(e.target.value)} disabled={!!rigScope}>
              <option value="">Read the rig from the workbook</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          </Field>
          <Field label="Log month" hint="Overridden by the workbook's own date cells when present">
            <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
          <Field label="Template">
            <button
              className="btn-ghost w-full justify-center"
              disabled={!rigId}
              onClick={() => void download(`/mechanical-logs/template/${rigId}?month=${month}`, 'template.xlsx')}
            >
              <Download size={14} /> Download template
            </button>
          </Field>
        </div>

        {mayUpload ? (
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              dragging ? 'border-rig-500 bg-rig-50' : 'border-slate-300'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void upload(file);
            }}
          >
            <input
              ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
            />
            {busy ? (
              <div className="flex items-center justify-center gap-2 text-slate-600">
                <Loader2 size={18} className="animate-spin" /> Reading the workbook...
              </div>
            ) : (
              <>
                <FileSpreadsheet size={28} className="mx-auto text-slate-400 mb-2" />
                <div className="text-sm text-slate-600">
                  Drop a Daily Mechanical Report here, or{' '}
                  <button className="text-rig-700 font-medium hover:underline" onClick={() => fileRef.current?.click()}>
                    browse for a file
                  </button>
                </div>
                <div className="text-[11px] text-slate-500 mt-1">.xlsx or .xls · nothing is written until you press Import</div>
              </>
            )}
          </div>
        ) : (
          <InfoBox>Your account does not have permission to upload mechanical logs.</InfoBox>
        )}
      </div>

      {preview && (
        <>
          <div className="card p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-800">{preview.fileName}</div>
                <div className="text-xs text-slate-500 mt-1">
                  Rig: <span className="font-medium text-slate-700">
                    {preview.rig ? rigLabel(preview.rig) : 'not resolved'}
                  </span>
                  {preview.rigNumberInFile && <> · workbook says "{preview.rigNumberInFile}"</>}
                  {preview.rigResolvedFrom === 'workbook' && <> · matched from the workbook</>}
                  {preview.rigResolvedFrom === 'user' && <> · chosen by you</>}
                </div>
                <div className="text-xs text-slate-500 flex items-center gap-1 flex-wrap">
                  <span>Month {monthLabel(preview.logMonth)} ·</span>
                  {preview.availableDays.length > 1 ? (
                    <span className="flex items-center gap-1">
                      data through day
                      <select
                        className="border border-slate-300 rounded px-1 py-0.5 text-xs bg-white"
                        value={preview.lastFilledDay ?? ''}
                        disabled={busy}
                        onChange={(e) => void resolveDataThrough(Number(e.target.value))}
                      >
                        {preview.availableDays.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                      {preview.lastFilledDate && `(${date(preview.lastFilledDate)})`}
                      {preview.lastFilledDayOverride != null && (
                        <span className="text-rig-700 font-medium">chosen by you</span>
                      )}
                    </span>
                  ) : (
                    <span>
                      last filled day {preview.lastFilledDay ?? '-'}
                      {preview.lastFilledDate && ` (${date(preview.lastFilledDate)})`}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4 text-center">
                <Summary label="Machines" value={activeMachines.length} />
                <Summary label="New machines" value={activeMachines.filter((m) => m.isNew).length} />
                <Summary label="Log rows" value={activeRows} />
                <Summary label="Days" value={activeDays.length} />
              </div>
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={() => { setPreview(null); setGate(null); setExcluded(new Set()); }}>
                  <X size={14} /> Discard
                </button>
                <button
                  className="btn-primary"
                  disabled={busy || fatal.length > 0 || !preview.rig || activeRows === 0}
                  onClick={() => void doImport()}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <UploadIcon size={14} />}
                  Import {count(activeRows)} row(s)
                </button>
              </div>
            </div>
          </div>

          {fatal.length > 0 && (
            <div className="card border-red-200">
              <div className="card-header bg-red-50">
                <h3 className="card-title text-red-800 flex items-center gap-1.5">
                  <AlertTriangle size={14} /> Nothing can be imported until these are resolved
                </h3>
              </div>
              <ul className="p-4 space-y-1 text-sm text-red-800 list-disc list-inside">
                {fatal.map((i, n) => <li key={n}>{i.message}</li>)}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <details className="card">
              <summary className="card-header cursor-pointer">
                <span className="card-title">{warnings.length} row(s) skipped &mdash; open for detail</span>
              </summary>
              <ul className="p-4 space-y-1 text-sm text-slate-600 list-disc list-inside">
                {warnings.map((i, n) => <li key={n}>{i.message}</li>)}
              </ul>
            </details>
          )}

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Machines in this workbook</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Machine</th><th>Serial</th><th>Section</th><th>Match</th>
                    <th className="text-right">Days</th><th className="text-right">New current hrs</th>
                    <th className="text-right">Last service</th><th className="text-right">Interval</th>
                    <th>From day</th><th />
                  </tr>
                </thead>
                <tbody>
                  {preview.machines.map((m) => {
                    const isExcluded = excluded.has(m.groupKey);
                    return (
                      <tr key={m.groupKey} className={isExcluded ? 'opacity-50' : undefined}>
                        <td className={`font-medium ${isExcluded ? 'line-through' : ''}`}>{m.name}</td>
                        <td className="text-xs">{m.serial ?? '-'}</td>
                        <td className="text-xs">{m.section === 'generator' ? 'Generator' : 'Diesel'}</td>
                        <td>
                          {m.isNew
                            ? <span className="pill-upcoming">Will be created</span>
                            : <span className="pill-normal">Matched by {m.matchedBy}</span>}
                        </td>
                        <td className="num">{m.dayCount}</td>
                        <td className="num">{hours(m.update?.currentRunningHours)}</td>
                        <td className="num">{hours(m.update?.lastServiceHours)}</td>
                        <td className="num">{hours(m.update?.serviceInterval)}</td>
                        <td className="text-xs">{m.update ? `${m.update.latestDay} (${date(m.update.latestDate)})` : '-'}</td>
                        <td className="text-right whitespace-nowrap">
                          {isExcluded ? (
                            <button className="btn-ghost btn-sm" onClick={() => toggleExcluded(m.groupKey)}>
                              Restore
                            </button>
                          ) : (
                            <button
                              className="btn-ghost btn-sm text-red-700"
                              title="Exclude this machine from the import"
                              onClick={() => toggleExcluded(m.groupKey)}
                            >
                              <X size={12} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header flex-wrap">
              <h3 className="card-title">Parsed rows by day</h3>
              <div className="flex flex-wrap gap-1">
                {activeDays.map((d) => (
                  <button
                    key={d.day}
                    className={`px-2 py-0.5 rounded text-xs font-medium border ${
                      d.day === selectedDay
                        ? 'bg-rig-600 border-rig-600 text-white'
                        : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
                    }`}
                    onClick={() => setSelectedDay(d.day)}
                  >
                    {d.day}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Machine</th><th>Serial</th><th>In use</th>
                    <th className="text-right">Day</th><th className="text-right">Night</th>
                    <th className="text-right">Opening</th><th className="text-right">Total</th>
                    <th className="text-right">Closing</th><th className="text-right">Last service</th>
                    <th className="text-right">Since</th><th className="text-right">Interval</th>
                    <th className="text-right">Remaining</th><th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {day?.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="font-medium">{r.machine}</td>
                      <td className="text-xs">{r.serial ?? '-'}</td>
                      <td>{r.isInUse ?? '-'}</td>
                      <td className="num">{hours(r.hoursRunDay)}</td>
                      <td className="num">{hours(r.hoursRunNight)}</td>
                      <td className="num">{hours(r.openingRunningHours)}</td>
                      <td className="num">{hours(r.totalRunHours)}</td>
                      <td className="num">{hours(r.closingHours)}</td>
                      <td className="num">{hours(r.lastServiceHours)}</td>
                      <td className="num">{hours(r.runningHoursAfterLastService)}</td>
                      <td className="num">{hours(r.defineHours)}</td>
                      <td className="num">{hours(r.hoursRemainingForNextService)}</td>
                      <td className="text-xs max-w-[220px] truncate" title={r.remarks ?? ''}>{r.remarks ?? '-'}</td>
                    </tr>
                  ))}
                  {!day && <tr><td colSpan={13}><Empty message="No day selected." /></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={!!gate}
        tone="danger"
        title={gateTitle(gate)}
        confirmLabel={gate?.kind === 'rigMismatch' ? 'Use this rig' : 'Continue'}
        busy={busy}
        body={
          <div className="space-y-3">
            <p className="whitespace-pre-wrap">{gate?.message}</p>
            {gate?.kind === 'rigMismatch' && (
              <Field label="Rig this workbook belongs to">
                <select className="input" value={chosenRig} onChange={(e) => setChosenRig(e.target.value)}>
                  <option value="">Choose a rig...</option>
                  {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
                </select>
              </Field>
            )}
          </div>
        }
        onConfirm={confirmGate}
        onCancel={() => setGate(null)}
      />
    </div>
  );
}

function gateTitle(gate: Gate | null): string {
  switch (gate?.kind) {
    case 'rigMismatch': return 'Which rig does this workbook belong to?';
    case 'lastFilledDay': return 'This workbook does not end on yesterday';
    case 'duplicateUpload': return 'This rig already has an upload for that day';
    default: return 'Confirm';
  }
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-lg font-semibold tabular-nums text-slate-900">{count(value)}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

/* ------------------------------- registry ------------------------------- */

function RegistryTab({ rigs }: { rigs: Rig[] }) {
  const { can } = useAuth();
  const [uploads, setUploads] = useState<Upload[] | null>(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ rigId: '', from: '', to: '' });
  const [deleting, setDeleting] = useState<Upload | null>(null);
  const [busy, run] = useBusy();

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (filters.rigId) q.set('rigId', filters.rigId);
    if (filters.from) q.set('from', filters.from);
    if (filters.to) q.set('to', filters.to);
    const data = await api.get<{ uploads: Upload[] }>(`/mechanical-logs/uploads?${q}`);
    setUploads(data.uploads);
  }, [filters]);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  async function remove() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/mechanical-logs/uploads/${deleting.id}`); await load(); });
      setDeleting(null);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  if (!uploads) return <Spinner />;

  return (
    <div className="space-y-4">
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <InfoBox>
        This registry is permanent history. Uploading a new workbook never removes an earlier one;
        only an explicit delete here, or a confirmed same-day replacement, removes a record.
      </InfoBox>

      <div className="card p-3 grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Rig">
          <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
            <option value="">All rigs</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
        <Field label="Uploaded from">
          <input className="input" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </Field>
        <Field label="Uploaded to">
          <input className="input" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </Field>
      </div>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>File name</th><th>Rig</th><th>Log month</th><th>Data through</th>
              <th>Uploaded</th><th>By</th><th className="text-right">Rows</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {uploads.map((u) => (
              <tr key={u.id}>
                <td className="max-w-[260px] truncate" title={u.fileName}>{u.fileName}</td>
                <td className="whitespace-nowrap">{u.rigNumber}</td>
                <td className="whitespace-nowrap">{monthLabel(u.logMonth)}</td>
                <td className="whitespace-nowrap">{date(u.coverageEndDate)}</td>
                <td className="whitespace-nowrap text-xs">{dateTime(u.uploadDate)}</td>
                <td className="text-xs">{u.uploadedBy}</td>
                <td className="num">{count(u.recordsImported)}</td>
                <td>
                  <span className={u.status === 'Uploaded' ? 'pill-normal' : 'pill-overdue'}>{u.status}</span>
                </td>
                <td className="whitespace-nowrap text-right">
                  {u.storedFileName && (
                    <button className="btn-ghost btn-sm mr-1" onClick={() => void download(`/mechanical-logs/uploads/${u.id}/file`, u.fileName)}>
                      <Download size={12} />
                    </button>
                  )}
                  {can('canUploadMechanicalLogs') && (
                    <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(u)}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {uploads.length === 0 && <tr><td colSpan={9}><Empty message="No workbooks have been ingested yet." /></td></tr>}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title="Delete this upload?"
        confirmLabel="Delete this upload only"
        busy={busy}
        body={
          <div className="space-y-2">
            <p>
              "{deleting?.fileName}" for {deleting?.rigNumber}, uploaded {dateTime(deleting?.uploadDate)} by{' '}
              {deleting?.uploadedBy}, covering data through {date(deleting?.coverageEndDate)}.
            </p>
            <p>
              Its {count(deleting?.recordsImported)} log row(s) go with it. Every other upload for this
              rig, and every other rig, is left untouched.
            </p>
          </div>
        }
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

/* ------------------------------- log data ------------------------------- */

function LogDataTab({ rigs }: { rigs: Rig[] }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ rigId: '', month: currentMonth(), day: '' });

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (filters.rigId) q.set('rigId', filters.rigId);
    if (filters.month) q.set('month', filters.month);
    if (filters.day) q.set('day', filters.day);
    const data = await api.get<{ rows: Record<string, unknown>[] }>(`/mechanical-logs/rows?${q}`);
    setRows(data.rows);
  }, [filters]);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  return (
    <div className="space-y-4">
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <div className="card p-3 grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Rig">
          <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
            <option value="">All rigs</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
        <Field label="Month">
          <input className="input" type="month" value={filters.month} onChange={(e) => setFilters({ ...filters, month: e.target.value })} />
        </Field>
        <Field label="Day of month">
          <input className="input" type="number" min={1} max={31} value={filters.day}
            onChange={(e) => setFilters({ ...filters, day: e.target.value })} placeholder="All days" />
        </Field>
      </div>

      {!rows ? <Spinner /> : (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th><th>Rig</th><th>Machine</th><th>Serial</th><th>In use</th>
                <th className="text-right">Day</th><th className="text-right">Night</th>
                <th>Lube psi</th><th className="text-right">Oil added</th>
                <th className="text-right">Opening</th><th className="text-right">Total</th>
                <th className="text-right">Closing</th><th className="text-right">Last service</th>
                <th className="text-right">Since</th><th className="text-right">Interval</th>
                <th className="text-right">Remaining</th><th>PM details</th><th>Remarks</th><th>Last service date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)}>
                  <td className="whitespace-nowrap">{date(String(r.logDate))}</td>
                  <td className="whitespace-nowrap">{String(r.rigNumber)}</td>
                  <td className="font-medium">{String(r.equipmentName)}</td>
                  <td className="text-xs">{(r.serialNumber as string) ?? '-'}</td>
                  <td>{(r.isInUse as string) ?? '-'}</td>
                  <td className="num">{hours(r.hoursRunDay as number)}</td>
                  <td className="num">{hours(r.hoursRunNight as number)}</td>
                  <td className="text-xs">{(r.lubeOilPressure as string) ?? '-'}</td>
                  <td className="num">{hours(r.lubeOilAdded as number)}</td>
                  <td className="num">{hours(r.openingRunningHours as number)}</td>
                  <td className="num">{hours(r.totalRunHours as number)}</td>
                  <td className="num">{hours(r.closingHours as number)}</td>
                  <td className="num">{hours(r.lastServiceHours as number)}</td>
                  <td className="num">{hours(r.runningHoursAfterLastService as number)}</td>
                  <td className="num">{hours(r.defineHours as number)}</td>
                  <td className="num">{hours(r.hoursRemainingForNextService as number)}</td>
                  <td className="text-xs max-w-[180px] truncate">{(r.preventiveMaintenanceDetails as string) ?? '-'}</td>
                  <td className="text-xs max-w-[180px] truncate">{(r.remarks as string) ?? '-'}</td>
                  <td className="whitespace-nowrap text-xs">{date(r.lastServiceDate as string)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={19}><Empty message="No log rows match these filters." /></td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


