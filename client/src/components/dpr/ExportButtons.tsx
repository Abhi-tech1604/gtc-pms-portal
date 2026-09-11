import { FileSpreadsheet, FileText } from 'lucide-react';
import { download } from '../../lib/api';
import { useBusy } from '../ui';

export default function ExportButtons({ queryString }: { queryString: string }) {
  const [busy, run] = useBusy();

  return (
    <div className="flex gap-2">
      <button
        className="btn-ghost" disabled={busy}
        onClick={() => void run(() => download(`/dpr/dashboard/export.xlsx${queryString}`, 'dpr-dashboard.xlsx'))}
      >
        <FileSpreadsheet size={14} /> Export Excel
      </button>
      <button
        className="btn-ghost" disabled={busy}
        onClick={() => void run(() => download(`/dpr/dashboard/export.pdf${queryString}`, 'dpr-dashboard.pdf'))}
      >
        <FileText size={14} /> Export PDF
      </button>
    </div>
  );
}
