import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { rigLabel } from '../lib/rig';
import { ClipboardList, Download, Fuel, Gauge, Package, Truck } from 'lucide-react';
import { api, download } from '../lib/api';
import { count, date, todayIso } from '../lib/format';
import type { Rig } from '../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner, Tabs } from '../components/ui';

/**
 * The other six reports live on their own module pages (each already has its
 * own real Export button/logic — this only links out, never a second copy of
 * that logic). Listed here so Admin has one place that points at every report
 * in the app, not just PMS's four.
 */
const OTHER_REPORTS: { to: string; icon: typeof Gauge; label: string; hint: string }[] = [
  { to: '/dpr', icon: Gauge, label: 'DPR Dashboard Summary', hint: 'KPIs + rig comparison — Excel or PDF' },
  { to: '/dpr/operational-data', icon: ClipboardList, label: 'Operational DPR', hint: 'Every activity line — Excel' },
  { to: '/dpr/hsd-report', icon: Fuel, label: 'HSD Report', hint: 'Rig diesel account — Excel' },
  { to: '/ilm', icon: Package, label: 'ILM Summary', hint: 'Fleet-wide ILM totals — Excel' },
  { to: '/ilm/crane-summary', icon: Package, label: 'ILM Crane Summary', hint: 'Excel' },
  { to: '/ilm/trailer-summary', icon: Truck, label: 'ILM Trailer Summary', hint: 'Excel' },
];

type ReportKey = 'equipment-status' | 'service-due' | 'running-hours';

interface ReportTable {
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  meta?: Record<string, unknown>;
}

const CATEGORIES = [
  'Rig Carrier Engine', 'Mud Pump Engine', 'Mud Pump', 'DG Set', 'Air Compressor',
  'Fire Pump', 'Transmission', 'Generator', 'BCU', 'Crane', 'Trailer', 'Others',
];

export default function Reports() {
  const [key, setKey] = useState<ReportKey>('equipment-status');
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [report, setReport] = useState<ReportTable | null>(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    rigId: '', category: '', from: addDays(todayIso(), -29), to: todayIso(),
  });

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs)).catch(() => undefined);
  }, []);

  const query = useCallback(() => {
    const q = new URLSearchParams();
    if (filters.rigId) q.set('rigId', filters.rigId);
    if (key === 'equipment-status' && filters.category) q.set('category', filters.category);
    if (key === 'running-hours') {
      q.set('from', filters.from);
      q.set('to', filters.to);
    }
    return q.toString();
  }, [filters, key]);

  useEffect(() => {
    setReport(null);
    api.get<{ report: ReportTable }>(`/reports/${key}?${query()}`)
      .then((d) => setReport(d.report))
      .catch((e) => setError((e as Error).message));
  }, [key, query]);

  const usesDates = key === 'running-hours';

  return (
    <div>
      <PageHeader
        title="System Reports"
        subtitle="Every figure is read from stored records. Each report exports to Excel."
        actions={
          <button className="btn-primary" onClick={() => void download(`/reports/${key}/export?${query()}`, `${key}.xlsx`)}>
            <Download size={14} /> Export to Excel
          </button>
        }
      />

      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="mb-5">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Other module reports</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {OTHER_REPORTS.map((r) => (
            <Link key={r.to} to={r.to} className="card p-3 flex items-center gap-3 hover:border-rig-300 hover:shadow-sm transition-colors">
              <span className="shrink-0 h-9 w-9 rounded-lg bg-slate-100 text-slate-600 grid place-items-center">
                <r.icon size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-800 truncate">{r.label}</span>
                <span className="block text-[11px] text-slate-500 truncate">{r.hint}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">PMS reports</div>
      <Tabs
        active={key}
        onChange={setKey}
        tabs={[
          { key: 'equipment-status', label: 'Equipment status' },
          { key: 'service-due', label: 'Service due' },
          { key: 'running-hours', label: 'Running hours' },
        ]}
      />

      <div className="card p-3 mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <Field label="Rig">
          <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
            <option value="">All rigs</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
        {key === 'equipment-status' && (
          <Field label="Category">
            <select className="input" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        )}
        {usesDates && (
          <>
            <Field label="From"><input className="input" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Field>
            <Field label="To"><input className="input" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Field>
          </>
        )}
      </div>

      {!report ? <Spinner /> : (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{report.title}</h2>
            <div className="text-[11px] text-slate-500">
              {count(report.rows.length)} row(s)
              {report.meta?.legend ? ` · ${String(report.meta.legend)}` : ''}
            </div>
          </div>
          <div className="overflow-auto max-h-[65vh]">
            <table className="table">
              <thead>
                <tr>{report.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
              </thead>
              <tbody>
                {report.rows.map((row, i) => (
                  <tr key={i}>
                    {report.columns.map((c) => (
                      <td key={c.key} className={typeof row[c.key] === 'number' ? 'num' : ''}>
                        {renderCell(c.key, row[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
                {report.rows.length === 0 && (
                  <tr><td colSpan={report.columns.length}><Empty message="Nothing matches this selection." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function renderCell(key: string, value: unknown) {
  if (value === null || value === undefined || value === '') return '-';
  if (value === 'Y') return <span className="text-emerald-600 font-semibold">Y</span>;
  if (value === 'N') return <span className="text-red-600 font-semibold">N</span>;
  if (value === 'H') return <span className="text-sky-600 font-semibold">H</span>;
  if (typeof value === 'number') return Math.round(value).toLocaleString('en-IN');
  if (/date$/i.test(key) && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return date(String(value));
  return String(value);
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
