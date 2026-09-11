import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HsdReportKpis } from '../../../lib/types';
import { Empty } from '../../ui';

const COLORS = ['#0891b2', '#10b981', '#d97706', '#64748b'];

/** Opening -> Received -> Used -> Closing, fleet-wide, for the selected filters. */
export default function HsdBalanceFlowChart({ kpis, hasData }: { kpis: HsdReportKpis; hasData: boolean }) {
  if (!hasData) return <Empty message="No HSD data for these filters." />;
  const rows = [
    { stage: 'Opening', value: kpis.totalOpeningStock },
    { stage: 'Received', value: kpis.totalReceived },
    { stage: 'Used', value: kpis.totalUsed },
    { stage: 'Closing', value: kpis.totalClosingBalance },
  ];
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="stage" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => `${v} L`} />
        <Bar dataKey="value" name="HSD (L)" radius={[3, 3, 0, 0]}>
          {rows.map((r, i) => <Cell key={r.stage} fill={COLORS[i]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
