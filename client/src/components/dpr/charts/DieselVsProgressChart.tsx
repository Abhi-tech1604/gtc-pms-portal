import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import type { DprDashboardRigComparisonRow } from '../../../lib/types';
import { Empty } from '../../ui';

/** Diesel vs Progress: one point per rig, to spot rigs burning fuel without matching progress. */
export default function DieselVsProgressChart({ rows }: { rows: DprDashboardRigComparisonRow[] }) {
  if (rows.length === 0) return <Empty message="No data for these filters." />;
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis type="number" dataKey="totalProgress" name="Progress" unit="m" tick={{ fontSize: 11 }} />
        <YAxis type="number" dataKey="totalDiesel" name="Diesel" unit="L" tick={{ fontSize: 11 }} />
        <ZAxis dataKey="rigNumber" name="Rig" />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(v) => v} labelFormatter={() => ''} />
        <Scatter data={rows} fill="#0891b2" />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
