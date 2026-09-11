import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { DprLineItem } from '../lib/types';
import {
  DPR_ACTIVITY_CODES, DPR_BIT_SIZES, DPR_CASING_SIZES, DPR_WORK_TYPES,
  isBreakdownOperation, isCasingOperation, isDrillingOperation,
} from '../lib/dprLists';

/**
 * The DPR activity table — mapped field-for-field from the DPR Excel
 * template, same as manual entry has always done (DprEntry.tsx). Extracted
 * so the Daily Rig Report form's "DPR Activity" section can embed the exact
 * same editor rather than a re-invented one; DprEntry.tsx itself now just
 * renders this component, unchanged in behavior.
 *
 * "Breakdown Equip." is the one column that is NOT a static list: it comes
 * from the caller as `equipmentOptions`, sourced live from PMS's Equipment
 * Master for whichever rig is selected (GET /dpr/equipment?rigId=) — the
 * single equipment master in this app, never a second hardcoded list.
 */

/** Operation code that unlocks the free-text "Other Activity" field, word-capped below. */
const OTHER_OPERATION_CODE = '23 - Other';
const OTHER_ACTIVITY_MAX_WORDS = 35;

export function blankDprLine(lineNo: number): DprLineItem {
  return {
    lineNo, wellName: '', operationCode: '', workType: '', startTime: '', endTime: '',
    totalHours: null, description: '', breakdownEquipment: '', breakdownEquipmentId: null, breakdownReason: '',
    drillingSection: '', drillingFrom: null, drillingTo: null, drillingTotal: null,
    casingSection: '', casingFrom: null, casingTo: null, casingTotal: null,
    otherActivityDescription: '',
  };
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** Rejects (rather than silently allows) typing past the word cap — the value can never exceed max words once entered through this control. */
function capWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= max) return text;
  return words.slice(0, max).join(' ');
}

export function computeDprTotalHours(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  const s = sh * 60 + sm; const e = eh * 60 + em;
  const diff = e >= s ? e - s : 1440 + e - s;
  return Math.round((diff / 60) * 100) / 100;
}

function delta(from: number | null, to: number | null): number | null {
  return from !== null && to !== null ? Math.round((to - from) * 100) / 100 : null;
}

/** Keeps a value from an older/Excel-imported row selectable even if it's not in the current list, rather than silently clearing it. */
function withCurrentValue(list: string[], value: string | null | undefined): string[] {
  return value && !list.includes(value) ? [value, ...list] : list;
}

export function applyDprLinePatch(line: DprLineItem, patch: Partial<DprLineItem>): DprLineItem {
  const next = { ...line, ...patch };
  next.totalHours = computeDprTotalHours(next.startTime, next.endTime);
  next.drillingTotal = delta(next.drillingFrom, next.drillingTo);
  next.casingTotal = delta(next.casingFrom, next.casingTo);
  return next;
}

export default function DprLineItemsEditor({ lines, canEdit, onChange, equipmentOptions }: {
  lines: DprLineItem[];
  canEdit: boolean;
  onChange: (lines: DprLineItem[]) => void;
  /** Live from Equipment Master for the selected rig; empty until a rig is chosen. */
  equipmentOptions: { id: string; name: string }[];
}) {
  function updateLine(index: number, patch: Partial<DprLineItem>) {
    onChange(lines.map((l, i) => (i === index ? applyDprLinePatch(l, patch) : l)));
  }
  function addLine() { onChange([...lines, blankDprLine(lines.length + 1)]); }
  function removeLine(index: number) {
    onChange(lines.filter((_, i) => i !== index).map((l, i) => ({ ...l, lineNo: i + 1 })));
  }

  return (
    <div className="card mb-4">
      <div className="card-header">
        <h3 className="card-title">Daily Activities</h3>
        {canEdit && (
          <button className="btn-ghost btn-sm" onClick={addLine} type="button"><Plus size={12} /> Add Row</button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="table text-xs">
          <thead>
            <tr>
              <th>Well</th><th>Operation</th><th>Work Type</th><th>Start</th><th>End</th><th>Total (h)</th>
              <th>Description / Remarks</th><th>Breakdown Equip.</th><th>Breakdown Reason</th>
              <th>Drill Sec.</th><th>Drill From</th><th>Drill To</th><th>Drill Total</th>
              <th>Casing Sec.</th><th>Casing From</th><th>Casing To</th><th>Casing Total</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const showDrilling = isDrillingOperation(l.operationCode) || l.drillingSection || l.drillingFrom !== null || l.drillingTo !== null;
              const showCasing = isCasingOperation(l.operationCode) || l.casingSection || l.casingFrom !== null || l.casingTo !== null;
              const showBreakdown = isBreakdownOperation(l.operationCode) || l.breakdownEquipment || l.breakdownReason;
              const showOther = l.operationCode === OTHER_OPERATION_CODE;
              const otherWords = wordCount(l.otherActivityDescription ?? '');
              return (
              <>
              <tr key={i}>
                <Cell><input className="input" disabled={!canEdit} value={l.wellName ?? ''} onChange={(e) => updateLine(i, { wellName: e.target.value })} /></Cell>
                <Cell>
                  <select className="input" disabled={!canEdit} value={l.operationCode ?? ''} onChange={(e) => updateLine(i, { operationCode: e.target.value })}>
                    <option value="">-</option>
                    {withCurrentValue(DPR_ACTIVITY_CODES, l.operationCode).map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </Cell>
                <Cell>
                  <select className="input" disabled={!canEdit} value={l.workType ?? ''} onChange={(e) => updateLine(i, { workType: e.target.value })}>
                    <option value="">-</option>
                    {withCurrentValue(DPR_WORK_TYPES, l.workType).map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </Cell>
                <Cell><input className="input" type="time" disabled={!canEdit} value={l.startTime ?? ''} onChange={(e) => updateLine(i, { startTime: e.target.value })} /></Cell>
                <Cell><input className="input" type="time" disabled={!canEdit} value={l.endTime ?? ''} onChange={(e) => updateLine(i, { endTime: e.target.value })} /></Cell>
                <Cell><input className="input bg-slate-50" disabled value={l.totalHours ?? ''} title="Auto-calculated" /></Cell>
                <Cell><input className="input min-w-[200px]" disabled={!canEdit} value={l.description ?? ''} onChange={(e) => updateLine(i, { description: e.target.value })} /></Cell>
                {showBreakdown ? (
                  <>
                    <Cell>
                      <select
                        className="input" disabled={!canEdit} value={l.breakdownEquipment ?? ''}
                        onChange={(e) => {
                          const name = e.target.value;
                          const picked = equipmentOptions.find((o) => o.name === name);
                          updateLine(i, { breakdownEquipment: name, breakdownEquipmentId: picked?.id ?? null });
                        }}
                      >
                        <option value="">-</option>
                        {withCurrentValue(equipmentOptions.map((o) => o.name), l.breakdownEquipment).map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </Cell>
                    <Cell><input className="input min-w-[140px]" disabled={!canEdit} value={l.breakdownReason ?? ''} onChange={(e) => updateLine(i, { breakdownReason: e.target.value })} /></Cell>
                  </>
                ) : <NotApplicable colSpan={2} />}
                {showDrilling ? (
                  <>
                    <Cell>
                      <select className="input" disabled={!canEdit} value={l.drillingSection ?? ''} onChange={(e) => updateLine(i, { drillingSection: e.target.value })}>
                        <option value="">-</option>
                        {withCurrentValue(DPR_BIT_SIZES, l.drillingSection).map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </Cell>
                    <Cell><input className="input" type="number" disabled={!canEdit} value={l.drillingFrom ?? ''} onChange={(e) => updateLine(i, { drillingFrom: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input" type="number" disabled={!canEdit} value={l.drillingTo ?? ''} onChange={(e) => updateLine(i, { drillingTo: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input bg-slate-50" disabled value={l.drillingTotal ?? ''} title="Auto-calculated" /></Cell>
                  </>
                ) : <NotApplicable colSpan={4} />}
                {showCasing ? (
                  <>
                    <Cell>
                      <select className="input" disabled={!canEdit} value={l.casingSection ?? ''} onChange={(e) => updateLine(i, { casingSection: e.target.value })}>
                        <option value="">-</option>
                        {withCurrentValue(DPR_CASING_SIZES, l.casingSection).map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </Cell>
                    <Cell><input className="input" type="number" disabled={!canEdit} value={l.casingFrom ?? ''} onChange={(e) => updateLine(i, { casingFrom: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input" type="number" disabled={!canEdit} value={l.casingTo ?? ''} onChange={(e) => updateLine(i, { casingTo: e.target.value === '' ? null : Number(e.target.value) })} /></Cell>
                    <Cell><input className="input bg-slate-50" disabled value={l.casingTotal ?? ''} title="Auto-calculated" /></Cell>
                  </>
                ) : <NotApplicable colSpan={4} />}
                {canEdit && (
                  <td className="whitespace-nowrap">
                    <button className="btn-ghost btn-sm text-red-700" type="button" onClick={() => removeLine(i)} disabled={lines.length <= 1}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                )}
              </tr>
              {showOther && (
                <tr>
                  <td colSpan={canEdit ? 18 : 17} className="bg-slate-50">
                    <div className="max-w-xl">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-slate-600 font-medium">Other Activity</label>
                        <span className={otherWords >= OTHER_ACTIVITY_MAX_WORDS ? 'text-red-600 font-medium' : 'text-slate-400'}>
                          {otherWords}/{OTHER_ACTIVITY_MAX_WORDS} words
                        </span>
                      </div>
                      <textarea
                        className="input w-full" rows={2} disabled={!canEdit}
                        value={l.otherActivityDescription ?? ''}
                        placeholder="Describe the activity..."
                        onChange={(e) => updateLine(i, { otherActivityDescription: capWords(e.target.value, OTHER_ACTIVITY_MAX_WORDS) })}
                      />
                      {otherWords >= OTHER_ACTIVITY_MAX_WORDS && (
                        <div className="text-red-600 mt-0.5">Maximum {OTHER_ACTIVITY_MAX_WORDS} words reached.</div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ children }: { children: ReactNode }) {
  return <td className="min-w-[70px]">{children}</td>;
}

/** A field group not relevant to this row's selected Operation — greyed out rather than an editable input. */
function NotApplicable({ colSpan }: { colSpan: number }) {
  return <td colSpan={colSpan} className="text-center text-slate-300">&mdash;</td>;
}
