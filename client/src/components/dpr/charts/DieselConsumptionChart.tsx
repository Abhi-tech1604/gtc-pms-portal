import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DprDashboardRigComparisonRow } from '../../../lib/types';
import { Empty } from '../../ui';

/** Diesel-wise consumption per rig. */
export default function DieselConsumptionChart({
  rows, onBarClick,
}: {
  rows: DprDashboardRigComparisonRow[];
  onBarClick: (rigId: string) => void;
}) {
  if (rows.length === 0) return <Empty message="No data for these filters." />;
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="rigNumber" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => `${v} L`} />
        <Bar
          dataKey="totalDiesel" name="Diesel (L)" fill="#d97706" radius={[3, 3, 0, 0]}
          onClick={(d: unknown) => onBarClick((d as DprDashboardRigComparisonRow).rigId)}
          cursor="pointer"
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
