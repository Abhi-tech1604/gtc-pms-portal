import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';
import { count, date, statusClass } from '../lib/format';
import type { DashboardData } from '../lib/types';
import { Empty, ErrorBox, PageHeader, Spinner } from '../components/ui';

/**
 * Backs the "Pending Yesterday Uploads" dashboard card. Reuses the same
 * /dashboard endpoint and compliance array the dashboard's Upload Status table
 * already renders, filtered to Pending, so this is guaranteed to show the same
 * rigs the card counted rather than a second, independently-derived list.
 */
export default function UploadsPending() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<DashboardData>('/dashboard')
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Spinner label="Reading upload status..." />;

  const pending = data.compliance.filter((c) => c.status === 'Pending');

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-rig-700 hover:underline mb-3">
        <ArrowLeft size={14} /> Dashboard
      </Link>

      <PageHeader
        title="Pending Yesterday Uploads"
        subtitle={`${count(pending.length)} rig(s) with no data for ${date(data.complianceDate)} yet.`}
      />

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Rig</th>
              <th>Status</th>
              <th>Last Upload Date</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((c) => (
              <tr key={c.rigId}>
                <td>
                  <div className="font-medium text-slate-800">{c.rigName}</div>
                  <div className="text-[11px] text-slate-500">{c.rigNumber}</div>
                </td>
                <td>
                  <span className={statusClass(c.status)}>{c.status}</span>
                  {c.holidayDescription && (
                    <div className="text-[11px] text-slate-500 mt-0.5">{c.holidayDescription}</div>
                  )}
                </td>
                <td className="whitespace-nowrap">{date(c.lastDataDate)}</td>
              </tr>
            ))}
            {pending.length === 0 && (
              <tr><td colSpan={3}><Empty message="Every rig has reported for this date." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
