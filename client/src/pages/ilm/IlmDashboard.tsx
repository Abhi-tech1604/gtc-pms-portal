import { useEffect, useState, type ReactNode } from 'react';
import { rigLabel } from '../../lib/rig';
import { Link, useNavigate } from 'react-router-dom';
import {
  Fuel, Gauge, MapPin, Package, Route as RouteIcon, Truck, UploadCloud, Wallet, X,
} from 'lucide-react';
import { api, download } from '../../lib/api';
import { date } from '../../lib/format';
import type { IlmDashboardData, IlmRig, IlmSummaryReportResult } from '../../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner } from '../../components/ui';

const fmtN = (v: number | null | undefined, suffix = '') => (v === null || v === undefined ? '-' : `${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}${suffix}`);
const fmtDT = (d: string | null, t: string | null) => (d ? `${date(d)}${t ? ` ${t}` : ''}` : '-');

function InfoCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className={`rounded-lg p-3 ${tone}`}>
      <div className="text-xs font-medium opacity-70 mb-1">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function Kpi({ icon: Icon, tone, label, value }: { icon: typeof Gauge; tone: string; label: string; value: string }) {
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

function Section({ title, children, bodyClassName }: { title: string; children: ReactNode; bodyClassName?: string }) {
  return (
    <div className="card mb-5 flex flex-col h-full">
      <div className="card-header"><h3 className="card-title">{title}</h3></div>
      <div className={`overflow-x-auto ${bodyClassName ?? ''}`}>{children}</div>
    </div>
  );
}

interface Filters { rigType: string; rigId: string; dateFrom: string; dateTo: string }

/**
 * ILM → Dashboard: opens on a fleet-wide overview (real ilm_transactions/
 * ilm_cranes/ilm_trailer_loads totals across every rig, services/
 * ilm.ts's /dashboard route) as soon as the page loads — no filter is
 * required to see anything. Choosing a rig + date range and clicking
 * Generate then drills down into that one rig's Individual Summary (real
 * ilm_* data only, services/ilmSummaryReport.ts); Clear returns to the
 * fleet overview.
 *
 * Not shown: a per-equipment HSD breakdown (Rig Generator/Mud Pump/Camp DG/
 * etc.) — ILM has no per-equipment fuel-issue tracking anywhere in its data
 * model, so that table would have to be invented rather than read from real
 * data, and is intentionally left out.
 */
export default function IlmDashboard() {
  const [rigs, setRigs] = useState<IlmRig[]>([]);
  const [rigTypes, setRigTypes] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>({ rigType: '', rigId: '', dateFrom: '', dateTo: '' });
  const [overview, setOverview] = useState<IlmDashboardData | null>(null);
  const [result, setResult] = useState<IlmSummaryReportResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get<{ rigs: IlmRig[] }>('/ilm/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
    api.get<{ rigTypes: string[] }>('/ilm/rig-types').then((d) => setRigTypes(d.rigTypes)).catch(() => {});
    api.get<IlmDashboardData>('/ilm/dashboard').then(setOverview).catch((e) => setError((e as Error).message));
  }, []);

  async function generate(overrideFilters?: Filters) {
    const f = overrideFilters ?? filters;
    if (!f.rigId || !f.dateFrom || !f.dateTo) { setError('Select a rig and a Date From/To range, then Generate.'); return; }
    setError('');
    setLoading(true);
    try {
      const q = new URLSearchParams({ rigId: f.rigId, dateFrom: f.dateFrom, dateTo: f.dateTo });
      setResult(await api.get<IlmSummaryReportResult>(`/ilm/summary?${q}`));
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }

  /**
   * "Rig-wise ILM Activity" rows drill into that rig's Individual Summary —
   * the same view a manual rig + date-range Generate produces. There's no
   * "first movement date" in the fleet overview, so the range is widened to
   * 5 years back from that rig's last movement, which is generous enough to
   * catch every real ILM on a rig without needing another round-trip first.
   */
  function selectRig(rigId: string, lastMovementDate: string) {
    const to = lastMovementDate;
    const fromDate = new Date(lastMovementDate);
    fromDate.setFullYear(fromDate.getFullYear() - 5);
    const from = fromDate.toISOString().slice(0, 10);
    const next: Filters = { rigType: '', rigId, dateFrom: from, dateTo: to };
    setFilters(next);
    void generate(next);
  }

  function clearToOverview() {
    setFilters({ rigType: '', rigId: '', dateFrom: '', dateTo: '' });
    setResult(null);
    setError('');
  }

  function exportExcel() {
    if (!filters.rigId || !filters.dateFrom || !filters.dateTo) return;
    const q = new URLSearchParams({ rigId: filters.rigId, dateFrom: filters.dateFrom, dateTo: filters.dateTo });
    void download(`/ilm/summary/export.xlsx?${q}`, 'ilm-summary.xlsx');
  }

  const visibleRigs = filters.rigType ? rigs.filter((r) => r.rigType === filters.rigType) : rigs;

  function setRigType(rigType: string) {
    const stillValid = !rigType || rigs.some((r) => r.id === filters.rigId && r.rigType === rigType);
    setFilters({ ...filters, rigType, rigId: stillValid ? filters.rigId : '' });
  }

  const report = result && result.found ? result : null;

  return (
    <div>
      <PageHeader
        title="ILM Dashboard"
        subtitle={report
          ? 'Individual movement report for one rig across a date range — real ilm_individual/ilm_cranes/ilm_trailer_loads data only.'
          : 'Fleet-wide totals across every rig — real ilm_transactions/ilm_cranes/ilm_trailer_loads data only. Choose a rig and date range to drill into one rig.'}
        actions={
          <>
            {report && <button className="btn-primary" onClick={exportExcel}>Download</button>}
            <Link to="/ilm/import" className="btn-ghost"><UploadCloud size={14} /> Import</Link>
          </>
        }
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-5 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
        <select className="input" value={filters.rigType} onChange={(e) => setRigType(e.target.value)}>
          <option value="">All Rig Types</option>
          {rigTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input" value={filters.rigId} onChange={(e) => setFilters({ ...filters, rigId: e.target.value })}>
          <option value="">Choose a rig...</option>
          {visibleRigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
        </select>
        <Field label=""><input className="input" type="date" value={filters.dateFrom} placeholder="Date From" onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })} /></Field>
        <Field label=""><input className="input" type="date" value={filters.dateTo} placeholder="Date To" onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })} /></Field>
        <div className="flex gap-2">
          <button className="btn-primary justify-center flex-1" onClick={() => void generate()} disabled={loading}>Generate</button>
          {result && (
            <button className="btn-ghost" onClick={clearToOverview} title="Back to fleet overview"><X size={14} /></button>
          )}
        </div>
      </div>

      {loading && <Spinner />}

      {!loading && result && !result.found && (
        <div className="card"><Empty message="No ILM movement exists for that rig in this date range. Enter or import one first." /></div>
      )}

      {!loading && !result && (
        overview ? <FleetOverview data={overview} onSelectRig={selectRig} /> : <Spinner />
      )}

      {!loading && report && (
        <>
          <Section title="Summary Information">
            <div className="p-4">
              {report.movementCount > 1 && (
                <div className="text-xs text-slate-500 mb-3">
                  {report.movementCount} ILM movements in this range — figures below are combined across all of them.
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                <InfoCard label="Rig No." value={report.summary.rigNumber} tone="bg-sky-50 text-sky-800" />
                <InfoCard label="Area" value={report.summary.area ?? '-'} tone="bg-emerald-50 text-emerald-800" />
                <InfoCard label="Operator Name" value={report.summary.operatorName ?? '-'} tone="bg-violet-50 text-violet-800" />
                <InfoCard label="Well No." value={report.summary.wellNo ?? '-'} tone="bg-amber-50 text-amber-800" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="text-xs text-slate-500 mb-1">Movement</div>
                  <div className="font-medium">{report.summary.movementFromWell ?? '-'} &rarr; {report.summary.movementToWell ?? '-'}</div>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="text-xs text-slate-500 mb-1">Release Date &amp; Time</div>
                  <div className="font-medium">{fmtDT(report.summary.releaseDate, report.summary.releaseTime)}</div>
                </div>
                <div className="rounded-lg border border-slate-200 p-3">
                  <div className="text-xs text-slate-500 mb-1">Spud Date &amp; Time</div>
                  <div className="font-medium">{fmtDT(report.summary.spudDate, report.summary.spudTime)}</div>
                </div>
              </div>
              <div className="rounded-lg bg-indigo-50 text-indigo-800 p-3 text-center">
                <div className="text-xs font-medium opacity-70">Total Days from Release to Spud</div>
                <div className="text-xl font-semibold">{report.summary.totalDaysReleaseToSpud !== null ? `${report.summary.totalDaysReleaseToSpud} Days` : '-'}</div>
              </div>
            </div>
          </Section>

          <Section title="Equipment & Capacity">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Crane Capacity</th><th>Trailer Capacity</th><th>Total No. of Cranes</th><th>Total No. of Trailers</th>
                  {report.equipment.delayReasonCounts.map((d) => <th key={d.reason}>{d.reason}</th>)}
                  <th>Total Time for Delay</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="num">{fmtN(report.equipment.craneCapacityTon, ' Ton')}</td>
                  <td className="num">{fmtN(report.equipment.trailerCapacityTon, ' Ton')}</td>
                  <td className="num">{report.equipment.totalCranes}</td>
                  <td className="num">{report.equipment.totalTrailers}</td>
                  {report.equipment.delayReasonCounts.map((d) => <td key={d.reason} className="num">{d.count}</td>)}
                  <td className="num">{fmtN(report.equipment.totalTimeForDelayHrs, ' Hrs')}</td>
                </tr>
              </tbody>
            </table>
          </Section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Section title="Trailer Analysis (by Type)">
              {report.trailerAnalysis.byType.length === 0 ? <Empty message="No trailer loads in this range." /> : (
                <table className="table text-xs">
                  <thead>
                    <tr><th>Trailer Type</th><th className="text-right">Trip Count</th><th className="text-right">Total Loads</th></tr>
                  </thead>
                  <tbody>
                    {report.trailerAnalysis.byType.map((t) => (
                      <tr key={t.trailerType}>
                        <td>{t.trailerType}</td>
                        <td className="num">{t.tripCount}</td>
                        <td className="num">{fmtN(t.totalLoads)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section title="Crane Analysis (by Unit)">
              {report.craneAnalysis.byUnit.length === 0 ? <Empty message="No crane records in this range." /> : (
                <table className="table text-xs">
                  <thead>
                    <tr>
                      <th>Crane / Transporter</th><th>Rig/Hired</th>
                      <th className="text-right">Working Hrs</th><th className="text-right">Breakdown Hrs</th>
                      <th className="text-right">Breakdown Ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.craneAnalysis.byUnit.map((c) => (
                      <tr key={c.craneNo}>
                        <td>{c.craneNo}{c.transporterName ? <span className="text-slate-400"> · {c.transporterName}</span> : null}</td>
                        <td>{c.rigOrHired ?? '-'}</td>
                        <td className="num">{fmtN(c.totalWorkingHrs, ' Hrs')}</td>
                        <td className="num">{fmtN(c.totalBreakdownHrs, ' Hrs')}</td>
                        <td className={`num font-medium ${c.breakdownRatioPct > 20 ? 'text-red-600' : c.breakdownRatioPct > 5 ? 'text-amber-600' : ''}`}>
                          {fmtN(c.breakdownRatioPct, '%')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>

          <Section title="HSD Consumption Summary">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>HSD Stock @ Rig Accession</th><th>Received Qty During ILM</th><th>HSD Stock @ Shift End</th>
                  <th>Total HSD Consumption</th><th>ILM Distance (KM)</th><th>Total Loads Moved</th>
                  <th>Cumulative Trailer KMs</th><th>Avg Consumption per KM</th>
                  <th>Cumulative Crane Hrs</th><th>Avg Consumption per Hr</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="num">{fmtN(report.hsd.hsdStockAccession, ' L')}</td>
                  <td className="num">{fmtN(report.hsd.receivedQtyDuringIlm, ' L')}</td>
                  <td className="num">{fmtN(report.hsd.hsdStockShiftEnd, ' L')}</td>
                  <td className="num">{fmtN(report.hsd.totalHsdConsumption, ' L')}</td>
                  <td className="num">{fmtN(report.hsd.ilmDistanceKm)}</td>
                  <td className="num">{fmtN(report.hsd.totalLoadsMoved)}</td>
                  <td className="num">{fmtN(report.hsd.cumulativeTrailerKm)}</td>
                  <td className="num">{fmtN(report.hsd.avgConsumptionPerKm)}</td>
                  <td className="num">{fmtN(report.hsd.cumulativeCraneHrs)}</td>
                  <td className="num">{fmtN(report.hsd.avgConsumptionPerHr)}</td>
                </tr>
              </tbody>
            </table>
          </Section>

          <Section title="ILM Time & Costs">
            <table className="table text-xs">
              <thead>
                <tr>
                  <th>Total Hrs for ILM</th><th>Total No. of Days for ILM</th><th>ILM Rate</th><th>ILM Expenses</th>
                  <th>Average Day Rate</th><th>Operating Day Rate</th><th>% Effective Day Rate</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="num">{fmtN(report.timeAndCosts.totalHrsForIlm, ' Hrs')}</td>
                  <td className="num">{report.timeAndCosts.totalDaysForIlm !== null ? `${report.timeAndCosts.totalDaysForIlm} Days` : '-'}</td>
                  <td className="num">{report.timeAndCosts.ilmRatePerDay !== null ? fmtN(report.timeAndCosts.ilmRatePerDay) : <span className="text-slate-400">Not entered</span>}</td>
                  <td className="num">{report.timeAndCosts.ilmExpenses !== null ? fmtN(report.timeAndCosts.ilmExpenses) : <span className="text-slate-400">Not entered</span>}</td>
                  <td className="num">{fmtN(report.timeAndCosts.averageDayRate)}</td>
                  <td className="num">{fmtN(report.timeAndCosts.operatingDayRate)}</td>
                  <td className="num">{fmtN(report.timeAndCosts.effectiveDayRatePct, '%')}</td>
                </tr>
              </tbody>
            </table>
          </Section>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Kpi icon={Fuel} tone="bg-amber-100 text-amber-600" label="Total HSD Consumption" value={fmtN(report.kpis.totalHsdConsumption, 'L')} />
            <Kpi icon={Wallet} tone="bg-emerald-100 text-emerald-600" label="ILM Fleet Cost" value={report.kpis.ilmFleetCost !== null ? fmtN(report.kpis.ilmFleetCost) : 'Not entered'} />
            <Kpi icon={RouteIcon} tone="bg-sky-100 text-sky-600" label="Distance Covered" value={fmtN(report.kpis.distanceCoveredKm, ' KM')} />
            <Kpi icon={MapPin} tone="bg-violet-100 text-violet-600" label="Effective Day Rate" value={fmtN(report.kpis.effectiveDayRatePct, '%')} />
          </div>
        </>
      )}
    </div>
  );
}

/** The fleet-wide landing view — shown automatically until a rig+date range is generated. */
function FleetOverview({ data, onSelectRig }: { data: IlmDashboardData; onSelectRig: (rigId: string, lastMovementDate: string) => void }) {
  const navigate = useNavigate();
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Kpi icon={Gauge} tone="bg-sky-100 text-sky-600" label="Total ILMs" value={fmtN(data.kpis.totalMovements)} />
        <Kpi icon={Gauge} tone="bg-emerald-100 text-emerald-600" label="Active ILMs" value={fmtN(data.kpis.activeMovements)} />
        <Kpi icon={RouteIcon} tone="bg-violet-100 text-violet-600" label="Total Distance" value={fmtN(data.kpis.totalDistanceKm, ' KM')} />
        <Kpi icon={Fuel} tone="bg-amber-100 text-amber-600" label="Total HSD Consumption" value={fmtN(data.kpis.totalHsdConsumption, ' L')} />
        <Kpi icon={Truck} tone="bg-sky-100 text-sky-600" label="Trailer Loads" value={fmtN(data.kpis.totalTrailerLoads)} />
        <Kpi icon={Package} tone="bg-emerald-100 text-emerald-600" label="Crane Records" value={fmtN(data.kpis.totalCraneRecords)} />
        <Kpi icon={Wallet} tone="bg-violet-100 text-violet-600" label="Avg Consumption/KM" value={fmtN(data.kpis.avgConsumptionPerKm, ' L')} />
        <Kpi icon={Gauge} tone="bg-slate-100 text-slate-600" label="Completed ILMs" value={fmtN(data.kpis.completedMovements)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5 items-stretch">
        <Section title="Rig-wise ILM Activity" bodyClassName="max-h-[420px] overflow-y-auto">
          <table className="table text-xs">
            <thead>
              <tr><th>Rig</th><th className="text-right">ILM Count</th><th>Last Started</th></tr>
            </thead>
            <tbody>
              {data.rigWise.map((r) => {
                const clickable = r.movementCount > 0 && !!r.lastMovementDate;
                return (
                  <tr
                    key={r.rigId}
                    className={clickable ? 'cursor-pointer hover:bg-slate-50' : undefined}
                    title={clickable ? "Open this rig's Individual Summary" : undefined}
                    onClick={clickable ? () => onSelectRig(r.rigId, r.lastMovementDate!) : undefined}
                  >
                    <td>{rigLabel({ name: r.rigName, rigNumber: r.rigNumber })}</td>
                    <td className="num">{r.movementCount}</td>
                    <td>{r.lastMovementDate ? date(r.lastMovementDate) : '-'}</td>
                  </tr>
                );
              })}
              {data.rigWise.length === 0 && <tr><td colSpan={3}><Empty message="No rigs registered yet." /></td></tr>}
            </tbody>
          </table>
        </Section>

        <Section title="Recent ILMs" bodyClassName="max-h-[420px] overflow-y-auto">
          <table className="table text-xs">
            <thead>
              <tr>
                <th>ILM No.</th><th>Rig</th><th>Started</th><th>Movement</th><th>Source</th><th>Status</th>
                <th className="text-right">Distance (KM)</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((t) => (
                <tr
                  key={t.id}
                  className="cursor-pointer hover:bg-slate-50"
                  title="Open this ILM's full details/history"
                  onClick={() => navigate(`/ilm/entry/${t.id}`)}
                >
                  <td className="font-medium whitespace-nowrap">{t.ilmNumber}</td>
                  <td>{t.rigNumber}</td>
                  <td className="whitespace-nowrap">{date(t.date)}</td>
                  <td className="text-xs">{t.movementFromWell ?? '-'} &rarr; {t.movementToWell ?? '-'}</td>
                  <td>{t.source === 'excel' ? 'Excel' : 'Manual'}</td>
                  <td>
                    <span className={`pill-engine ${t.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'}`}>
                      {t.status === 'Active' ? 'ACTIVE' : 'COMPLETED'}
                    </span>
                  </td>
                  <td className="num">{fmtN(t.totalDistanceKm)}</td>
                </tr>
              ))}
              {data.recent.length === 0 && <tr><td colSpan={7}><Empty message="No ILMs entered yet." /></td></tr>}
            </tbody>
          </table>
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Section title="Trailer Fleet">
          <div className="p-4 grid grid-cols-2 gap-3 text-sm">
            <div><div className="text-xs text-slate-500">Trailers Deployed</div><div className="font-semibold">{fmtN(data.trailerSummary.totalTrailersDeployed)}</div></div>
            <div><div className="text-xs text-slate-500">Total Loads</div><div className="font-semibold">{fmtN(data.trailerSummary.totalLoads)}</div></div>
            <div><div className="text-xs text-slate-500">Total Packages</div><div className="font-semibold">{fmtN(data.trailerSummary.totalPackages)}</div></div>
            <div><div className="text-xs text-slate-500">Total Lead Distance</div><div className="font-semibold">{fmtN(data.trailerSummary.totalDistanceKm, ' KM')}</div></div>
          </div>
        </Section>
        <Section title="Crane Fleet">
          <div className="p-4 grid grid-cols-2 gap-3 text-sm">
            <div><div className="text-xs text-slate-500">Cranes Deployed</div><div className="font-semibold">{fmtN(data.craneSummary.totalCranesDeployed)}</div></div>
            <div><div className="text-xs text-slate-500">Total Capacity</div><div className="font-semibold">{fmtN(data.craneSummary.totalCapacityTon, ' Ton')}</div></div>
            <div><div className="text-xs text-slate-500">Total Working Hours</div><div className="font-semibold">{fmtN(data.craneSummary.totalWorkingHours, ' Hrs')}</div></div>
            <div><div className="text-xs text-slate-500">Total Breakdown Hours</div><div className="font-semibold">{fmtN(data.craneSummary.totalBreakdownHours, ' Hrs')}</div></div>
          </div>
        </Section>
      </div>
    </>
  );
}
