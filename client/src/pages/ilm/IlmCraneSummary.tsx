import { useEffect, useMemo, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { Link } from 'react-router-dom';
import { ArrowUpDown, AlertTriangle, Clock, Fuel, Gauge, Route, Truck, UploadCloud } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, download } from '../../lib/api';
import { date } from '../../lib/format';
import type { CraneDashboardResponse, CraneDashboardRow, CraneFilterOptions, IlmRig } from '../../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../../components/ui';

const fmtN = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

const COLOR_WORKING = '#0891b2';
const COLOR_FUEL = '#d97706';
const COLOR_BREAKDOWN = '#e11d48';
const COLOR_CRANES = '#7c3aed';

function Kpi({ icon: Icon, tone, label, value, hint }: { icon: typeof Gauge; tone: string; label: string; value: string; hint: string }) {
  return (
    <div className="card p-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-500 mb-1">{label}</div>
        <div className="text-2xl font-semibold text-slate-900 leading-tight">{value}</div>
        <div className="text-xs text-slate-400">{hint}</div>
      </div>
      <span className={`shrink-0 h-9 w-9 rounded-lg grid place-items-center ${tone}`}><Icon size={16} /></span>
    </div>
  );
}

interface Filters { rigId: string; dateFrom: string; dateTo: string; craneNo: string; transporterName: string; status: string }
const blankFilters: Filters = { rigId: '', dateFrom: '', dateTo: '', craneNo: '', transporterName: '', status: '' };

type SortKey = 'craneNo' | 'rigNumber' | 'capacityTon' | 'registrationNo' | 'transporterName' | 'workingHours' | 'fuelLtrs' | 'breakdownHours' | 'breakdownPct' | 'trips' | 'status';

/**
 * ILM → Dashboard → Crane Summary: a fully-automated crane management
 * dashboard. Every KPI, chart and table row is a live aggregate over real
 * ilm_cranes/ilm_crane_rounds rows for the current filters
 * (services/ilmCraneDashboard.ts) — nothing here is dummy, hardcoded, or a
 * second copy of ILM's own data; editing a Crane Round/Record in ILM shows
 * up here on the next fetch.
 */
export default function IlmCraneSummary() {
  const [rigs, setRigs] = useState<IlmRig[]>([]);
  const [options, setOptions] = useState<CraneFilterOptions>({ cranes: [], transporters: [] });
  const [filters, setFilters] = useState<Filters>(blankFilters);
  const [data, setData] = useState<CraneDashboardResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'rigNumber', dir: 'asc' });
  const [trendView, setTrendView] = useState<'day' | 'month'>('day');

  useEffect(() => {
    api.get<{ rigs: IlmRig[] }>('/ilm/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    const q = new URLSearchParams();
    if (filters.rigId) q.set('rigId', filters.rigId);
    api.get<CraneFilterOptions>(`/ilm/crane-summary/filter-options?${q}`).then(setOptions).catch(() => {});
  }, [filters.rigId]);

  async function load() {
    setError('');
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (filters.rigId) q.set('rigId', filters.rigId);
      if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) q.set('dateTo', filters.dateTo);
      if (filters.craneNo) q.set('craneNo', filters.craneNo);
      if (filters.transporterName) q.set('transporterName', filters.transporterName);
      if (filters.status) q.set('status', filters.status);
      setData(await api.get<CraneDashboardResponse>(`/ilm/crane-summary/dashboard?${q}`));
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }

  // All KPIs/charts/table update automatically whenever a filter changes — no separate "Generate" click.
  useEffect(() => { void load(); }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  function exportExcel() {
    const q = new URLSearchParams();
    if (filters.rigId) q.set('rigId', filters.rigId);
    if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) q.set('dateTo', filters.dateTo);
    void download(`/ilm/crane-summary/export.xlsx?${q}`, 'ilm-crane-summary.xlsx');
  }

  const trend = useMemo(() => {
    if (!data) return [];
    if (trendView === 'day') return data.trend;
    const byMonth = new Map<string, { workingHours: number; fuelLtrs: number; breakdownHours: number }>();
    for (const p of data.trend) {
      const m = p.date.slice(0, 7);
      const acc = byMonth.get(m) ?? { workingHours: 0, fuelLtrs: 0, breakdownHours: 0 };
      acc.workingHours += p.workingHours; acc.fuelLtrs += p.fuelLtrs; acc.breakdownHours += p.breakdownHours;
      byMonth.set(m, acc);
    }
    return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([m, v]) => ({ date: m, workingHours: Math.round(v.workingHours * 100) / 100, fuelLtrs: Math.round(v.fuelLtrs * 100) / 100, breakdownHours: Math.round(v.breakdownHours * 100) / 100 }));
  }, [data, trendView]);

  const visibleRows = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    let rows = data.rows;
    if (needle) {
      rows = rows.filter((r) => [r.craneNo, r.rigNumber, r.registrationNo, r.transporterName, r.oldLocation, r.newLocation]
        .some((v) => (v ?? '').toLowerCase().includes(needle)));
    }
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sort.key]; const bv = b[sort.key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [data, search, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }
  function Th({ label, sortKey, className }: { label: string; sortKey: SortKey; className?: string }) {
    return (
      <th className={className}>
        <button type="button" className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => toggleSort(sortKey)}>
          {label} <ArrowUpDown size={11} className={sort.key === sortKey ? 'text-rig-700' : 'text-slate-300'} />
        </button>
      </th>
    );
  }

  return (
    <div>
      <PageHeader
        title="Crane Summary"
        subtitle="A fully-automated crane management dashboard — every figure is a live aggregate over real ILM Crane Round/Record data."
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

      <div className="card p-3 mb-5 grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
        <Field label="Rig">
          <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
            <option value="">All Rigs</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
        <Field label="Date From">
          <input className="input" type="date" value={filters.dateFrom} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} />
        </Field>
        <Field label="Date To">
          <input className="input" type="date" value={filters.dateTo} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} />
        </Field>
        <Field label="Crane">
          <select className="input" value={filters.craneNo} onChange={(e) => setFilters({ ...filters, craneNo: e.target.value })}>
            <option value="">All Cranes</option>
            {options.cranes.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Transporter">
          <select className="input" value={filters.transporterName} onChange={(e) => setFilters({ ...filters, transporterName: e.target.value })}>
            <option value="">All Transporters</option>
            {options.transporters.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className="input" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">All Statuses</option>
            <option value="Active">Active</option>
            <option value="Completed">Completed</option>
          </select>
        </Field>
      </div>

      {loading && !data ? (
        <Spinner />
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-5">
            <Kpi icon={Truck} tone="bg-violet-100 text-violet-600" label="Total Cranes" value={fmtN(data.kpis.totalCranes)} hint="in selected range" />
            <Kpi icon={Gauge} tone="bg-emerald-100 text-emerald-600" label="Active Cranes" value={fmtN(data.kpis.activeCranes)} hint="on an Active ILM" />
            <Kpi icon={Clock} tone="bg-sky-100 text-sky-600" label="Total Working Hours" value={fmtN(data.kpis.totalWorkingHours)} hint="logged hours" />
            <Kpi icon={Fuel} tone="bg-amber-100 text-amber-600" label="Total Fuel / HSD Consumed" value={`${fmtN(data.kpis.totalFuelConsumed)}L`} hint="issued HSD" />
            <Kpi icon={Route} tone="bg-indigo-100 text-indigo-600" label="Total Trips" value={fmtN(data.kpis.totalTrips)} hint="crane round deployments" />
            <Kpi icon={AlertTriangle} tone="bg-rose-100 text-rose-600" label="Total Breakdown Hours" value={fmtN(data.kpis.totalBreakdownHours)} hint="downtime logged" />
          </div>

          {data.rows.length === 0 ? (
            <div className="card"><Empty message="No crane records match these filters." /></div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">Rig-wise Crane Comparison</h3>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={data.rigWise} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="rigNumber" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="totalCranes" name="Total Cranes" fill={COLOR_CRANES} radius={[3, 3, 0, 0]} />
                      <Bar dataKey="workingHours" name="Working Hours" fill={COLOR_WORKING} radius={[3, 3, 0, 0]} />
                      <Bar dataKey="breakdownHours" name="Breakdown Hours" fill={COLOR_BREAKDOWN} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">Transporter-wise Comparison</h3>
                  {data.transporterWise.length === 0 ? <Empty message="No transporter data recorded yet." /> : (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={data.transporterWise} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="transporterName" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="craneCount" name="Crane Count" fill={COLOR_CRANES} radius={[3, 3, 0, 0]} />
                        <Bar dataKey="workingHours" name="Working Hours" fill={COLOR_WORKING} radius={[3, 3, 0, 0]} />
                        <Bar dataKey="breakdownHours" name="Breakdown Hours" fill={COLOR_BREAKDOWN} radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              <div className="card p-4 mb-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-700">Crane-wise Performance — Working Hours vs Breakdown</h3>
                  <span className="text-xs text-slate-400">sorted by working hours, highest first</span>
                </div>
                <ResponsiveContainer width="100%" height={Math.max(260, data.craneWise.length * 34)}>
                  <BarChart data={data.craneWise} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="craneNo" tick={{ fontSize: 11 }} width={110} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="workingHours" name="Working Hours" fill={COLOR_WORKING} radius={[0, 3, 3, 0]} />
                    <Bar dataKey="breakdownHours" name="Breakdown Hours" fill={COLOR_BREAKDOWN} radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="card p-4 mb-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-slate-700">Trend — Working Hours, Fuel &amp; Breakdown</h3>
                  <div className="flex gap-1">
                    <button className={`btn-sm ${trendView === 'day' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTrendView('day')}>Daily</button>
                    <button className={`btn-sm ${trendView === 'month' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTrendView('month')}>Monthly</button>
                  </div>
                </div>
                {trend.length === 0 ? <Empty message="No dated crane records yet." /> : (
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(v) => (trendView === 'day' ? date(v) : v)} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip labelFormatter={(v) => (trendView === 'day' ? date(String(v)) : String(v))} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line type="monotone" dataKey="workingHours" name="Working Hours" stroke={COLOR_WORKING} strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="fuelLtrs" name="Fuel (L)" stroke={COLOR_FUEL} strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="breakdownHours" name="Breakdown Hours" stroke={COLOR_BREAKDOWN} strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">Detailed Crane Table</h3>
                  <input
                    className="input max-w-xs" placeholder="Search crane, rig, registration, transporter, location..."
                    value={search} onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="overflow-x-auto">
                  <table className="table text-xs">
                    <thead>
                      <tr>
                        <Th label="Crane" sortKey="craneNo" />
                        <Th label="Rig" sortKey="rigNumber" />
                        <Th label="Capacity" sortKey="capacityTon" className="text-right" />
                        <Th label="Registration No." sortKey="registrationNo" />
                        <Th label="Transporter" sortKey="transporterName" />
                        <th>Old Location</th>
                        <th>New Location</th>
                        <Th label="Working Hours" sortKey="workingHours" className="text-right" />
                        <Th label="Fuel/HSD" sortKey="fuelLtrs" className="text-right" />
                        <Th label="Breakdown Hours" sortKey="breakdownHours" className="text-right" />
                        <Th label="Breakdown %" sortKey="breakdownPct" className="text-right" />
                        <Th label="Trips" sortKey="trips" className="text-right" />
                        <Th label="Status" sortKey="status" />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.length === 0 ? (
                        <tr><td colSpan={13} className="text-center text-slate-400 py-6">No crane records match this search.</td></tr>
                      ) : visibleRows.map((r: CraneDashboardRow) => (
                        <tr key={r.key}>
                          <td className="font-medium whitespace-nowrap">{r.craneNo}</td>
                          <td>{r.rigNumber}</td>
                          <td className="num">{r.capacityTon !== null ? `${r.capacityTon} T` : '-'}</td>
                          <td>{r.registrationNo ?? '-'}</td>
                          <td>{r.transporterName ?? '-'}</td>
                          <td>{r.oldLocation ?? '-'}</td>
                          <td>{r.newLocation ?? '-'}</td>
                          <td className="num">{fmtN(r.workingHours)}</td>
                          <td className="num">{fmtN(r.fuelLtrs)}</td>
                          <td className={`num ${r.breakdownHours > 0 ? 'text-rose-700' : ''}`}>{fmtN(r.breakdownHours)}</td>
                          <td className={`num ${r.breakdownPct >= 20 ? 'text-rose-700 font-semibold' : ''}`}>{fmtN(r.breakdownPct)}%</td>
                          <td className="num">{r.trips}</td>
                          <td><span className={`pill-engine ${r.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'}`}>{r.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
