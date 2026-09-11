import { useEffect, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { Link } from 'react-router-dom';
import { AlertTriangle, BarChart3, Download, Gauge, Layers, Settings, UploadCloud, Wrench } from 'lucide-react';
import { api, download } from '../../lib/api';
import { date } from '../../lib/format';
import type { DprRig, OperationalDataResponse, OperationalLineRow, RigHsdComparisonRow } from '../../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../../components/ui';
import HsdRigComparisonChart from '../../components/dpr/charts/HsdRigComparisonChart';

const fmtH = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

const TONES: Record<string, string> = {
  sky: 'bg-sky-100 text-sky-600',
  emerald: 'bg-emerald-100 text-emerald-600',
  rose: 'bg-rose-100 text-rose-600',
  violet: 'bg-violet-100 text-violet-600',
  amber: 'bg-amber-100 text-amber-600',
  cyan: 'bg-cyan-100 text-cyan-600',
};

function Kpi({ icon: Icon, tone, label, value }: { icon: typeof Wrench; tone: keyof typeof TONES; label: string; value: string }) {
  return (
    <div className="card p-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-500 mb-1">{label}</div>
        <div className="text-2xl font-semibold text-slate-900 leading-tight">{value}</div>
        <div className="text-xs text-slate-400">hours</div>
      </div>
      <span className={`shrink-0 h-9 w-9 rounded-lg grid place-items-center ${TONES[tone]}`}><Icon size={16} /></span>
    </div>
  );
}

interface Filters { rigType: string; rigId: string; dateFrom: string; dateTo: string }

const WORK_TYPE_PILL: Record<string, string> = {
  R0: 'bg-amber-100 text-amber-700', R1: 'bg-sky-100 text-sky-700', R2: 'bg-emerald-100 text-emerald-700',
  'R2/2': 'bg-cyan-100 text-cyan-700', R3: 'bg-rose-100 text-rose-700', ILM: 'bg-violet-100 text-violet-700',
};

/**
 * Operational DPR: every real activity line, flattened with its date and
 * rig — one row per dpr_line_items entry, not aggregated by rig (that's
 * the Dashboard's Rig Comparison table). Rig Type is bridged from PMS's
 * rigs.rigType by rig-number match, same bridge Equipment Master uses.
 */
export default function DprOperationalData() {
  const [rigs, setRigs] = useState<DprRig[]>([]);
  const [rigTypes, setRigTypes] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>({ rigType: '', rigId: '', dateFrom: '', dateTo: '' });
  const [data, setData] = useState<OperationalDataResponse | null>(null);
  const [hsdComparison, setHsdComparison] = useState<RigHsdComparisonRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get<{ rigs: DprRig[] }>('/dpr/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
    api.get<{ rigTypes: string[] }>('/dpr/rig-types').then((d) => setRigTypes(d.rigTypes)).catch(() => {});
  }, []);

  function filterQueryString() {
    const q = new URLSearchParams();
    if (filters.rigType) q.set('rigType', filters.rigType);
    if (filters.rigId) q.set('rigId', filters.rigId);
    if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) q.set('dateTo', filters.dateTo);
    return q;
  }

  async function generate() {
    setError('');
    setLoading(true);
    try {
      const q = filterQueryString();
      const [lineItems, hsd] = await Promise.all([
        api.get<OperationalDataResponse>(`/dpr/line-items?${q}`),
        api.get<{ rows: RigHsdComparisonRow[] }>(`/dpr/operational-data/hsd-comparison?${q}`),
      ]);
      setData(lineItems);
      setHsdComparison(hsd.rows);
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
    void download(`/dpr/line-items/export.xlsx?${q}`, 'dpr-operational-data.xlsx');
  }

  return (
    <div>
      <PageHeader
        title="Operational DPR"
        subtitle="Every DPR activity line, in date order — Excel-imported and manually entered together."
        actions={
          <>
            <Link to="/dpr/import" className="btn-ghost"><UploadCloud size={14} /> Import</Link>
            <button className="btn-primary" onClick={exportExcel} disabled={!data || data.rows.length === 0}>
              <Download size={14} /> Download
            </button>
          </>
        }
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-5 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
        <select className="input" value={filters.rigType} onChange={(e) => setFilters({ ...filters, rigType: e.target.value })}>
          <option value="">All Rig Types</option>
          {rigTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
          <option value="">All Rigs</option>
          {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
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
            <Kpi icon={Gauge} tone="amber" label="R0 Total Time" value={fmtH(data.kpis.r0Hours)} />
            <Kpi icon={Wrench} tone="sky" label="R1 Total Time" value={fmtH(data.kpis.r1Hours)} />
            <Kpi icon={Settings} tone="emerald" label="R2 Total Time" value={fmtH(data.kpis.r2Hours)} />
            <Kpi icon={Layers} tone="cyan" label="R2/2 Total Time" value={fmtH(data.kpis.r22Hours)} />
            <Kpi icon={AlertTriangle} tone="rose" label="R3 Total Time" value={fmtH(data.kpis.r3Hours)} />
            <Kpi icon={BarChart3} tone="violet" label="ILM Total Time" value={fmtH(data.kpis.ilmHours)} />
          </div>

          <div className="card mb-5">
            <div className="card-header">
              <h3 className="card-title">Rig-wise HSD Consumption Comparison</h3>
              <span className="text-[11px] text-slate-500">Real hsd_equipment_lines totals per rig, for the filters above</span>
            </div>
            <div className="p-4 pt-0">
              <HsdRigComparisonChart rows={hsdComparison} />
            </div>
          </div>

          <div className="card mb-5">
            <div className="card-header"><h3 className="card-title">Operational Data</h3></div>
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th>Date</th><th>Rig No.</th><th>Well Name</th><th>Job Task No.</th>
                    <th>Work Type</th><th>Operation Code</th><th>Start</th><th>End</th><th className="text-right">Total Time</th>
                    <th>Breakdown Equipment</th><th>Breakdown Reason</th>
                    <th className="text-right">Drill From</th><th className="text-right">Drill To</th><th className="text-right">Drill Total</th>
                    <th className="text-right">Casing From</th><th className="text-right">Casing To</th><th className="text-right">Casing Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r: OperationalLineRow) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{date(r.dprDate)}</td>
                      <td className="whitespace-nowrap font-medium">{r.rigNumber}</td>
                      <td>{r.wellName ?? '-'}</td>
                      <td className="whitespace-nowrap text-slate-500">JT-{String(r.lineNo).padStart(3, '0')}</td>
                      <td>{r.workType ? <span className={`pill-engine ${WORK_TYPE_PILL[r.workType.toUpperCase()] ?? ''}`}>{r.workType}</span> : '-'}</td>
                      <td className="whitespace-nowrap">{r.operationCode ?? '-'}</td>
                      <td>{r.startTime ?? '-'}</td>
                      <td>{r.endTime ?? '-'}</td>
                      <td className="num">{r.totalHours !== null ? `${fmtH(r.totalHours)}h` : '-'}</td>
                      <td>{r.breakdownEquipment ?? '-'}</td>
                      <td>{r.breakdownReason ?? '-'}</td>
                      <td className="num">{r.drillingFrom ?? '-'}</td>
                      <td className="num">{r.drillingTo ?? '-'}</td>
                      <td className="num">{r.drillingTotal ?? '-'}</td>
                      <td className="num">{r.casingFrom ?? '-'}</td>
                      <td className="num">{r.casingTo ?? '-'}</td>
                      <td className="num">{r.casingTotal ?? '-'}</td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && <tr><td colSpan={17}><Empty message="No DPR activity lines match these filters." /></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
