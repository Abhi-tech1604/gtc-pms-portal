import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import type {
  DprDashboardDataV2, DprDowntimeAnalysis, DprEquipmentOption, DprEquipmentPerformanceRow, DprRig, DprTrendPoint,
} from '../../lib/types';
import { ErrorBox, PageHeader, Spinner } from '../../components/ui';
import DashboardFilters, { EMPTY_DASHBOARD_FILTERS, type DashboardFilterState } from '../../components/dpr/DashboardFilters';
import DashboardKpiGrid from '../../components/dpr/DashboardKpiGrid';
import RigComparisonTable from '../../components/dpr/RigComparisonTable';
import ExportButtons from '../../components/dpr/ExportButtons';
import DprPerformanceChart from '../../components/dpr/charts/DprPerformanceChart';
import DieselConsumptionChart from '../../components/dpr/charts/DieselConsumptionChart';
import RigComparisonChart from '../../components/dpr/charts/RigComparisonChart';
import TrendChart, { type Granularity } from '../../components/dpr/charts/TrendChart';
import DieselVsProgressChart from '../../components/dpr/charts/DieselVsProgressChart';
import EquipmentPerformanceChart from '../../components/dpr/charts/EquipmentPerformanceChart';
import DowntimeAnalysisChart from '../../components/dpr/charts/DowntimeAnalysisChart';

/**
 * The DPR Dashboard: filters, 8 KPI cards, 7 charts, a sortable/searchable
 * Rig Comparison table, drill-down and Excel/PDF export — all backed by
 * server-side aggregation (services/dprDashboard.ts) over the real DPR/HSD
 * tables. DprEntry.tsx (the form), Excel Import, Rig Master, Equipment
 * Master and User Rights are untouched; DprProgressReport.tsx remains the
 * separate flat, one-row-per-report browsing view.
 */
export default function DprDashboard() {
  const navigate = useNavigate();
  const [rigs, setRigs] = useState<DprRig[]>([]);
  const [filters, setFilters] = useState<DashboardFilterState>(EMPTY_DASHBOARD_FILTERS);
  const [granularity, setGranularity] = useState<Granularity>('day');

  const [dash, setDash] = useState<DprDashboardDataV2 | null>(null);
  const [trends, setTrends] = useState<DprTrendPoint[]>([]);
  const [equipmentPerf, setEquipmentPerf] = useState<DprEquipmentPerformanceRow[]>([]);
  const [downtime, setDowntime] = useState<DprDowntimeAnalysis | null>(null);
  const [equipmentOptions, setEquipmentOptions] = useState<DprEquipmentOption[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ rigs: DprRig[] }>('/dpr/rigs').then((d) => setRigs(d.rigs)).catch((e) => setError((e as Error).message));
  }, []);

  const qs = buildQueryString(filters);

  useEffect(() => {
    setError('');
    Promise.all([
      api.get<DprDashboardDataV2>(`/dpr/dashboard${qs}`),
      api.get<{ points: DprTrendPoint[] }>(`/dpr/dashboard/trends${qs}${qs ? '&' : '?'}granularity=${granularity}`),
      api.get<{ rows: DprEquipmentPerformanceRow[] }>(`/dpr/dashboard/equipment${qs}`),
      api.get<DprDowntimeAnalysis>(`/dpr/dashboard/downtime${qs}`),
    ])
      .then(([dashData, trendData, equipData, downtimeData]) => {
        setDash(dashData);
        setTrends(trendData.points);
        setEquipmentPerf(equipData.rows);
        setDowntime(downtimeData);
      })
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, granularity]);

  /**
   * "Select a rig, first load that rig's DPR dataset, then show its related
   * equipment" — the equipment filter's own options only populate once a rig
   * is chosen, mirroring DprEntry.tsx's live equipment dropdown.
   */
  useEffect(() => {
    if (!filters.rigId) { setEquipmentOptions([]); return; }
    api.get<{ equipment: DprEquipmentOption[] }>(`/dpr/dashboard/equipment-options?rigId=${filters.rigId}`)
      .then((d) => setEquipmentOptions(d.equipment))
      .catch(() => setEquipmentOptions([]));
  }, [filters.rigId]);

  /** Carries the dashboard's date window onto the rig page, same pattern as before this upgrade. */
  const rigLinkQuery = (() => {
    const q = new URLSearchParams();
    if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) q.set('dateTo', filters.dateTo);
    return q.toString() ? `?${q}` : '';
  })();

  function goToRig(rigId: string) {
    navigate(`/dpr/rig/${rigId}${rigLinkQuery}`);
  }

  function goToRigByNumber(rigNumber: string) {
    const rig = rigs.find((r) => r.rigNumber === rigNumber);
    if (rig) goToRig(rig.id);
  }

  return (
    <div>
      <PageHeader
        title="DPR Dashboard"
        subtitle="Rig-wise and date-wise progress from every DPR on record — Excel-imported and manually entered together."
        actions={dash ? <ExportButtons queryString={qs} /> : undefined}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <DashboardFilters filters={filters} onChange={setFilters} rigs={rigs} equipmentOptions={equipmentOptions} />

      {!dash ? (
        !error && <Spinner />
      ) : (
        <>
          <DashboardKpiGrid kpis={dash.kpis} />

          <RigComparisonTable rows={dash.rigWise} onSelectRig={goToRig} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">DPR-wise Performance</h3></div>
              <DprPerformanceChart rows={dash.rigWise} onBarClick={goToRig} />
            </div>
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">Diesel-wise Consumption</h3></div>
              <DieselConsumptionChart rows={dash.rigWise} onBarClick={goToRig} />
            </div>
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">Rig-wise Comparison</h3></div>
              <RigComparisonChart rows={dash.rigWise} onBarClick={goToRig} />
            </div>
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">Diesel vs Progress</h3></div>
              <DieselVsProgressChart rows={dash.rigWise} />
            </div>
          </div>

          <div className="card p-4 mb-5">
            <div className="card-header px-0 pt-0"><h3 className="card-title">Daily / Weekly / Monthly Trends</h3></div>
            <TrendChart points={trends} granularity={granularity} onGranularityChange={setGranularity} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">Equipment-wise Performance</h3></div>
              <EquipmentPerformanceChart rows={equipmentPerf} />
            </div>
            <div className="card p-4">
              <div className="card-header px-0 pt-0"><h3 className="card-title">Downtime Analysis</h3></div>
              {downtime && (
                <DowntimeAnalysisChart
                  data={downtime}
                  onRigClick={goToRigByNumber}
                  onOperationCodeClick={(code) => setFilters({ ...filters, operationCode: code })}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function buildQueryString(filters: DashboardFilterState): string {
  const q = new URLSearchParams();
  if (filters.search.trim()) q.set('search', filters.search.trim());
  if (filters.rigId) q.set('rigId', filters.rigId);
  if (filters.status) q.set('status', filters.status);
  if (filters.dateFrom) q.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) q.set('dateTo', filters.dateTo);
  if (filters.workType) q.set('workType', filters.workType);
  if (filters.operationCode) q.set('operationCode', filters.operationCode);
  if (filters.equipment) q.set('equipment', filters.equipment);
  const s = q.toString();
  return s ? `?${s}` : '';
}
