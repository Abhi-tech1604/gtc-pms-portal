import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DprEquipmentPerformanceRow } from '../../../lib/types';
import { Empty, InfoBox } from '../../ui';

/**
 * Equipment-wise performance — best-effort, grouped by the free-text
 * "Breakdown Equipment" name (not FK'd to Equipment Master), so two records
 * naming the same machine slightly differently won't merge.
 */
export default function EquipmentPerformanceChart({ rows }: { rows: DprEquipmentPerformanceRow[] }) {
  if (rows.length === 0) return <Empty message="No equipment activity recorded for these filters." />;
  return (
    <div>
      <InfoBox>
        Grouped by the equipment name typed on each DPR activity line — not linked by ID to Equipment
        Master, so slightly different spellings of the same machine appear as separate bars.
      </InfoBox>
      <div className="mt-3">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="equipmentName" tick={{ fontSize: 11 }} width={120} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="totalHours" name="Total Hours" fill="#0284c7" radius={[0, 3, 3, 0]} />
            <Bar dataKey="downtimeHours" name="Downtime Hours" fill="#e11d48" radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
