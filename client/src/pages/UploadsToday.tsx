import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download } from 'lucide-react';
import { api, download } from '../lib/api';
import { count, date, dateTime, monthLabel } from '../lib/format';
import type { TodaysUploadsResponse } from '../lib/types';
import { Empty, ErrorBox, PageHeader, Spinner } from '../components/ui';

/**
 * Backs the "Uploads Today" dashboard card. Reads GET /dashboard/uploads-today
 * — the exact same query the dashboard KPI itself is built from (services/
 * todaysActivity.ts) — so this list and the card's count can never drift
 * apart, and it can never show yesterday's rows as today's: both are always
 * computed fresh, for whatever "today" is at request time, respecting this
 * account's own rig scope. Covers BOTH real submission paths this portal
 * has — Excel workbook uploads and DRR daily-entry submissions — not just
 * the Excel ones the old version was limited to.
 */
export default function UploadsToday() {
  const [data, setData] = useState<TodaysUploadsResponse | null>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.get<TodaysUploadsResponse>('/dashboard/uploads-today')
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!data) return <Spinner label="Reading today's uploads..." />;

  const total = data.excelUploads.length + data.drrSubmissions.length;

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-rig-700 hover:underline mb-3">
        <ArrowLeft size={14} /> Dashboard
      </Link>

      <PageHeader
        title="Uploads Today"
        subtitle={`${count(total)} submission(s) recorded on ${date(data.date)} — ${count(data.excelUploads.length)} workbook upload(s), ${count(data.drrSubmissions.length)} DRR submission(s).`}
      />

      <div className="card overflow-x-auto mb-5">
        <div className="card-header"><h2 className="card-title">Excel Workbook Uploads</h2></div>
        <table className="table">
          <thead>
            <tr>
              <th>File name</th><th>Rig</th><th>Log month</th><th>Data through</th>
              <th>Uploaded</th><th>By</th><th className="text-right">Rows</th><th />
            </tr>
          </thead>
          <tbody>
            {data.excelUploads.map((u) => (
              <tr
                key={u.id}
                className={u.coverageEndDate ? 'cursor-pointer' : ''}
                onClick={u.coverageEndDate ? () => navigate(`/uploads/${u.rigId}/${u.coverageEndDate}`) : undefined}
                title={u.coverageEndDate ? 'Open the uploaded data for this rig and date' : undefined}
              >
                <td className="max-w-[260px] truncate" title={u.fileName}>{u.fileName}</td>
                <td className="whitespace-nowrap">{u.rigNumber}</td>
                <td className="whitespace-nowrap">{monthLabel(u.logMonth)}</td>
                <td className="whitespace-nowrap">{date(u.coverageEndDate)}</td>
                <td className="whitespace-nowrap text-xs">{dateTime(u.uploadDate)}</td>
                <td className="text-xs">{u.uploadedBy}</td>
                <td className="num">{count(u.recordsImported)}</td>
                <td className="whitespace-nowrap text-right">
                  {u.storedFileName && (
                    <button
                      className="btn-ghost btn-sm"
                      onClick={(e) => { e.stopPropagation(); void download(`/mechanical-logs/uploads/${u.id}/file`, u.fileName); }}
                    >
                      <Download size={12} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data.excelUploads.length === 0 && (
              <tr><td colSpan={8}><Empty message="No workbooks have been uploaded today yet." /></td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card overflow-x-auto">
        <div className="card-header"><h2 className="card-title">DRR Submissions</h2></div>
        <table className="table">
          <thead>
            <tr>
              <th>Rig</th><th>Report Date</th><th>Shift</th><th>Status</th><th>Submitted By</th><th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {data.drrSubmissions.map((d) => (
              <tr key={d.id} className="cursor-pointer" onClick={() => navigate(`/drr/reports/${d.id}`)} title="Open this Daily Rig Report">
                <td className="whitespace-nowrap">{d.rigName || d.rigNumber}</td>
                <td className="whitespace-nowrap">{date(d.reportDate)}</td>
                <td>{d.shift}</td>
                <td><span className="pill-normal">{d.status}</span></td>
                <td className="text-xs">{d.submittedBy}</td>
                <td className="whitespace-nowrap text-xs">{dateTime(d.updatedAt)}</td>
              </tr>
            ))}
            {data.drrSubmissions.length === 0 && (
              <tr><td colSpan={6}><Empty message="No DRR has been submitted today yet." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
