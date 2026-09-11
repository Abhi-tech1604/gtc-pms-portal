import { useEffect, useState } from 'react';
import { rigLabel } from '../lib/rig';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';
import { count, date, dateTime, hours } from '../lib/format';
import type { Rig, Upload } from '../lib/types';
import { Empty, ErrorBox, PageHeader, Spinner } from '../components/ui';

/**
 * Reached from the Upload Status table (an "Uploaded" row) and from Uploads
 * Today. Shows the actual log rows for one rig on one covered date, using the
 * same GET /mechanical-logs/rows?rigId=&date= endpoint the "Log data" tab of
 * Mechanical Logs already uses — no separate data model for uploaded data.
 */
export default function UploadDetail() {
  const { rigId, uploadDate } = useParams<{ rigId: string; uploadDate: string }>();
  const [rig, setRig] = useState<Rig | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!rigId || !uploadDate) return;
    setRows(null);
    Promise.all([
      api.get<{ rig: Rig }>(`/rigs/${rigId}`),
      api.get<{ rows: Record<string, unknown>[] }>(`/mechanical-logs/rows?rigId=${rigId}&date=${uploadDate}`),
      api.get<{ uploads: Upload[] }>(`/mechanical-logs/uploads?rigId=${rigId}`),
    ])
      .then(([rigData, rowsData, uploadsData]) => {
        setRig(rigData.rig);
        setRows(rowsData.rows);
        // The upload whose coverage span includes this date carries the file
        // and submission details shown in the summary above the table.
        const match = uploadsData.uploads.find(
          (u) => u.coverageStartDate && u.coverageEndDate
            && u.coverageStartDate <= uploadDate && uploadDate <= u.coverageEndDate,
        );
        setUpload(match ?? null);
      })
      .catch((err) => setError((err as Error).message));
  }, [rigId, uploadDate]);

  if (error) return <ErrorBox message={error} />;
  if (!rows) return <Spinner label="Reading the uploaded data..." />;

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-rig-700 hover:underline mb-3">
        <ArrowLeft size={14} /> Dashboard
      </Link>

      <PageHeader
        title="Upload Details"
        subtitle={
          <>
            Rig: <span className="font-medium text-slate-700">{rig ? rigLabel(rig) : rigId}</span>
            {' · '}Upload Date: <span className="font-medium text-slate-700">{date(uploadDate)}</span>
          </>
        }
      />

      {upload && (
        <div className="card p-3 mb-4 text-sm text-slate-600 flex flex-wrap gap-x-6 gap-y-1">
          <span>File: <span className="font-medium text-slate-800">{upload.fileName}</span></span>
          <span>Uploaded by: <span className="font-medium text-slate-800">{upload.uploadedBy}</span></span>
          <span>Uploaded on: <span className="font-medium text-slate-800">{dateTime(upload.uploadDate)}</span></span>
          <span>Machines reported on {date(uploadDate)}: <span className="font-medium text-slate-800">{count(rows.length)}</span></span>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Machine</th><th>Serial</th><th>In use</th>
              <th className="text-right">Day</th><th className="text-right">Night</th>
              <th>Lube psi</th><th className="text-right">Oil added</th>
              <th className="text-right">Opening</th><th className="text-right">Total</th>
              <th className="text-right">Closing</th><th className="text-right">Last service</th>
              <th className="text-right">Since</th><th className="text-right">Interval</th>
              <th className="text-right">Remaining</th><th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="font-medium">{String(r.equipmentName)}</td>
                <td className="text-xs">{(r.serialNumber as string) ?? '-'}</td>
                <td>{(r.isInUse as string) ?? '-'}</td>
                <td className="num">{hours(r.hoursRunDay as number)}</td>
                <td className="num">{hours(r.hoursRunNight as number)}</td>
                <td className="text-xs">{(r.lubeOilPressure as string) ?? '-'}</td>
                <td className="num">{hours(r.lubeOilAdded as number)}</td>
                <td className="num">{hours(r.openingRunningHours as number)}</td>
                <td className="num">{hours(r.totalRunHours as number)}</td>
                <td className="num">{hours(r.closingHours as number)}</td>
                <td className="num">{hours(r.lastServiceHours as number)}</td>
                <td className="num">{hours(r.runningHoursAfterLastService as number)}</td>
                <td className="num">{hours(r.defineHours as number)}</td>
                <td className="num">{hours(r.hoursRemainingForNextService as number)}</td>
                <td className="text-xs max-w-[200px] truncate">{(r.remarks as string) ?? '-'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={15}><Empty message="No log rows are recorded for this rig on this date." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
