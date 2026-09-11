import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DprDashboardRigComparisonRow } from '../../../lib/types';
import { Empty } from '../../ui';

/** DPR-wise performance: progress and hours per rig, side by side. */
export default function DprPerformanceChart({
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
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar
          dataKey="totalProgress" name="Progress (m)" fill="#059669" radius={[3, 3, 0, 0]}
          onClick={(d: unknown) => onBarClick((d as DprDashboardRigComparisonRow).rigId)}
          cursor="pointer"
        />
        <Bar
          dataKey="totalHours" name="Hours" fill="#0284c7" radius={[3, 3, 0, 0]}
          onClick={(d: unknown) => onBarClick((d as DprDashboardRigComparisonRow).rigId)}
          cursor="pointer"
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
