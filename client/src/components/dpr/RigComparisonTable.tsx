import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { count, date, hours } from '../../lib/format';
import type { DprDashboardRigComparisonRow } from '../../lib/types';
import { Empty } from '../ui';

type SortKey = 'rigNumber' | 'totalProgress' | 'totalHours' | 'totalDiesel' | 'efficiencyPct' | 'utilizationPct' | 'downtimeHours';

const COLUMNS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'rigNumber', label: 'Rig' },
  { key: 'totalProgress', label: 'Progress (m)', align: 'right' },
  { key: 'totalHours', label: 'Hours', align: 'right' },
  { key: 'totalDiesel', label: 'Diesel (L)', align: 'right' },
  { key: 'efficiencyPct', label: 'Efficiency %', align: 'right' },
  { key: 'utilizationPct', label: 'Utilization %', align: 'right' },
  { key: 'downtimeHours', label: 'Downtime (hrs)', align: 'right' },
];

/**
 * The dashboard's sortable/searchable rig comparison table — the aggregated,
 * one-row-per-rig view (distinct from DprProgressReport.tsx's flat,
 * one-row-per-report list, which stays untouched). Sorting/searching happen
 * entirely client-side since the row count is one per active rig, not per
 * report.
 */
export default function RigComparisonTable({
  rows, onSelectRig,
}: {
  rows: DprDashboardRigComparisonRow[];
  onSelectRig: (rigId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('rigNumber');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const base = needle
      ? rows.filter((r) => [r.rigNumber, r.rigName].some((v) => v.toLowerCase().includes(needle)))
      : rows;
    const sorted = [...base].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [rows, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  return (
    <div className="card mb-5">
      <div className="card-header flex items-center justify-between gap-3">
        <h3 className="card-title">Rig Comparison</h3>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            className="input pl-7 text-sm py-1.5 w-56" placeholder="Search rig..."
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th key={c.key} className={c.align === 'right' ? 'text-right' : undefined}>
                  <button
                    className="inline-flex items-center gap-1 hover:text-slate-900"
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.label}
                    {sortKey === c.key
                      ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
                      : <ArrowUpDown size={12} className="text-slate-300" />}
                  </button>
                </th>
              ))}
              <th>Last DPR</th>
              <th className="text-right">Reports</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.rigId} className="cursor-pointer hover:bg-slate-50" onClick={() => onSelectRig(r.rigId)}>
                <td className="font-medium text-rig-700">{r.rigNumber}</td>
                <td className="num">{hours(r.totalProgress)}</td>
                <td className="num">{hours(r.totalHours)}</td>
                <td className="num">{hours(r.totalDiesel)}</td>
                <td className="num">{hours(r.efficiencyPct)}</td>
                <td className="num">{hours(r.utilizationPct)}</td>
                <td className="num">{hours(r.downtimeHours)}</td>
                <td className="whitespace-nowrap">{r.lastReportDate ? date(r.lastReportDate) : <span className="text-slate-400">No DPR yet</span>}</td>
                <td className="num">{count(r.reportCount)}</td>
                <td><span className={r.dprStatus === 'Completed' ? 'pill-normal' : 'pill-overdue'}>{r.dprStatus}</span></td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={10}><Empty message="No rigs match these filters." /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
