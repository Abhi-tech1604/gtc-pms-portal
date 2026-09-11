import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HsdMonthlyTrendPoint } from '../../../lib/types';
import { Empty } from '../../ui';

/** Monthly HSD trend across the fleet — real hsd_site_lines flows, bucketed by month. */
export default function HsdMonthlyTrendChart({ points }: { points: HsdMonthlyTrendPoint[] }) {
  if (points.length === 0) return <Empty message="No HSD data for these filters." />;
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => `${v} L`} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="received" name="Received (L)" stroke="#0891b2" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="used" name="Used (L)" stroke="#d97706" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="transferredOut" name="Transferred Out (L)" stroke="#7c3aed" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
