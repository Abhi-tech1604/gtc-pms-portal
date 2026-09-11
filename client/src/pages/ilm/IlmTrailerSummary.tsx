import { useEffect, useMemo, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { Link } from 'react-router-dom';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Boxes, CheckCircle2, ChevronDown, ChevronRight, Clock, Search, Truck, UploadCloud,
} from 'lucide-react';
import { api, download } from '../../lib/api';
import { date } from '../../lib/format';
import type { IlmRig, TrailerSummaryResponse, TrailerSummaryRow } from '../../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../../components/ui';

const fmtN = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('en-IN', { maximumFractionDigits: 1 }));

function Kpi({ icon: Icon, tone, label, value }: { icon: typeof Truck; tone: string; label: string; value: string }) {
  return (
    <div className="card p-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-500 mb-1">{label}</div>
        <div className="text-2xl font-semibold text-slate-900 leading-tight">{value}</div>
      </div>
      <span className={`shrink-0 h-9 w-9 rounded-lg grid place-items-center ${tone}`}><Icon size={16} /></span>
    </div>
  );
}

interface Filters { rigType: string; rigId: string; dateFrom: string; dateTo: string }

type SortKey = 'trailerNo' | 'tripCount' | 'trailerType' | 'loadingDate' | 'totalPackages';
const COLUMNS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'trailerNo', label: 'Trailer No.' },
  { key: 'tripCount', label: 'No. of Trips', align: 'right' },
  { key: 'trailerType', label: 'Trailer Type' },
  { key: 'loadingDate', label: 'Loading Date' },
  { key: 'totalPackages', label: 'Total Packages', align: 'right' },
];

/**
 * ILM → Dashboard → Trailer Summary: merges the flat per-load detail view
 * and the per-trailer trip-sequence view into one searchable/sortable table
 * — real ilm_trailer_loads rows only (services/ilmTrailerSummary.ts).
 */
export default function IlmTrailerSummary() {
  const [rigs, setRigs] = useState<IlmRig[]>([]);
  const [rigTypes, setRigTypes] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>({ rigType: '', rigId: '', dateFrom: '', dateTo: '' });
  const [data, setData] = useState<TrailerSummaryResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('trailerNo');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(trailerNo: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(trailerNo)) next.delete(trailerNo); else next.add(trailerNo);
      return next;
    });
  }

  useEffect(() => {
    api.get<{ rigs: IlmRig[] }>('/ilm/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
    api.get<{ rigTypes: string[] }>('/ilm/rig-types').then((d) => setRigTypes(d.rigTypes)).catch(() => {});
  }, []);

  async function generate() {
    setError('');
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (filters.rigType) q.set('rigType', filters.rigType);
      if (filters.rigId) q.set('rigId', filters.rigId);
      if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) q.set('dateTo', filters.dateTo);
      setData(await api.get<TrailerSummaryResponse>(`/ilm/trailer-summary?${q}`));
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }

  useEffect(() => { void generate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function exportExcel() {
    const q = new URLSearchParams();
    if (filters.rigType) q.set('rigType', filters.rigType);
    if (filters.rigId) q.set('rigId', filters.rigId);
    if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) q.set('dateTo', filters.dateTo);
    void download(`/ilm/trailer-summary/export.xlsx?${q}`, 'ilm-trailer-summary.xlsx');
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  const filteredRows = useMemo(() => {
    const rows = data?.rows ?? [];
    const needle = search.trim().toLowerCase();
    const base = needle
      ? rows.filter((r) => [r.trailerNo, r.driverName, r.loadDescription, r.loadingPoint].some((v) => (v ?? '').toLowerCase().includes(needle)))
      : rows;
    return [...base].sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      const cmp = typeof av === 'string' ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, search, sortKey, sortDir]);

  return (
    <div>
      <PageHeader
        title="Trailer Summary"
        subtitle="Per-trailer trip and load detail for the selected rig and date range — real ilm_trailer_loads records only."
        actions={
          <>
            <button className="btn-primary" onClick={exportExcel} disabled={!data || data.rows.length === 0}>
              Download
            </button>
            <Link to="/ilm/import" className="btn-ghost"><UploadCloud size={14} /> Import</Link>
          </>
        }
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-5 grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
        <select className="input" value={filters.rigType} onChange={(e) => setFilters({ ...filters, rigType: e.target.value })}>
          <option value="">All Rig Types</option>
          {rigTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
          <option value="">All Rigs</option>
          {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
        </select>
        <select className="input" defaultValue="Individual" disabled>
          <option>Individual</option>
        </select>
        <Field label=""><input className="input" type="date" value={filters.dateFrom} placeholder="From" onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} /></Field>
        <Field label=""><input className="input" type="date" value={filters.dateTo} placeholder="To" onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} /></Field>
        <button className="btn-primary justify-center" onClick={() => void generate()} disabled={loading}>Generate</button>
      </div>

      {!data ? (
        !error && <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-5">
            <Kpi icon={Truck} tone="bg-sky-100 text-sky-600" label="Total Trailers" value={fmtN(data.kpis.totalTrailers)} />
            <Kpi icon={Truck} tone="bg-emerald-100 text-emerald-600" label="Total Trips" value={fmtN(data.kpis.totalTrips)} />
            <Kpi icon={CheckCircle2} tone="bg-violet-100 text-violet-600" label="Completion Rate" value={`${fmtN(data.kpis.completionRatePct)}%`} />
            <Kpi icon={ArrowUpDown} tone="bg-amber-100 text-amber-600" label="Avg Trips/Trailer" value={fmtN(data.kpis.avgTripsPerTrailer)} />
            <Kpi icon={Clock} tone="bg-rose-100 text-rose-600" label="Total Days" value={fmtN(data.kpis.totalDays)} />
            <Kpi icon={Boxes} tone="bg-slate-200 text-slate-600" label="Total Packages" value={fmtN(data.kpis.totalPackages)} />
          </div>

          <div className="card mb-5">
            <div className="card-header flex items-center justify-between gap-3">
              <h3 className="card-title">Trailer Summary</h3>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-2.5 text-slate-400" />
                <input
                  className="input pl-7 text-sm py-1.5 w-56" placeholder="Search trailer, driver, load..."
                  value={search} onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th />
                    <th>Sr. No.</th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} className={c.align === 'right' ? 'text-right' : undefined}>
                        <button className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => toggleSort(c.key)}>
                          {c.label}
                          {sortKey === c.key
                            ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
                            : <ArrowUpDown size={12} className="text-slate-300" />}
                        </button>
                      </th>
                    ))}
                    <th>Loading Point</th><th>Loading Time</th><th>Load Description</th>
                    <th>Driver Name</th><th>Driver Contact</th><th>Load Details</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r: TrailerSummaryRow, i) => {
                    const isOpen = expanded.has(r.trailerNo);
                    return (
                      <>
                        <tr key={r.trailerNo} className="cursor-pointer" onClick={() => toggleExpanded(r.trailerNo)}>
                          <td className="text-slate-400">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                          <td>{i + 1}</td>
                          <td className="font-medium whitespace-nowrap">{r.trailerNo}</td>
                          <td className="num">{r.tripCount}</td>
                          <td>{r.trailerType ?? '-'}</td>
                          <td className="whitespace-nowrap">{r.loadingDate ? date(r.loadingDate) : '-'}</td>
                          <td className="num">{fmtN(r.totalPackages)}</td>
                          <td>{r.loadingPoint ?? '-'}</td>
                          <td>{r.loadingTime ?? '-'}</td>
                          <td>{r.loadDescription ?? '-'}</td>
                          <td>{r.driverName ?? '-'}</td>
                          <td>{r.driverContact ?? '-'}</td>
                          <td>{r.loadDetails ?? '-'}</td>
                        </tr>
                        {isOpen && (
                          <tr key={`${r.trailerNo}-trips`} className="bg-slate-50">
                            <td colSpan={13} className="p-3">
                              <div className="text-[11px] font-semibold text-slate-500 uppercase mb-1.5">
                                All trips for {r.trailerNo} ({r.trips.length})
                              </div>
                              <table className="table text-xs bg-white">
                                <thead>
                                  <tr>
                                    <th>Trip No.</th><th>MT/Gate Pass</th><th>Loading Date</th><th>Loading Time</th>
                                    <th>Unloading Date</th><th>Unloading Time</th><th className="text-right">Packages</th>
                                    <th>Load Description</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.trips.map((t) => (
                                    <tr key={t.tripNo}>
                                      <td className="num">{t.tripNo}</td>
                                      <td>{t.mtGatePassNo ?? '-'}</td>
                                      <td className="whitespace-nowrap">{t.loadingDate ? date(t.loadingDate) : '-'}</td>
                                      <td>{t.loadingTime ?? '-'}</td>
                                      <td className="whitespace-nowrap">{t.unloadingDate ? date(t.unloadingDate) : '-'}</td>
                                      <td>{t.unloadingTime ?? '-'}</td>
                                      <td className="num">{fmtN(t.totalPackages)}</td>
                                      <td>{t.loadDescription ?? '-'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                  {filteredRows.length === 0 && <tr><td colSpan={13}><Empty message="No trailer records match these filters." /></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
