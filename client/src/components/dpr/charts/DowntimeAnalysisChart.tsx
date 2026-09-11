import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DprDowntimeAnalysis } from '../../../lib/types';
import { Empty, Tabs } from '../../ui';

/** Downtime analysis: R3 hours grouped by rig, or by the specific activity code within R3. */
export default function DowntimeAnalysisChart({
  data, onRigClick, onOperationCodeClick,
}: {
  data: DprDowntimeAnalysis;
  onRigClick: (rigNumber: string) => void;
  onOperationCodeClick: (operationCode: string) => void;
}) {
  const [tab, setTab] = useState<'rig' | 'code'>('rig');

  return (
    <div>
      <Tabs
        tabs={[{ key: 'rig', label: 'By Rig' }, { key: 'code', label: 'By Activity Code' }]}
        active={tab} onChange={setTab}
      />
      {tab === 'rig' ? (
        data.byRig.length === 0 ? <Empty message="No downtime recorded for these filters." /> : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.byRig} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="rigNumber" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => `${v} hrs`} />
              <Bar
                dataKey="downtimeHours" name="Downtime (hrs)" fill="#e11d48" radius={[3, 3, 0, 0]}
                onClick={(d: unknown) => onRigClick((d as { rigNumber: string }).rigNumber)}
                cursor="pointer"
              />
            </BarChart>
          </ResponsiveContainer>
        )
      ) : (
        data.byOperationCode.length === 0 ? <Empty message="No downtime recorded for these filters." /> : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.byOperationCode} layout="vertical" margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="operationCode" tick={{ fontSize: 10 }} width={140} />
              <Tooltip formatter={(v) => `${v} hrs`} />
              <Bar
                dataKey="hours" name="Downtime (hrs)" fill="#ea580c" radius={[0, 3, 3, 0]}
                onClick={(d: unknown) => onOperationCodeClick((d as { operationCode: string }).operationCode)}
                cursor="pointer"
              />
            </BarChart>
          </ResponsiveContainer>
        )
      )}
    </div>
  );
}
