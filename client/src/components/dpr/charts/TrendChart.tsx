import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DprTrendPoint } from '../../../lib/types';
import { Empty } from '../../ui';

export type Granularity = 'day' | 'week' | 'month';

/** Daily/weekly/monthly trends: DPR count, hours, progress and downtime over time. */
export default function TrendChart({
  points, granularity, onGranularityChange,
}: {
  points: DprTrendPoint[];
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
}) {
  return (
    <div>
      <div className="flex justify-end gap-1 mb-2">
        {(['day', 'week', 'month'] as Granularity[]).map((g) => (
          <button
            key={g}
            className={`px-2 py-1 rounded text-xs font-medium ${granularity === g ? 'bg-rig-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            onClick={() => onGranularityChange(g)}
          >
            {g[0].toUpperCase() + g.slice(1)}
          </button>
        ))}
      </div>
      {points.length === 0 ? <Empty message="No data for these filters." /> : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="dprCount" name="DPR Count" stroke="#0284c7" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="totalHours" name="Hours" stroke="#059669" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="totalProgress" name="Progress (m)" stroke="#7c3aed" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="downtimeHours" name="Downtime (hrs)" stroke="#e11d48" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
