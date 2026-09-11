import { useEffect, useState } from 'react';
import { rigLabel } from '../../lib/rig';
import { Download, Fuel, Gauge, PackageCheck, Truck, Wallet } from 'lucide-react';
import { api, download } from '../../lib/api';
import type { DprRig, HsdReportResult, RigHsdComparisonRow } from '../../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../../components/ui';
import HsdReceivedVsUsedChart from '../../components/dpr/charts/HsdReceivedVsUsedChart';
import HsdMonthlyTrendChart from '../../components/dpr/charts/HsdMonthlyTrendChart';
import HsdBalanceFlowChart from '../../components/dpr/charts/HsdBalanceFlowChart';
import HsdRigComparisonChart from '../../components/dpr/charts/HsdRigComparisonChart';

interface Filters { rigId: string; dateFrom: string; dateTo: string; month: string }
const EMPTY_FILTERS: Filters = { rigId: '', dateFrom: '', dateTo: '', month: '' };

function Kpi({ icon: Icon, tone, label, value }: { icon: typeof Fuel; tone: string; label: string; value: string }) {
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

const fmtL = (n: number) => `${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })} L`;

/**
 * DPR → HSD Report: a dedicated diesel-account dashboard built entirely from
 * hsd_site_lines ('Rig Site Diesel') + hsd_equipment_lines — the same data
 * every other HSD-aware screen reads, aggregated a new way rather than
 * duplicated. See services/hsdReport.ts for how Opening/Closing balances are
 * kept separate from Received/Used/Transferred-out flows.
 */
export default function HsdReport() {
  const [rigs, setRigs] = useState<DprRig[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [report, setReport] = useState<HsdReportResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ rigs: DprRig[] }>('/dpr/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  const qs = buildQueryString(filters);

  useEffect(() => {
    setError('');
    api.get<HsdReportResult>(`/hsd/report${qs}`)
      .then(setReport)
      .catch((e) => setError((e as Error).message));
  }, [qs]);

  function exportExcel() {
    void download(`/hsd/report/export.xlsx${qs}`, 'hsd-report.xlsx');
  }

  const consumptionRows: RigHsdComparisonRow[] = (report?.rigWise ?? []).map((r) => ({
    rigId: r.rigId, rigNumber: r.rigNumber, rigName: r.rigName, totalConsumption: r.used,
  }));

  return (
    <div>
      <PageHeader
        title="HSD Report"
        subtitle="Rig diesel account — opening, received, transferred out, used and closing — from real HSD data only."
        actions={report ? <button className="btn-primary" onClick={exportExcel}><Download size={14} /> Download</button> : undefined}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-5 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
        <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
          <option value="">All Rigs</option>
          {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
        </select>
        <Field label=""><input className="input" type="date" value={filters.dateFrom} placeholder="Date From" onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value, month: '' })} /></Field>
        <Field label=""><input className="input" type="date" value={filters.dateTo} placeholder="Date To" onChange={(e) => setFilters({ ...filters, dateTo: e.target.value, month: '' })} /></Field>
        <Field label="" hint="Overrides Date From/To when set">
          <input className="input" type="month" value={filters.month} onChange={(e) => setFilters({ ...filters, month: e.target.value, dateFrom: '', dateTo: '' })} />
        </Field>
        <button className="btn-ghost justify-center" disabled={filters === EMPTY_FILTERS} onClick={() => setFilters(EMPTY_FILTERS)}>Clear</button>
      </div>

      {!report ? (
        !error && <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-5">
            <Kpi icon={Fuel} tone="bg-sky-100 text-sky-600" label="Opening Stock" value={fmtL(report.kpis.totalOpeningStock)} />
            <Kpi icon={Truck} tone="bg-emerald-100 text-emerald-600" label="Received" value={fmtL(report.kpis.totalReceived)} />
            <Kpi icon={PackageCheck} tone="bg-violet-100 text-violet-600" label="Transferred Out" value={fmtL(report.kpis.totalTransferredOut)} />
            <Kpi icon={Gauge} tone="bg-amber-100 text-amber-600" label="Used / Consumed" value={fmtL(report.kpis.totalUsed)} />
            <Kpi icon={Wallet} tone="bg-slate-100 text-slate-600" label="Closing Balance" value={fmtL(report.kpis.totalClosingBalance)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">HSD Received vs Used</h3></div>
              <HsdReceivedVsUsedChart rows={report.rigWise} />
            </div>
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">Rig-wise HSD Consumption</h3></div>
              <HsdRigComparisonChart rows={consumptionRows} />
            </div>
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">Monthly HSD Trend</h3></div>
              <HsdMonthlyTrendChart points={report.monthlyTrend} />
            </div>
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">Opening &rarr; Received &rarr; Used &rarr; Closing</h3></div>
              <HsdBalanceFlowChart kpis={report.kpis} hasData={report.rigWise.length > 0} />
            </div>
          </div>

          <div className="card mb-5">
            <div className="card-header"><h3 className="card-title">Rig-wise Opening / Received / Used / Closing</h3></div>
            <div className="overflow-x-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th>Rig</th><th className="text-right">Opening (L)</th><th className="text-right">Received (L)</th>
                    <th className="text-right">Transferred Out (L)</th><th className="text-right">Used (L)</th>
                    <th className="text-right">Closing (L)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rigWise.map((r) => (
                    <tr key={r.rigId}>
                      <td className="whitespace-nowrap font-medium">{rigLabel({ name: r.rigName, rigNumber: r.rigNumber })}</td>
                      <td className="num">{fmtL(r.opening)}</td>
                      <td className="num">{fmtL(r.received)}</td>
                      <td className="num">{fmtL(r.transferredOut)}</td>
                      <td className="num">{fmtL(r.used)}</td>
                      <td className="num">{fmtL(r.closing)}</td>
                    </tr>
                  ))}
                  {report.rigWise.length === 0 && <tr><td colSpan={6}><Empty message="No HSD data for these filters." /></td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><h3 className="card-title">HSD Transfer History</h3></div>
            <div className="max-h-[420px] overflow-auto">
              <table className="table text-xs">
                <thead>
                  <tr>
                    <th>Date</th><th>Rig</th><th className="text-right">Opening (L)</th><th className="text-right">Received (L)</th>
                    <th className="text-right">Transferred Out (L)</th><th className="text-right">Used (L)</th><th className="text-right">Closing (L)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.transferHistory.map((r) => (
                    <tr key={`${r.rigId}-${r.date}`}>
                      <td className="whitespace-nowrap">{r.date}</td>
                      <td className="whitespace-nowrap">{r.rigNumber}</td>
                      <td className="num">{fmtL(r.opening)}</td>
                      <td className="num">{fmtL(r.received)}</td>
                      <td className="num">{fmtL(r.transferredOut)}</td>
                      <td className="num">{fmtL(r.used)}</td>
                      <td className="num">{fmtL(r.closing)}</td>
                    </tr>
                  ))}
                  {report.transferHistory.length === 0 && <tr><td colSpan={7}><Empty message="No HSD transfer history for these filters." /></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function buildQueryString(filters: Filters): string {
  const q = new URLSearchParams();
  if (filters.rigId) q.set('rigId', filters.rigId);
  if (filters.month) q.set('month', filters.month);
  else {
    if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) q.set('dateTo', filters.dateTo);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
