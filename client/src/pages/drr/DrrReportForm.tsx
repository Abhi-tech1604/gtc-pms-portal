import { useEffect, useMemo, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Save, UserPlus, XCircle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { dateTime, todayIso } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import type {
  DprLineItem, DrrApprovalHistoryEntry, DrrAttendanceLine, DrrEquipmentLine, DrrHydraulicLine,
  DrrMyRigRoles, DrrOilLine, DrrPrefill, DrrReportDetail, DrrReportStatus,
} from '../../lib/types';
import { ConfirmDialog, ErrorBox, Field, InfoBox, Modal, PageHeader, Spinner, useBusy } from '../../components/ui';
import DprLineItemsEditor, { blankDprLine } from '../../components/DprLineItemsEditor';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Attendance rows still offer a Day/Night shift for the individual worker — unrelated to the (now removed) report-level Shift/Report Type field. */
const SHIFT_ENTRY_OPTIONS = ['Day', 'Night'];

/** Remaining Hours = hours available in a day − Total Hrs worked (Equipment Running Hours table). */
const AVAILABLE_HOURS_PER_DAY = 24;

function blankEquipmentLine(equipmentId: string, openingRunningHours: number): DrrEquipmentLine {
  return {
    equipmentId, openingRunningHours, dayHours: 0, nightHours: 0, hsdConsumption: 0, status: 'Running', remarks: null,
    serviceDoneToday: false, serviceHours: null,
  };
}

/**
 * The unified Daily Rig Report: Basic Info -> DPR Activity -> HSD Summary ->
 * Equipment Running Hours/Status -> Lubricating Oil -> Hydraulic Oil,
 * one Save that distributes into DPR/Mechanical Log/HSD server-side
 * (POST/PUT /api/drr/reports). Every closing/total value here is a display
 * mirror of what the server itself recomputes on save — the user can never
 * type into a calculated field.
 */
export default function DrrReportForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasModuleAction, user, isAdmin } = useAuth();
  const isNew = !id || id === 'new';
  const canCreate = hasModuleAction('DRR', 'create');
  // A report awaiting a decision is nobody's to edit — not the storekeeper's
  // (it's out of their hands until Approved/Rejected), and there is no
  // "edit while pending" step in the workflow. A report already Approved/
  // Submitted is likewise locked for everyone except Admin, who keeps this
  // app's usual "can fix anything" override. This single flag is what locks
  // every field below (they all already read `disabled={!canEdit}`), so
  // nothing else in the form needed to change.
  const [existingStatus, setExistingStatus] = useState<DrrReportStatus>('Draft');
  const canEdit = (isNew ? canCreate : hasModuleAction('DRR', 'edit'))
    && existingStatus !== 'PendingApproval'
    && (existingStatus !== 'Submitted' || isAdmin);

  const [pmsRigs, setPmsRigs] = useState<{ id: string; rigNumber: string; name: string }[]>([]);
  const [rigId, setRigId] = useState('');
  const [reportDate, setReportDate] = useState(todayIso());
  const [wellNo, setWellNo] = useState('');
  const [fieldLocation, setFieldLocation] = useState('');

  const [prefill, setPrefill] = useState<DrrPrefill | null>(null);
  const [hsdReceived, setHsdReceived] = useState(0);
  const [hsdRemarks, setHsdRemarks] = useState<string | null>(null);
  const [equipmentLines, setEquipmentLines] = useState<DrrEquipmentLine[]>([]);
  const [oilLines, setOilLines] = useState<DrrOilLine[]>([]);
  const [hydraulicLines, setHydraulicLines] = useState<DrrHydraulicLine[]>([]);
  const [attendanceLines, setAttendanceLines] = useState<DrrAttendanceLine[]>([]);
  const [showEmployeePicker, setShowEmployeePicker] = useState(false);
  const [pickedEmployeeId, setPickedEmployeeId] = useState('');
  const [dprLines, setDprLines] = useState<DprLineItem[]>([blankDprLine(1)]);

  /** Not shown in the UI (Shift/Report Type was removed), but preserved so re-saving an older report never silently rewrites its historical shift value to the new default. */
  const [existingShift, setExistingShift] = useState<string | null>(null);
  const [approvalHistory, setApprovalHistory] = useState<DrrApprovalHistoryEntry[]>([]);
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [submittedBy, setSubmittedBy] = useState<string | null>(null);
  const [approvedBy, setApprovedBy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(isNew);
  const [error, setError] = useState('');
  const [fieldIssues, setFieldIssues] = useState<{ field: string; message: string }[]>([]);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [busy, run] = useBusy();

  const [myRoles, setMyRoles] = useState<DrrMyRigRoles | null>(null);
  useEffect(() => {
    api.get<DrrMyRigRoles>('/drr/rig-responsibility/my').then(setMyRoles).catch(() => {});
  }, []);
  const isManagerForRig = !!myRoles && (myRoles.isAdmin || myRoles.managerRigIds.includes(rigId));

  const [rejecting, setRejecting] = useState(false);
  const [rejectReasonInput, setRejectReasonInput] = useState('');
  const [decisionBusy, runDecision] = useBusy();

  useEffect(() => {
    api.get<{ rigs: { id: string; rigNumber: string; name: string }[] }>('/drr/rigs').then((d) => setPmsRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  // Loading an existing report: populate everything from the saved payload.
  useEffect(() => {
    if (isNew) return;
    api.get<{ report: DrrReportDetail }>(`/drr/reports/${id}`).then((d) => {
      const r = d.report;
      setRigId(r.rigId); setReportDate(r.reportDate); setWellNo(r.wellNo ?? '');
      setFieldLocation(r.fieldLocation ?? ''); setExistingStatus(r.status); setExistingShift(r.shift ?? null);
      setApprovalHistory(r.approvalHistory ?? []); setRejectionReason(r.rejectionReason ?? null);
      setSubmittedBy(r.submittedAt ? r.submittedBy : null); setApprovedBy(r.approvedBy ?? null);
      setHsdReceived(r.hsdReceived ?? 0); setHsdRemarks(r.hsdRemarks ?? null);
      setEquipmentLines(r.equipmentLines ?? []); setOilLines(r.oilLines ?? []); setHydraulicLines(r.hydraulicLines ?? []);
      setAttendanceLines(r.attendanceLines ?? []);
      setDprLines(r.dprLines?.length ? r.dprLines : [blankDprLine(1)]);
      setLoaded(true);
    }).catch((e) => setError((e as Error).message));
  }, [id, isNew]);

  // Rig + Date selected -> load equipment/master data + carried-forward openings.
  useEffect(() => {
    if (!rigId || !reportDate) { setPrefill(null); return; }
    api.get<DrrPrefill>(`/drr/prefill?rigId=${rigId}&reportDate=${reportDate}`)
      .then((p) => {
        setPrefill(p);
        if (isNew) {
          setEquipmentLines(p.equipment.map((e) => blankEquipmentLine(e.equipmentId, e.openingRunningHours)));
          setOilLines(p.oilTypes.map((o) => ({ equipmentId: null, oilType: o.oilType, openingBalance: o.openingBalance ?? 0, oilAdded: 0, oilConsumed: 0, remark: null })));
          setHydraulicLines(p.hydraulicTanks.map((t) => ({ tankName: t.tankName, openingLevel: t.openingLevel ?? 0, topUp: 0, loss: 0, remark: null })));
          // Site Attendance always starts empty — it records the day's ACTUAL
          // manpower, entered by the Rig User. The roster (p.manpower) is
          // reference-only and must never pre-decide who's here or absent.
          setAttendanceLines([]);
        }
      })
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigId, reportDate, isNew]);

  const equipmentMeta = useMemo(() => new Map((prefill?.equipment ?? []).map((e) => [e.equipmentId, e])), [prefill]);

  function updateEquipmentLine(i: number, patch: Partial<DrrEquipmentLine>) {
    setEquipmentLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function updateOilLine(i: number, patch: Partial<DrrOilLine>) {
    setOilLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function updateHydraulicLine(i: number, patch: Partial<DrrHydraulicLine>) {
    setHydraulicLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function updateAttendanceLine(i: number, patch: Partial<DrrAttendanceLine>) {
    setAttendanceLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeAttendanceLine(i: number) {
    setAttendanceLines((prev) => prev.filter((_, idx) => idx !== i));
  }
  /**
   * Adds a real employee from Employee Master to today's attendance. The
   * roster (if any covers this rig+date) is copied in purely as a reference
   * indicator — `rosterStatus` never decides `attendanceStatus`, which
   * always starts blank for the Rig User to record directly (roster-ON does
   * not imply Present; roster-OFF does not imply Absent).
   */
  function addEmployeeFromMaster(employeeId: string) {
    if (!prefill || attendanceLines.some((l) => l.employeeId === employeeId)) return;
    const emp = prefill.employees.find((e) => e.id === employeeId);
    if (!emp) return;
    const roster = prefill.manpower.find((m) => m.employeeId === employeeId);
    setAttendanceLines((prev) => [...prev, {
      employeeId: emp.id, employeeName: emp.name, employeeCode: emp.employeeCode,
      designation: roster?.designation ?? emp.defaultDesignation, rosterStatus: roster?.rosterStatus ?? null,
      attendanceStatus: '', shift: roster?.shift ?? null, inTime: null, outTime: null,
      isTemporary: false, remarks: null,
    }]);
  }
  /** A worker not in Employee Master — onsite for the day only, entered by name. */
  function addTemporaryEmployee() {
    setAttendanceLines((prev) => [...prev, {
      employeeId: null, employeeName: '', employeeCode: null, designation: null, rosterStatus: null,
      attendanceStatus: '', shift: null, inTime: null, outTime: null, isTemporary: true, remarks: null,
    }]);
  }

  const totalHsdConsumption = useMemo(() => round2(equipmentLines.reduce((n, l) => n + l.hsdConsumption, 0)), [equipmentLines]);
  const totalAvailableHsd = round2((prefill?.hsdOpeningStock ?? 0) + hsdReceived);
  const closingHsd = round2(totalAvailableHsd - totalHsdConsumption);

  function issueFor(field: string): string | undefined {
    return fieldIssues.find((i) => i.field === field)?.message;
  }

  async function save(status: 'Draft' | 'PendingApproval', confirmReplace = false) {
    setError(''); setFieldIssues([]); setDuplicate(null);
    const payload = {
      rigId, reportDate, wellNo, fieldLocation: fieldLocation || null,
      // Not user-editable (Shift/Report Type was removed from the form); an
      // existing report keeps its original shift, a new one lets the server
      // default it — either way this never silently rewrites history.
      ...(existingShift ? { shift: existingShift } : {}),
      hsdReceived, hsdRemarks,
      equipmentLines, oilLines, hydraulicLines, attendanceLines, dprLines,
      status,
    };
    try {
      const saved = await run(() => (
        isNew
          ? api.post<DrrReportDetail>('/drr/reports', payload)
          : api.put<DrrReportDetail>(`/drr/reports/${id}`, payload)
      ));
      navigate(`/drr/reports/${saved.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        const d = e.details as { issues?: { field: string; message: string }[] } | undefined;
        if (d?.issues) { setFieldIssues(d.issues); setError(e.message); return; }
      }
      if (e instanceof ApiError && e.status === 409) { setDuplicate(e.message); return; }
      setError((e as Error).message);
    }
  }

  /** Admin-only: re-saves an already-Submitted report directly as Submitted, bypassing the approval workflow — the server accepts this status value from this route for Admin alone. */
  async function saveAdminOverride() {
    if (!id) return;
    setError(''); setFieldIssues([]); setDuplicate(null);
    const payload = {
      rigId, reportDate, wellNo, fieldLocation: fieldLocation || null,
      ...(existingShift ? { shift: existingShift } : {}),
      hsdReceived, hsdRemarks,
      equipmentLines, oilLines, hydraulicLines, attendanceLines, dprLines,
      status: 'Submitted',
    };
    try {
      const saved = await run(() => api.put<DrrReportDetail>(`/drr/reports/${id}`, payload));
      navigate(`/drr/reports/${saved.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        const d = e.details as { issues?: { field: string; message: string }[] } | undefined;
        if (d?.issues) { setFieldIssues(d.issues); setError(e.message); return; }
      }
      setError((e as Error).message);
    }
  }

  async function approve() {
    if (!id) return;
    setError('');
    try {
      const saved = await runDecision(() => api.post<DrrReportDetail>(`/drr/reports/${id}/approve`, {}));
      setExistingStatus(saved.status); setApprovedBy(saved.approvedBy ?? null); setApprovalHistory(saved.approvalHistory ?? []);
    } catch (e) { setError((e as Error).message); }
  }

  async function reject() {
    if (!id || !rejectReasonInput.trim()) return;
    setError('');
    try {
      const saved = await runDecision(() => api.post<DrrReportDetail>(`/drr/reports/${id}/reject`, { reason: rejectReasonInput.trim() }));
      setExistingStatus(saved.status); setRejectionReason(saved.rejectionReason ?? null); setApprovalHistory(saved.approvalHistory ?? []);
      setRejecting(false); setRejectReasonInput('');
    } catch (e) { setError((e as Error).message); }
  }

  if (!loaded) return <Spinner />;

  const selectedRig = pmsRigs.find((r) => r.id === rigId);
  const hasPermission = isNew ? canCreate : hasModuleAction('DRR', 'edit');

  return (
    <div>
      <PageHeader
        title={isNew ? 'New Daily Rig Report' : `Daily Rig Report — ${selectedRig?.rigNumber ?? ''} · ${reportDate}`}
        subtitle="One entry updates DPR, Mechanical Log and HSD together."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      {!hasPermission && <InfoBox>Ask an administrator for Daily Rig Report {isNew ? 'create' : 'edit'} access to save changes here.</InfoBox>}

      {!isNew && existingStatus === 'PendingApproval' && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 mb-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Pending Approval</div>
            Submitted {submittedBy ? `by ${submittedBy}` : ''} — waiting on this rig's Operational Manager. The
            form is locked until it is approved or rejected.
          </div>
        </div>
      )}
      {!isNew && existingStatus === 'Rejected' && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 mb-3">
          <XCircle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Rejected{approvalHistory.length ? ` by ${approvalHistory[approvalHistory.length - 1].byUser}` : ''}</div>
            {rejectionReason && <div>Reason: {rejectionReason}</div>}
            Correct the report below and resubmit for approval.
          </div>
        </div>
      )}
      {!isNew && existingStatus === 'Submitted' && approvedBy && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 mb-3">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <div className="font-medium">Approved by {approvedBy}</div>
        </div>
      )}

      {/* 1. Basic Information */}
      <div className="card p-4 mb-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Basic Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Date *">
            <input className="input" type="date" value={reportDate} disabled={!canEdit || !isNew}
              onChange={(e) => setReportDate(e.target.value)} />
          </Field>
          <Field label="Rig No. *">
            <select className="input" value={rigId} disabled={!canEdit || !isNew}
              onChange={(e) => setRigId(e.target.value)}>
              <option value="">Choose a rig...</option>
              {pmsRigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
            </select>
          </Field>
          <Field label="Well No. *" hint={issueFor('wellNo')}>
            <input className="input" list="drr-well-suggestions" disabled={!canEdit} value={wellNo}
              onChange={(e) => setWellNo(e.target.value)} />
            <datalist id="drr-well-suggestions">
              {(prefill?.wellSuggestions ?? []).map((w) => <option key={w} value={w} />)}
            </datalist>
          </Field>
          <Field label="Field / Location">
            <input className="input" disabled={!canEdit} value={fieldLocation} onChange={(e) => setFieldLocation(e.target.value)} />
          </Field>
          <Field label="Submitted By">
            <input className="input bg-slate-50" disabled value={user?.name ?? user?.username ?? ''} />
          </Field>
        </div>
      </div>

      {!prefill ? (
        rigId && reportDate ? <Spinner label="Loading rig equipment and previous closing values..." /> : (
          <InfoBox>Select a rig and date to load its equipment and carried-forward opening values.</InfoBox>
        )
      ) : (
        <>
          {isNew && !prefill.previousReportDate && (
            <InfoBox>
              No previous Daily Rig Report was found for {prefill.rig.rigNumber} — this looks like the first entry for
              this rig. Opening Stock, Opening Hours and Opening Balances below are starting from Equipment/Oil Master
              defaults (usually 0), not carried-forward data. Double-check them before saving.
            </InfoBox>
          )}

          {/* 1b. Site Attendance — the day's ACTUAL manpower, recorded directly by the Rig User. Manpower Roster is reference-only (small "Scheduled: ON/OFF" tag) and never pre-decides attendance. */}
          <div className="card p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-700">Site Attendance</h3>
              {canEdit && (
                <div className="flex items-center gap-2">
                  <button type="button" className="btn-ghost btn-sm" onClick={addTemporaryEmployee}>+ Add Temporary / Onsite Worker</button>
                  <button type="button" className="btn-primary btn-sm" onClick={() => setShowEmployeePicker((v) => !v)}>
                    <UserPlus size={12} /> Add Employee
                  </button>
                </div>
              )}
            </div>

            {canEdit && showEmployeePicker && (
              <div className="flex items-center gap-2 mb-3 p-2 bg-slate-50 rounded-md">
                <select
                  className="input flex-1"
                  value={pickedEmployeeId}
                  onChange={(e) => setPickedEmployeeId(e.target.value)}
                >
                  <option value="">Choose from Employee Master...</option>
                  {prefill.employees
                    .filter((e) => !attendanceLines.some((l) => l.employeeId === e.id))
                    .map((e) => {
                      // Prefer what Admin actually set in Manpower Roster for
                      // THIS rig — designation and ON/OFF — over the
                      // employee's global default; that default is only a
                      // fallback for someone not rostered here at all, so the
                      // dropdown always reflects the roster it's showing next to.
                      const roster = prefill.manpower.find((m) => m.employeeId === e.id);
                      const designation = roster?.designation ?? e.defaultDesignation;
                      const rosterTag = roster ? ` [Rostered ${roster.rosterStatus}]` : ' [Not on this rig\'s roster]';
                      return (
                        <option key={e.id} value={e.id}>
                          {e.name}{e.employeeCode ? ` (${e.employeeCode})` : ''}{designation ? ` — ${designation}` : ''}{rosterTag}
                        </option>
                      );
                    })}
                </select>
                <button
                  type="button" className="btn-primary btn-sm" disabled={!pickedEmployeeId}
                  onClick={() => { addEmployeeFromMaster(pickedEmployeeId); setPickedEmployeeId(''); setShowEmployeePicker(false); }}
                >
                  Add
                </button>
                <button type="button" className="btn-ghost btn-sm" onClick={() => { setShowEmployeePicker(false); setPickedEmployeeId(''); }}>Cancel</button>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th>Employee</th><th>Employee ID</th><th>Designation</th><th>Attendance</th>
                    <th>Shift</th><th>In Time</th><th>Out Time</th><th>Remarks</th>{canEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {attendanceLines.map((l, i) => {
                    const isDuplicate = !!l.employeeId && attendanceLines.filter((o) => o.employeeId === l.employeeId).length > 1;
                    return (
                      <tr key={i}>
                        <td>
                          {l.isTemporary ? (
                            <input className="input min-w-[160px]" disabled={!canEdit} placeholder="Employee name"
                              value={l.employeeName} onChange={(e) => updateAttendanceLine(i, { employeeName: e.target.value })} />
                          ) : (
                            <span className="font-medium">{l.employeeName}</span>
                          )}
                          {l.rosterStatus && (
                            <div className="text-slate-400 mt-0.5">Scheduled: {l.rosterStatus}</div>
                          )}
                          {isDuplicate && <div className="text-red-600 mt-0.5">Already has an entry in this report.</div>}
                        </td>
                        <td className="text-slate-500 whitespace-nowrap">
                          {l.isTemporary ? (
                            <input className="input min-w-[100px]" disabled={!canEdit} placeholder="Optional"
                              value={l.employeeCode ?? ''} onChange={(e) => updateAttendanceLine(i, { employeeCode: e.target.value || null })} />
                          ) : (l.employeeCode ?? '-')}
                        </td>
                        <td>
                          {l.isTemporary ? (
                            <input className="input min-w-[140px]" disabled={!canEdit} placeholder="Designation"
                              value={l.designation ?? ''} onChange={(e) => updateAttendanceLine(i, { designation: e.target.value })} />
                          ) : (l.designation ?? '-')}
                        </td>
                        <td>
                          <select className={`input ${!l.attendanceStatus ? 'border-red-300' : ''}`} disabled={!canEdit} value={l.attendanceStatus}
                            onChange={(e) => updateAttendanceLine(i, { attendanceStatus: e.target.value as DrrAttendanceLine['attendanceStatus'] })}>
                            <option value="">Select...</option>
                            <option value="Present">Present</option>
                            <option value="Absent">Absent</option>
                            <option value="Leave">Leave</option>
                          </select>
                        </td>
                        <td>
                          <select className="input min-w-[90px]" disabled={!canEdit} value={l.shift ?? ''}
                            onChange={(e) => updateAttendanceLine(i, { shift: e.target.value || null })}>
                            <option value="">-</option>
                            {SHIFT_ENTRY_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                        <td><input className="input w-24" type="time" disabled={!canEdit} value={l.inTime ?? ''} onChange={(e) => updateAttendanceLine(i, { inTime: e.target.value || null })} /></td>
                        <td><input className="input w-24" type="time" disabled={!canEdit} value={l.outTime ?? ''} onChange={(e) => updateAttendanceLine(i, { outTime: e.target.value || null })} /></td>
                        <td><input className="input min-w-[140px]" disabled={!canEdit} value={l.remarks ?? ''} onChange={(e) => updateAttendanceLine(i, { remarks: e.target.value || null })} /></td>
                        {canEdit && (
                          <td><button type="button" className="btn-ghost btn-sm text-red-700" onClick={() => removeAttendanceLine(i)}>Remove</button></td>
                        )}
                      </tr>
                    );
                  })}
                  {attendanceLines.length === 0 && (
                    <tr><td colSpan={canEdit ? 9 : 8} className="text-center text-slate-400">No attendance recorded yet — use "Add Employee" to record who's on site today.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 2. DPR Activity */}
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-2 px-1">DPR Activity</h3>
            <DprLineItemsEditor
              lines={dprLines} canEdit={canEdit} onChange={setDprLines}
              equipmentOptions={prefill.equipment.map((e) => ({ id: e.equipmentId, name: e.name }))}
            />
          </div>

          {/* 3. HSD / Diesel Summary */}
          <div className="card p-4 mb-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">HSD Summary</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <Calculated
                label="Opening Stock (L)" value={prefill.hsdOpeningStock}
                hint={prefill.previousReportDate ? `Auto: closing balance from ${prefill.previousReportDate}` : 'No previous report for this rig — starting from 0'}
              />
              <Field label="HSD Received / Top-up (L)">
                <input className="input" type="number" min={0} disabled={!canEdit} value={hsdReceived}
                  onChange={(e) => setHsdReceived(Number(e.target.value) || 0)} />
              </Field>
              <Calculated label="Total Available HSD (L)" value={totalAvailableHsd} />
              <Calculated label="Total Consumption (L)" value={totalHsdConsumption} />
              <Calculated label="Closing HSD (L)" value={closingHsd} warn={closingHsd < 0} />
            </div>
            <Field label="HSD Remarks">
              <input className="input" disabled={!canEdit} value={hsdRemarks ?? ''} onChange={(e) => setHsdRemarks(e.target.value || null)} />
            </Field>
          </div>

          {/* 4. Equipment Running Hours + Status */}
          <div className="card mb-4">
            <div className="card-header"><h3 className="card-title">Equipment Running Hours &amp; Status</h3></div>
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th>Equipment</th><th>Make/Model</th><th>Serial No.</th>
                    <th className="text-right">Day Hrs *</th>
                    <th className="text-right">Night Hrs *</th><th className="text-right">Total Hrs</th>
                    <th className="text-right">Last Service Since</th>
                    <th className="text-right">HSD Consumption</th>
                    <th className="text-right">Remaining Hours</th><th>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {equipmentLines.map((l, i) => {
                    const meta = equipmentMeta.get(l.equipmentId);
                    const total = round2(l.dayHours + l.nightHours);
                    const closing = round2(l.openingRunningHours + total);
                    return (
                      <>
                        <tr key={l.equipmentId}>
                          <td className="font-medium whitespace-nowrap">{meta?.name ?? l.equipmentId}</td>
                          <td className="text-slate-500">{[meta?.manufacturer, meta?.model].filter(Boolean).join(' ') || '-'}</td>
                          <td className="text-slate-500">{meta?.serialNumber ?? '-'}</td>
                          <td><input className="input w-20 text-right" type="number" min={0} disabled={!canEdit}
                            value={l.dayHours} onChange={(e) => updateEquipmentLine(i, { dayHours: Number(e.target.value) || 0 })} /></td>
                          <td><input className="input w-20 text-right" type="number" min={0} disabled={!canEdit}
                            value={l.nightHours} onChange={(e) => updateEquipmentLine(i, { nightHours: Number(e.target.value) || 0 })} /></td>
                          <td><input className="input bg-slate-50 w-20 text-right" disabled value={total} title="Auto-calculated" /></td>
                          <td><input className="input bg-slate-50 w-24 text-right" disabled value={meta?.lastServiceHours ?? 0} title="Latest recorded service hours for this machine (Equipment Master / PMS service record)" /></td>
                          <td><input className="input w-24 text-right" type="number" min={0} disabled={!canEdit}
                            value={l.hsdConsumption} onChange={(e) => updateEquipmentLine(i, { hsdConsumption: Number(e.target.value) || 0 })} /></td>
                          <td>
                            <input
                              className={`input bg-slate-50 w-24 text-right ${round2(AVAILABLE_HOURS_PER_DAY - total) < 0 ? 'text-red-700' : ''}`}
                              disabled value={round2(AVAILABLE_HOURS_PER_DAY - total)}
                              title={`${AVAILABLE_HOURS_PER_DAY} hrs available for the day − ${total} hrs worked`}
                            />
                          </td>
                          <td><input className="input min-w-[140px]" disabled={!canEdit}
                            value={l.remarks ?? ''} onChange={(e) => updateEquipmentLine(i, { remarks: e.target.value || null })} /></td>
                        </tr>
                        {l.status === 'Breakdown' && (
                          <tr key={`${l.equipmentId}-bd`} className="bg-red-50">
                            <td colSpan={11}>
                              <div className="flex items-center gap-1 text-red-800 font-medium mb-2"><AlertTriangle size={12} /> Breakdown Details</div>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                <Field label="Breakdown Date/Time">
                                  <input className="input" type="datetime-local" disabled={!canEdit} value={l.breakdownAt ?? ''}
                                    onChange={(e) => updateEquipmentLine(i, { breakdownAt: e.target.value || null })} />
                                </Field>
                                <Field label="Breakdown Description *">
                                  <input className="input" disabled={!canEdit} value={l.breakdownDescription ?? ''}
                                    onChange={(e) => updateEquipmentLine(i, { breakdownDescription: e.target.value || null })} />
                                </Field>
                                <Field label="Action Taken">
                                  <input className="input" disabled={!canEdit} value={l.actionTaken ?? ''}
                                    onChange={(e) => updateEquipmentLine(i, { actionTaken: e.target.value || null })} />
                                </Field>
                                <Field label="Parts Required">
                                  <input className="input" disabled={!canEdit} value={l.partsRequired ?? ''}
                                    onChange={(e) => updateEquipmentLine(i, { partsRequired: e.target.value || null })} />
                                </Field>
                                <Field label="Expected Restoration">
                                  <input className="input" type="date" disabled={!canEdit} value={l.expectedRestoration ?? ''}
                                    onChange={(e) => updateEquipmentLine(i, { expectedRestoration: e.target.value || null })} />
                                </Field>
                                <Field label="Breakdown Remark">
                                  <input className="input" disabled={!canEdit} value={l.breakdownRemark ?? ''}
                                    onChange={(e) => updateEquipmentLine(i, { breakdownRemark: e.target.value || null })} />
                                </Field>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                  {equipmentLines.length === 0 && <tr><td colSpan={11} className="text-center text-slate-400 py-6">This rig has no active equipment on record.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {/* 5. Lubricating Oil */}
          <div className="card mb-4">
            <div className="card-header"><h3 className="card-title">Lubricating Oil</h3></div>
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr><th>Oil Type</th><th className="text-right">Opening Bal.</th><th className="text-right">Added</th>
                    <th className="text-right">Consumed</th><th className="text-right">Closing Bal.</th><th>Remark</th></tr>
                </thead>
                <tbody>
                  {oilLines.map((l, i) => {
                    const closing = round2(l.openingBalance + l.oilAdded - l.oilConsumed);
                    return (
                      <tr key={l.oilType}>
                        <td className="font-medium whitespace-nowrap">{l.oilType}</td>
                        <td><input className="input bg-slate-50 w-24 text-right" disabled value={l.openingBalance} title={prefill.previousReportDate ? `Auto: closing balance from ${prefill.previousReportDate}` : 'No previous report for this rig — starting from 0'} /></td>
                        <td><input className="input w-20 text-right" type="number" min={0} disabled={!canEdit}
                          value={l.oilAdded} onChange={(e) => updateOilLine(i, { oilAdded: Number(e.target.value) || 0 })} /></td>
                        <td><input className="input w-20 text-right" type="number" min={0} disabled={!canEdit}
                          value={l.oilConsumed} onChange={(e) => updateOilLine(i, { oilConsumed: Number(e.target.value) || 0 })} /></td>
                        <td><input className={`input w-24 text-right bg-slate-50 ${closing < 0 ? 'text-red-700' : ''}`} disabled value={closing} title="Auto-calculated" /></td>
                        <td><input className="input min-w-[140px]" disabled={!canEdit}
                          value={l.remark ?? ''} onChange={(e) => updateOilLine(i, { remark: e.target.value || null })} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 6. Hydraulic Oil */}
          <div className="card mb-4">
            <div className="card-header"><h3 className="card-title">Hydraulic Oil</h3></div>
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr><th>Tank</th><th className="text-right">Opening Level</th><th className="text-right">Top-up</th>
                    <th className="text-right">Loss</th><th className="text-right">Closing Level</th><th>Remark</th></tr>
                </thead>
                <tbody>
                  {hydraulicLines.map((l, i) => {
                    const closing = round2(l.openingLevel + l.topUp - l.loss);
                    return (
                      <tr key={l.tankName}>
                        <td className="font-medium whitespace-nowrap">{l.tankName}</td>
                        <td><input className="input bg-slate-50 w-24 text-right" disabled value={l.openingLevel} title={prefill.previousReportDate ? `Auto: closing level from ${prefill.previousReportDate}` : 'No previous report for this rig — starting from 0'} /></td>
                        <td><input className="input w-20 text-right" type="number" min={0} disabled={!canEdit}
                          value={l.topUp} onChange={(e) => updateHydraulicLine(i, { topUp: Number(e.target.value) || 0 })} /></td>
                        <td><input className="input w-20 text-right" type="number" min={0} disabled={!canEdit}
                          value={l.loss} onChange={(e) => updateHydraulicLine(i, { loss: Number(e.target.value) || 0 })} /></td>
                        <td><input className={`input w-24 text-right bg-slate-50 ${closing < 0 ? 'text-red-700' : ''}`} disabled value={closing} title="Auto-calculated" /></td>
                        <td><input className="input min-w-[140px]" disabled={!canEdit}
                          value={l.remark ?? ''} onChange={(e) => updateHydraulicLine(i, { remark: e.target.value || null })} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {fieldIssues.length > 0 && (
        <div className="border border-red-200 bg-red-50 rounded-md p-3 mb-4">
          <div className="flex items-center gap-2 text-red-800 font-medium text-sm mb-2"><AlertTriangle size={14} /> Fix these before saving</div>
          <ul className="text-sm text-red-800 space-y-1 list-disc list-inside">
            {fieldIssues.map((i, n) => <li key={n}>{i.message}</li>)}
          </ul>
        </div>
      )}

      {/*
        Which action bar shows is entirely a function of existingStatus:
        Draft (or a brand-new report) -> Save Draft + Submit for Approval.
        Rejected -> correct the fields above, then Resubmit (no Save Draft —
        the server only accepts Draft/Rejected -> PendingApproval, not a step
        back to Draft). PendingApproval -> no save controls at all, canEdit
        is already false; Approve/Reject render below instead, gated on
        being this rig's assigned Operational Manager. Submitted -> unchanged
        from before this feature (still freely editable/re-saveable).
      */}
      {canEdit && existingStatus === 'Draft' && (
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => navigate('/drr/reports')} disabled={busy}>Cancel</button>
          <button className="btn-ghost" onClick={() => void save('Draft')} disabled={busy || !rigId || !reportDate}>Save Draft</button>
          <button className="btn-primary" onClick={() => void save('PendingApproval')} disabled={busy || !rigId || !reportDate}>
            <Save size={14} /> Submit for Approval
          </button>
        </div>
      )}
      {canEdit && existingStatus === 'Rejected' && (
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => navigate('/drr/reports')} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void save('PendingApproval')} disabled={busy || !rigId || !reportDate}>
            <Save size={14} /> Resubmit for Approval
          </button>
        </div>
      )}
      {canEdit && existingStatus === 'Submitted' && (
        // Admin-only override (see canEdit above) — edits and re-saves an
        // already-approved report directly, bypassing the approval workflow
        // on purpose, exactly as any user could before this feature existed.
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => navigate('/drr/reports')} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void saveAdminOverride()} disabled={busy || !rigId || !reportDate}>
            <Save size={14} /> Save Daily Report
          </button>
        </div>
      )}

      {!isNew && existingStatus === 'PendingApproval' && isManagerForRig && (
        <div className="flex justify-end gap-2">
          <button className="btn-ghost text-red-700" onClick={() => setRejecting(true)} disabled={decisionBusy}>
            <XCircle size={14} /> Reject
          </button>
          <button className="btn-primary" onClick={() => void approve()} disabled={decisionBusy}>
            <CheckCircle2 size={14} /> Approve
          </button>
        </div>
      )}

      {approvalHistory.length > 0 && (
        <div className="card p-4 mt-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Approval History</h3>
          <ul className="text-xs text-slate-600 space-y-1">
            {approvalHistory.map((h) => (
              <li key={h.id}>
                <span className="font-medium">{h.action}</span> by {h.byUser} — {dateTime(h.atTime)}
                {h.reason ? ` — "${h.reason}"` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Modal open={rejecting} title="Reject Daily Rig Report" onClose={() => setRejecting(false)}>
        <Field label="Rejection Reason *" hint="Sent back to the Storekeeper, who must correct and resubmit.">
          <textarea
            className="input" rows={3} value={rejectReasonInput}
            onChange={(e) => setRejectReasonInput(e.target.value)}
          />
        </Field>
        <div className="flex justify-end gap-2 pt-3">
          <button className="btn-ghost" onClick={() => setRejecting(false)} disabled={decisionBusy}>Cancel</button>
          <button className="btn-primary" onClick={() => void reject()} disabled={decisionBusy || !rejectReasonInput.trim()}>
            Reject
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!duplicate}
        tone="danger"
        title="A Daily Rig Report already exists for this rig and date"
        confirmLabel="Dismiss"
        body={<p>{duplicate}</p>}
        onConfirm={() => setDuplicate(null)}
        onCancel={() => setDuplicate(null)}
      />
    </div>
  );
}

function Calculated({ label, value, warn, hint }: { label: string; value: number | string; warn?: boolean; hint?: string }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className={`input bg-slate-50 font-medium ${warn ? 'text-red-700 border-red-300' : ''}`} disabled value={value} title={hint ?? 'Auto-calculated'} />
    </div>
  );
}
