import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { RigHsdComparisonRow } from '../../../lib/types';
import { Empty } from '../../ui';

/**
 * Rig-wise HSD consumption comparison — one bar per real rig from the DPR
 * Rig Master (never a hardcoded "R1"/"R2"/"R3" placeholder), over whatever
 * rig type/rig/date range is selected on the page.
 */
export default function HsdRigComparisonChart({ rows }: { rows: RigHsdComparisonRow[] }) {
  if (rows.length === 0) return <Empty message="No rigs to compare." />;
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="rigNumber" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => `${v} L`} labelFormatter={(label) => `Rig ${label}`} />
        <Bar dataKey="totalConsumption" name="HSD Consumption (L)" fill="#0891b2" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
