import { useEffect, useRef, useState } from 'react';
import { rigLabel } from '../lib/rig';
import { AlertTriangle, Download, FileUp, History, Pencil, Trash2, Plus, UploadCloud } from 'lucide-react';
import { api, ApiError, download } from '../lib/api';
import { count, hours } from '../lib/format';
import type {
  Equipment, MasterImportHistoryRow, MasterImportPreview, MasterImportResult, MaterialMasterRecord, Rig,
} from '../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, InfoBox, Modal, PageHeader, Spinner, useBusy } from '../components/ui';
import { useAuth } from '../lib/auth';

/**
 * Equipment Master: the per-rig equipment roster. Engine/Transmission are no
 * longer tabs here — they live in their own global screen, Material Master
 * (client/src/pages/admin/MaterialMaster.tsx), since one Engine/Transmission
 * record is linkable from equipment on many different rigs.
 */
export default function EquipmentMaster() {
  const { rigScope, isAdmin } = useAuth();
  const [rigs, setRigs] = useState<Rig[] | null>(null);
  const [rigId, setRigId] = useState('');
  const [items, setItems] = useState<Equipment[] | null>(null);
  const [engines, setEngines] = useState<MaterialMasterRecord[]>([]);
  const [transmissions, setTransmissions] = useState<MaterialMasterRecord[]>([]);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [editing, setEditing] = useState<Partial<Equipment> | null>(null);
  const [materialChoice, setMaterialChoice] = useState<'engine' | 'transmission' | 'custom'>('custom');
  const [deleting, setDeleting] = useState<Equipment | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [busy, run] = useBusy();
  const fileRef = useRef<HTMLInputElement>(null);

  // Admin > Master > Equipment Master > Import Correct Master Data — a
  // separate, admin-only, multi-rig flow from the per-rig Bulk Import above.
  const [miOpen, setMiOpen] = useState(false);
  const [miFile, setMiFile] = useState<File | null>(null);
  const [miPreview, setMiPreview] = useState<MasterImportPreview | null>(null);
  const [miResult, setMiResult] = useState<MasterImportResult | null>(null);
  const [miError, setMiError] = useState('');
  const [miHistory, setMiHistory] = useState<MasterImportHistoryRow[] | null>(null);
  const [miHistoryOpen, setMiHistoryOpen] = useState(false);
  const miFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs')
      .then((d) => {
        setRigs(d.rigs);
        if (rigScope) setRigId(rigScope);
      })
      .catch((e) => setLoadError((e as Error).message));
    api.get<{ items: MaterialMasterRecord[] }>('/material-master?materialType=Engine&status=Active')
      .then((d) => setEngines(d.items)).catch(() => {});
    api.get<{ items: MaterialMasterRecord[] }>('/material-master?materialType=Transmission&status=Active')
      .then((d) => setTransmissions(d.items)).catch(() => {});
  }, [rigScope]);

  async function reload() {
    const d = await api.get<{ equipment: Equipment[] }>(`/equipment?rigId=${rigId}&includeInactive=true`);
    setItems(d.equipment);
  }

  useEffect(() => {
    if (!rigId) { setItems(null); return; }
    setItems(null);
    setLoadError('');
    reload().catch((e) => setLoadError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigId]);

  const selectedRig = rigs?.find((r) => r.id === rigId) ?? null;

  const selectedMaterialId = materialChoice === 'engine' ? editing?.linkedEngineId
    : materialChoice === 'transmission' ? editing?.linkedTransmissionId : null;

  async function save() {
    if (!editing) return;
    setSaveError('');
    if (materialChoice === 'custom' && !editing.name?.trim()) { setSaveError('An equipment name is required.'); return; }
    if (materialChoice !== 'custom' && !selectedMaterialId) { setSaveError(`Select a Linked ${materialChoice === 'engine' ? 'Engine' : 'Transmission'} record.`); return; }
    try {
      await run(async () => {
        const payload = {
          rigId: editing.rigId,
          serviceInterval: Math.round(Number(editing.serviceInterval) || 0) || 500,
          isActive: editing.isActive !== false,
          ecmPresent: editing.ecmPresent ?? null,
          etToolApplicable: editing.etToolApplicable ?? null,
          linkedEngineId: materialChoice === 'engine' ? selectedMaterialId : null,
          linkedTransmissionId: materialChoice === 'transmission' ? selectedMaterialId : null,
          ...(materialChoice === 'custom' ? {
            name: editing.name!.trim(),
            manufacturer: editing.manufacturer || null,
            model: editing.model || null,
            serialNumber: editing.serialNumber || null,
          } : {}),
        };
        if (editing.id) {
          await api.put(`/equipment/${editing.id}`, payload);
        } else {
          await api.post('/equipment', payload);
        }
        await reload();
      });
      setEditing(null);
    } catch (e) { setSaveError((e as Error).message); }
  }

  async function remove() {
    if (!deleting) return;
    setDeleteError('');
    try {
      await run(async () => { await api.del(`/equipment/${deleting.id}`); await reload(); });
      setDeleting(null);
    } catch (e) {
      if (e instanceof ApiError) { setDeleteError(e.message); return; }
      setDeleteError((e as Error).message);
    }
  }

  async function importFile(file: File) {
    setLoadError('');
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await run(() =>
        api.form<{ created: number; skipped: { row: number; reason: string }[] }>(`/equipment/import?rigId=${rigId}`, form));
      await reload();
      if (result.skipped.length) {
        setLoadError(`${result.created} machine(s) imported. Skipped:\n` +
          result.skipped.map((s) => `Row ${s.row}: ${s.reason}`).join('\n'));
      }
    } catch (e) { setLoadError((e as Error).message); }
  }

  function openMasterImport() {
    setMiFile(null); setMiPreview(null); setMiResult(null); setMiError('');
    setMiHistoryOpen(false);
    setMiOpen(true);
  }

  async function pickMasterImportFile(file: File) {
    setMiFile(file);
    setMiPreview(null); setMiResult(null); setMiError('');
    const form = new FormData();
    form.append('file', file);
    try {
      const preview = await run(() => api.form<MasterImportPreview>('/equipment/master-import/preview', form));
      setMiPreview(preview);
    } catch (e) { setMiError((e as Error).message); }
  }

  async function confirmMasterImport() {
    if (!miFile) return;
    setMiError('');
    const form = new FormData();
    form.append('file', miFile);
    try {
      const result = await run(() => api.form<MasterImportResult>('/equipment/master-import/confirm', form));
      setMiResult(result);
      setMiPreview(null);
      if (rigId) await reload();
    } catch (e) { setMiError((e as Error).message); }
  }

  async function loadMasterImportHistory() {
    setMiOpen(false);
    setMiHistoryOpen(true);
    try {
      const d = await api.get<{ history: MasterImportHistoryRow[] }>('/equipment/master-import/history');
      setMiHistory(d.history);
    } catch (e) { setMiError((e as Error).message); }
  }

  const materialOptions = materialChoice === 'engine' ? engines : materialChoice === 'transmission' ? transmissions : [];
  const selectedMaterial = materialOptions.find((m) => m.id === selectedMaterialId);

  function pickMaterialType(choice: 'engine' | 'transmission' | 'custom') {
    setMaterialChoice(choice);
    // Switching type always clears both links — the next pick (or Custom's
    // free text) starts fresh rather than carrying over a stale selection.
    if (editing) setEditing({ ...editing, linkedEngineId: null, linkedTransmissionId: null });
  }

  return (
    <div>
      <PageHeader
        title="Equipment Master"
        subtitle="The source of truth for each rig's equipment — new Excel templates are generated from what is active here."
        actions={isAdmin && (
          <>
            <button className="btn-ghost" onClick={() => void loadMasterImportHistory()}>
              <History size={14} /> Import History
            </button>
            <button className="btn-primary" onClick={openMasterImport}>
              <UploadCloud size={14} /> Import Correct Master Data
            </button>
          </>
        )}
      />
      <ErrorBox message={loadError} onDismiss={() => setLoadError('')} />

      <div className="card p-4 mb-4">
        <Field label="Select Rig" hint={rigScope ? 'Your account is limited to this rig.' : undefined}>
          {!rigs ? (
            <Spinner label="Loading rigs..." />
          ) : (
            <select
              className="input max-w-sm"
              value={rigId}
              disabled={!!rigScope}
              onChange={(e) => setRigId(e.target.value)}
            >
              <option value="">Choose a rig...</option>
              {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          )}
        </Field>
      </div>

      {!rigId ? (
        <div className="card">
          <Empty message="Select a rig above to view and manage its equipment." />
        </div>
      ) : (
        <>
          <PageHeader
            title={selectedRig ? `${selectedRig.rigNumber} equipment` : 'Equipment'}
            subtitle={items ? `${count(items.length)} machine(s) registered.` : undefined}
            actions={
              <>
                <input
                  ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }}
                />
                <button className="btn-ghost" onClick={() => void download('/equipment/template/download', 'Equipment_Master_Template.xlsx')}>
                  <Download size={14} /> Template
                </button>
                <button className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
                  <FileUp size={14} /> Bulk import
                </button>
                <button
                  className="btn-primary"
                  disabled={!items}
                  onClick={() => {
                    setEditing({ rigId, serviceInterval: 500, isActive: true });
                    setMaterialChoice('custom');
                  }}
                >
                  <Plus size={14} /> Add Equipment
                </button>
              </>
            }
          />

          <div className="card overflow-x-auto">
            {!items ? (
              <Spinner label="Loading equipment..." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Equipment Name</th>
                    <th>Make</th>
                    <th>Model</th>
                    <th>Serial No.</th>
                    <th className="text-right">Defined Hours</th>
                    <th>Linked Engine</th>
                    <th>Linked Transmission</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <tr key={e.id}>
                      <td className="font-medium text-slate-800">{e.name}</td>
                      <td>{e.manufacturer ?? '-'}</td>
                      <td>{e.model ?? '-'}</td>
                      <td className="text-xs">{e.serialNumber ?? '-'}</td>
                      <td className="num">{hours(e.serviceInterval)}</td>
                      <td className="text-xs">{engines.find((m) => m.id === e.linkedEngineId)?.name ?? '-'}</td>
                      <td className="text-xs">{transmissions.find((m) => m.id === e.linkedTransmissionId)?.name ?? '-'}</td>
                      <td>
                        <span className={e.isActive ? 'pill-normal' : 'pill-place'}>
                          {e.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="whitespace-nowrap text-right">
                        <button
                          className="btn-ghost btn-sm mr-1"
                          onClick={() => {
                            setEditing(e);
                            setMaterialChoice(e.linkedEngineId ? 'engine' : e.linkedTransmissionId ? 'transmission' : 'custom');
                          }}
                        >
                          <Pencil size={12} /> Edit
                        </button>
                        <button className="btn-ghost btn-sm text-red-700" onClick={() => { setDeleting(e); setDeleteError(''); }}>
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={9}>
                        <Empty message="No equipment registered for this rig yet. Add the first machine below." />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <Modal open={!!editing} title={editing?.id ? 'Edit equipment' : 'Add equipment'} onClose={() => setEditing(null)}>
        {editing && (
          <div className="space-y-3">
            <ErrorBox message={saveError} onDismiss={() => setSaveError('')} />
            {!editing.id && (
              <InfoBox>
                This machine will be added to {rigLabel(selectedRig)} and will
                appear the next time a Mechanical Log or Health Checkup template is generated for it.
              </InfoBox>
            )}
            <Field label="Rig">
              <input className="input bg-slate-50 text-slate-500" value={selectedRig ? rigLabel(selectedRig) : ''} disabled />
            </Field>

            <Field label="Linked Material Type">
              <div className="flex items-center gap-4 text-sm mt-1">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={materialChoice === 'engine'} onChange={() => pickMaterialType('engine')} /> Engine
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={materialChoice === 'transmission'} onChange={() => pickMaterialType('transmission')} /> Transmission
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={materialChoice === 'custom'} onChange={() => pickMaterialType('custom')} /> Custom / Other equipment
                </label>
              </div>
            </Field>

            {materialChoice !== 'custom' && (
              <Field label="Linked Material" hint={`Only Active ${materialChoice === 'engine' ? 'Engine' : 'Transmission'} records appear here.`}>
                <select
                  className="input" value={selectedMaterialId ?? ''}
                  onChange={(e) => setEditing({
                    ...editing,
                    linkedEngineId: materialChoice === 'engine' ? (e.target.value || null) : null,
                    linkedTransmissionId: materialChoice === 'transmission' ? (e.target.value || null) : null,
                  })}
                >
                  <option value="">Choose a {materialChoice === 'engine' ? 'engine' : 'transmission'}...</option>
                  {materialOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
            )}

            <div className="grid grid-cols-2 gap-3">
              {materialChoice === 'custom' ? (
                <>
                  <Field label="Equipment Name">
                    <input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                  </Field>
                  <Field label="Make">
                    <input className="input" value={editing.manufacturer ?? ''} onChange={(e) => setEditing({ ...editing, manufacturer: e.target.value })} />
                  </Field>
                  <Field label="Model">
                    <input className="input" value={editing.model ?? ''} onChange={(e) => setEditing({ ...editing, model: e.target.value })} />
                  </Field>
                  <Field label="Serial No.">
                    <input className="input" value={editing.serialNumber ?? ''} onChange={(e) => setEditing({ ...editing, serialNumber: e.target.value })} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Equipment Name" hint="Locked — from Material Master">
                    <input className="input" value={selectedMaterial?.name ?? ''} disabled />
                  </Field>
                  <Field label="Make" hint="Locked — from Material Master">
                    <input className="input" value={selectedMaterial?.make ?? ''} disabled />
                  </Field>
                  <Field label="Model" hint="Locked — from Material Master">
                    <input className="input" value={selectedMaterial?.model ?? ''} disabled />
                  </Field>
                  <Field label="Serial No." hint="Locked — from Material Master">
                    <input className="input" value={selectedMaterial?.serialNumber ?? ''} disabled />
                  </Field>
                </>
              )}
              <Field label="Defined Hours" hint="Service interval used by the Excel template">
                <input
                  className="input" type="number" step="1" min="1"
                  value={editing.serviceInterval ?? 500}
                  onChange={(e) => setEditing({ ...editing, serviceInterval: Math.round(Number(e.target.value)) })}
                />
              </Field>
              <Field label="ECM Present">
                <YesNoUnknownSelect value={editing.ecmPresent ?? null} onChange={(v) => setEditing({ ...editing, ecmPresent: v })} />
              </Field>
              <Field label="ET Tool Applicable">
                <YesNoUnknownSelect value={editing.etToolApplicable ?? null} onChange={(v) => setEditing({ ...editing, etToolApplicable: v })} />
              </Field>
              <Field label="Status">
                <select
                  className="input"
                  value={editing.isActive === false ? 'Inactive' : 'Active'}
                  onChange={(e) => setEditing({ ...editing, isActive: e.target.value === 'Active' })}
                >
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </Field>
            </div>
            {editing.id && editing.isActive === false && (
              <InfoBox>
                Inactive machines are kept on record — nothing about their history is deleted — but they
                will not appear in the next template generated for this rig.
              </InfoBox>
            )}
            {editing.id && (
              <InfoBox>
                To move this machine to another rig, yard, or other location, use Admin → Master →
                Transfer Equipment — the single, centralized place every equipment transfer is recorded.
              </InfoBox>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save</button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title={`Delete ${deleting?.name ?? ''}?`}
        confirmLabel="Delete equipment"
        busy={busy}
        body={
          deleteError
            ? <div className="text-red-800 whitespace-pre-wrap">{deleteError}</div>
            : <p>This machine and its record will be removed. This cannot be undone.</p>
        }
        onConfirm={() => void remove()}
        onCancel={() => { setDeleting(null); setDeleteError(''); }}
      />

      <Modal open={miOpen} title="Import Correct Master Data" onClose={() => setMiOpen(false)} width="max-w-3xl">
        <div className="space-y-3">
          <ErrorBox message={miError} onDismiss={() => setMiError('')} />
          {!miResult && (
            <InfoBox>
              Upload a Rig → Equipment → Make/Model/Sr.No → Oil workbook. Rig names are matched against
              Rig Master; equipment already on a matched rig is updated in place, new equipment is added,
              and anything on that rig this file doesn't mention is deactivated (never deleted — DRR/PMS/ILM
              history stays intact). The same run rebuilds Material Master (Engine/Transmission) and
              Oil &amp; Lubricant Master from this file — those two screens have no import of their own;
              after this they are managed by hand from the database.
            </InfoBox>
          )}

          {!miResult && (
            <Field label="Excel file">
              <input
                ref={miFileRef} type="file" accept=".xlsx,.xls" className="input"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickMasterImportFile(f); }}
              />
            </Field>
          )}

          {busy && !miPreview && !miResult && <Spinner label="Parsing workbook..." />}

          {miPreview && !miResult && (
            <>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="card p-3"><div className="text-xs text-slate-500">Rows parsed</div><div className="text-xl font-semibold">{miPreview.totalRows}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Rigs matched</div><div className="text-xl font-semibold text-emerald-700">{miPreview.matchedRigs}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Rigs unmatched</div><div className="text-xl font-semibold text-rose-700">{miPreview.unmatchedRigs}</div></div>
              </div>
              <div className="max-h-80 overflow-y-auto border border-slate-200 rounded-md">
                <table className="table text-xs">
                  <thead>
                    <tr><th>Rig in file</th><th>Matched to</th><th className="text-right">Equipment rows</th><th>Notes</th></tr>
                  </thead>
                  <tbody>
                    {miPreview.groups.map((g) => (
                      <tr key={g.rigNameRaw}>
                        <td className="font-medium">{g.rigNameRaw}</td>
                        <td>
                          {g.matchedRigId ? (
                            <span className="pill-normal">{g.matchedRigNumber} — {g.matchedRigName}</span>
                          ) : (
                            <span className="pill-place text-rose-700 bg-rose-50">Not found in Rig Master</span>
                          )}
                        </td>
                        <td className="num">{g.equipmentCount}</td>
                        <td className="text-slate-500">
                          {g.issues.map((issue, i) => (
                            <div key={i} className="flex items-start gap-1"><AlertTriangle size={11} className="mt-0.5 shrink-0" /> {issue}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {miPreview.unmatchedRigs > 0 && (
                <InfoBox>
                  Rig(s) not found in Rig Master will be skipped entirely on import — add them in Admin →
                  Rig Master first if they should be included, then re-upload.
                </InfoBox>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button className="btn-ghost" onClick={() => setMiOpen(false)}>Cancel</button>
                <button className="btn-primary" onClick={() => void confirmMasterImport()} disabled={busy || miPreview.matchedRigs === 0}>
                  Confirm Import
                </button>
              </div>
            </>
          )}

          {miResult && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div className="card p-3"><div className="text-xs text-slate-500">Rigs updated</div><div className="text-xl font-semibold">{miResult.rigsMatched}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Equipment created</div><div className="text-xl font-semibold text-emerald-700">{miResult.equipmentCreated}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Equipment updated</div><div className="text-xl font-semibold text-sky-700">{miResult.equipmentUpdated}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Equipment deactivated</div><div className="text-xl font-semibold text-amber-700">{miResult.equipmentDeactivated}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Rigs not matched</div><div className="text-xl font-semibold text-rose-700">{miResult.rigsUnmatched}</div></div>
              </div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide pt-1">
                Master catalogs rebuilt from this file — obsolete records removed
                {miResult.materialsRelinked > 0 && `, ${miResult.materialsRelinked} equipment link(s) repointed first`}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div className="card p-3"><div className="text-xs text-slate-500">Engine/Transmission added</div><div className="text-xl font-semibold text-emerald-700">{miResult.materialsCreated}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Engine/Transmission kept</div><div className="text-xl font-semibold text-sky-700">{miResult.materialsUpdated}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Engine/Transmission removed</div><div className="text-xl font-semibold text-amber-700">{miResult.materialsRemoved}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Oil/Lubricant types added</div><div className="text-xl font-semibold text-emerald-700">{miResult.oilLubricantsCreated}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Oil/Lubricant removed</div><div className="text-xl font-semibold text-amber-700">{miResult.oilLubricantsRemoved}</div></div>
                <div className="card p-3"><div className="text-xs text-slate-500">Equipment linked to catalog</div><div className="text-xl font-semibold text-sky-700">{miResult.equipmentLinked}</div></div>
              </div>
              {miResult.unmatchedRigNames.length > 0 && (
                <InfoBox>Not found in Rig Master, skipped: {miResult.unmatchedRigNames.join(', ')}</InfoBox>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button className="btn-primary" onClick={() => setMiOpen(false)}>Done</button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal open={miHistoryOpen} title="Master Data Import History" onClose={() => setMiHistoryOpen(false)} width="max-w-3xl">
        {!miHistory ? <Spinner /> : miHistory.length === 0 ? (
          <Empty message="No master-data imports have been run yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>File</th><th>By</th><th>When</th><th className="text-right">Rigs</th>
                  <th className="text-right">Equip. +</th><th className="text-right">Equip. upd.</th>
                  <th className="text-right">Equip. −</th>
                  <th className="text-right">Eng/Trans +</th><th className="text-right">Eng/Trans −</th>
                  <th className="text-right">Oils +</th><th className="text-right">Oils −</th>
                </tr>
              </thead>
              <tbody>
                {miHistory.map((h) => (
                  <tr key={h.id}>
                    <td className="font-medium">{h.fileName}</td>
                    <td>{h.importedBy}</td>
                    <td className="whitespace-nowrap">{new Date(h.importedAt).toLocaleString('en-IN')}</td>
                    <td className="num">{h.rigsMatched}</td>
                    <td className="num">{h.equipmentCreated}</td>
                    <td className="num">{h.equipmentUpdated}</td>
                    <td className="num">{h.equipmentDeactivated}</td>
                    <td className="num">{h.materialsCreated}</td>
                    <td className="num">{h.materialsRemoved}</td>
                    <td className="num">{h.oilLubricantsCreated}</td>
                    <td className="num">{h.oilLubricantsRemoved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Yes / No / Unknown — "unknown" (null) is a real, honest state, not the same as "No". */
function YesNoUnknownSelect({ value, onChange }: { value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <select
      className="input"
      value={value === null ? '' : value ? 'yes' : 'no'}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')}
    >
      <option value="">-</option>
      <option value="yes">Yes</option>
      <option value="no">No</option>
    </select>
  );
}
