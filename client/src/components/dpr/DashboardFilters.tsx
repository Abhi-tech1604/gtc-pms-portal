import { Search, X } from 'lucide-react';
import { rigLabel } from '../../lib/rig';
import { DPR_ACTIVITY_CODES, DPR_WORK_TYPES } from '../../lib/dprLists';
import type { DprEquipmentOption, DprRig, DprRigStatus } from '../../lib/types';
import { Field } from '../ui';

export interface DashboardFilterState {
  search: string;
  rigId: string;
  status: '' | DprRigStatus;
  dateFrom: string;
  dateTo: string;
  workType: string;
  operationCode: string;
  equipment: string;
}

export const EMPTY_DASHBOARD_FILTERS: DashboardFilterState = {
  search: '', rigId: '', status: '', dateFrom: '', dateTo: '', workType: '', operationCode: '', equipment: '',
};

const STATUS_OPTIONS: DprRigStatus[] = ['Pending', 'Completed'];

export default function DashboardFilters({
  filters, onChange, rigs, equipmentOptions,
}: {
  filters: DashboardFilterState;
  onChange: (next: DashboardFilterState) => void;
  rigs: DprRig[];
  equipmentOptions: DprEquipmentOption[];
}) {
  const hasFilters = Object.values(filters).some(Boolean);
  const set = <K extends keyof DashboardFilterState>(key: K, value: DashboardFilterState[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="card p-3 mb-5 grid grid-cols-1 md:grid-cols-4 lg:grid-cols-8 gap-3 items-end">
      <div className="relative md:col-span-2">
        <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
        <input
          className="input pl-8" placeholder="Search well, operation, rig..."
          value={filters.search} onChange={(e) => set('search', e.target.value)}
        />
      </div>
      <select className="input" value={filters.rigId} onChange={(e) => set('rigId', e.target.value)}>
        <option value="">All Rigs</option>
        {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
      </select>
      <select className="input" value={filters.workType} onChange={(e) => set('workType', e.target.value)}>
        <option value="">All Work Types</option>
        {DPR_WORK_TYPES.map((w) => <option key={w} value={w}>{w}</option>)}
      </select>
      <select className="input" value={filters.operationCode} onChange={(e) => set('operationCode', e.target.value)}>
        <option value="">All Activities</option>
        {DPR_ACTIVITY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select
        className="input" value={filters.equipment} onChange={(e) => set('equipment', e.target.value)}
        disabled={!filters.rigId}
        title={!filters.rigId ? 'Select a rig first' : undefined}
      >
        <option value="">{filters.rigId ? 'All Equipment' : 'Select a rig first'}</option>
        {equipmentOptions.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
      </select>
      <select className="input" value={filters.status} onChange={(e) => set('status', e.target.value as '' | DprRigStatus)}>
        <option value="">All Status</option>
        {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <div className="grid grid-cols-2 gap-2 md:col-span-2 lg:col-span-1">
        <Field label=""><input className="input" type="date" value={filters.dateFrom} placeholder="From" onChange={(e) => set('dateFrom', e.target.value)} /></Field>
        <Field label=""><input className="input" type="date" value={filters.dateTo} placeholder="To" onChange={(e) => set('dateTo', e.target.value)} /></Field>
      </div>
      <button className="btn-ghost justify-center" disabled={!hasFilters} onClick={() => onChange(EMPTY_DASHBOARD_FILTERS)}>
        <X size={14} /> Clear
      </button>
    </div>
  );
}
