import {
  Activity, AlertTriangle, ClipboardList, Droplet, Fuel, Gauge, TrendingUp, Wrench,
} from 'lucide-react';
import type { DprDashboardKpis } from '../../lib/types';

const fmt = (v: number | null | undefined, opts?: Intl.NumberFormatOptions) =>
  v === null || v === undefined ? '-' : v.toLocaleString('en-IN', { maximumFractionDigits: 2, ...opts });

const TONES: Record<string, string> = {
  sky: 'bg-sky-100 text-sky-600',
  emerald: 'bg-emerald-100 text-emerald-600',
  rose: 'bg-rose-100 text-rose-600',
  violet: 'bg-violet-100 text-violet-600',
  amber: 'bg-amber-100 text-amber-600',
  cyan: 'bg-cyan-100 text-cyan-600',
  indigo: 'bg-indigo-100 text-indigo-600',
  slate: 'bg-slate-100 text-slate-600',
};

function Kpi({ icon: Icon, tone, label, value, unit }: {
  icon: typeof Wrench; tone: keyof typeof TONES; label: string; value: string; unit?: string;
}) {
  return (
    <div className="card p-4 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-500 mb-1">{label}</div>
        <div className="text-2xl font-semibold text-slate-900 leading-tight">{value}</div>
        {unit && <div className="text-xs text-slate-400">{unit}</div>}
      </div>
      <span className={`shrink-0 h-9 w-9 rounded-lg grid place-items-center ${TONES[tone]}`}><Icon size={16} /></span>
    </div>
  );
}

export default function DashboardKpiGrid({ kpis }: { kpis: DprDashboardKpis }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
      <Kpi icon={ClipboardList} tone="sky" label="Total DPR" value={fmt(kpis.totalDpr, { maximumFractionDigits: 0 })} unit="reports" />
      <Kpi icon={TrendingUp} tone="emerald" label="Total Progress" value={fmt(kpis.totalProgress)} unit="m (drilling + casing)" />
      <Kpi icon={Wrench} tone="indigo" label="Total Rig Hours" value={fmt(kpis.totalRigHours)} unit="hours" />
      <Kpi icon={Fuel} tone="amber" label="Total Diesel" value={fmt(kpis.totalDiesel)} unit="litres" />
      <Kpi icon={Droplet} tone="cyan" label="Average Diesel/Day" value={fmt(kpis.avgDieselPerDay)} unit="litres/day" />
      <Kpi icon={Gauge} tone="violet" label="Diesel per Rig Hour" value={fmt(kpis.dieselPerRigHour)} unit="litres/hour" />
      <Kpi icon={AlertTriangle} tone="rose" label="Downtime" value={fmt(kpis.downtimeHours)} unit="hours (R3)" />
      <Kpi icon={Activity} tone="slate" label="Equipment Utilization" value={fmt(kpis.equipmentUtilizationPct)} unit="% productive" />
    </div>
  );
}
