import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HsdRigWiseBalance } from '../../../lib/types';
import { Empty } from '../../ui';

/** HSD Received vs Used, per rig — real hsd_site_lines flows over the selected range. */
export default function HsdReceivedVsUsedChart({ rows }: { rows: HsdRigWiseBalance[] }) {
  if (rows.length === 0) return <Empty message="No HSD data for these filters." />;
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="rigNumber" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => `${v} L`} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="received" name="Received (L)" fill="#0891b2" radius={[3, 3, 0, 0]} />
        <Bar dataKey="used" name="Used (L)" fill="#d97706" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
