import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { date, statusClass } from '../lib/format';
import type { DashboardData } from '../lib/types';
import { Empty, ErrorBox, PageHeader, Spinner } from '../components/ui';

/**
 * PMS → Status: the fleet's Upload Status board, moved off the PMS Dashboard
 * into its own page. Reads the same /dashboard endpoint the Dashboard page
 * uses (complianceDate + compliance) so the calculation stays identical —
 * only the presentation moved, not the data or the logic behind it.
 */
export default function Status() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [ufRig, setUfRig] = useState('');
  const [ufStatus, setUfStatus] = useState('');
  const [ufDate, setUfDate] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.get<DashboardData>('/dashboard')
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, []);

  const statusOptions = useMemo(
    () => (data ? [...new Set(data.compliance.map((c) => c.status))] : []),
    [data],
  );

  const filteredCompliance = useMemo(() => {
    if (!data) return [];
    const needle = ufRig.trim().toLowerCase();
    return data.compliance.filter((c) =>
      (!needle || c.rigName.toLowerCase().includes(needle) || c.rigNumber.toLowerCase().includes(needle))
      && (!ufStatus || c.status === ufStatus)
      && (!ufDate || c.lastDataDate === ufDate),
    );
  }, [data, ufRig, ufStatus, ufDate]);

  const hasActiveFilters = !!(ufRig || ufStatus || ufDate);
  function clearFilters() { setUfRig(''); setUfStatus(''); setUfDate(''); }

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Spinner label="Reading the fleet's current position..." />;

  return (
    <div>
      <PageHeader
        title="Status"
        subtitle={`Upload status is judged against ${date(data.complianceDate)}.`}
      />

      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Upload Status &mdash; {date(data.complianceDate)}</h2>
          <span className="text-[11px] text-slate-500">
            Judged on the date the data covers, not when the file arrived
          </span>
        </div>

        <div className="px-4 py-2 border-b border-slate-200 flex flex-wrap items-center gap-2">
          <input
            className="input flex-1 min-w-[130px] text-sm"
            placeholder="Search rig, e.g. Rig 100-01"
            value={ufRig}
            onChange={(e) => setUfRig(e.target.value)}
          />
          <select
            className="input w-auto min-w-[110px] text-sm"
            value={ufStatus}
            onChange={(e) => setUfStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            type="date"
            className="input w-auto min-w-[150px] text-sm"
            value={ufDate}
            onChange={(e) => setUfDate(e.target.value)}
          />
          {hasActiveFilters && (
            <button className="btn-ghost btn-sm" onClick={clearFilters}>Clear Filters</button>
          )}
        </div>

        <div className="max-h-[600px] overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Rig</th>
                <th>Status</th>
                <th>Last Upload Date</th>
              </tr>
            </thead>
            <tbody>
              {filteredCompliance.map((c) => {
                const clickable = c.status === 'Uploaded' && !!c.lastDataDate;
                return (
                  <tr
                    key={c.rigId}
                    className={clickable ? 'cursor-pointer' : ''}
                    onClick={clickable ? () => navigate(`/uploads/${c.rigId}/${c.lastDataDate}`) : undefined}
                    title={clickable ? 'Open the uploaded data for this rig and date' : undefined}
                  >
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
                );
              })}
              {filteredCompliance.length === 0 && (
                <tr>
                  <td colSpan={3}>
                    <Empty message={data.compliance.length === 0
                      ? 'No rigs are registered yet.'
                      : 'No rig matches these filters.'} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
