import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCheck, CircleCheck } from 'lucide-react';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import type { Notification } from '../lib/types';
import { Empty, ErrorBox, Field, PageHeader, Spinner, useBusy } from '../components/ui';

/**
 * The one common Notification Center for the whole app (notification brief
 * section 4) — every category (DRR approval/rejection/escalation, Service
 * Due/Overdue, Health Check Due/Overdue, ...) is just a `type` value on the
 * SAME notifications table/endpoint the sidebar bell already reads; this page
 * is a fuller view over identical data; a filter, not a second system.
 */
const TYPE_LABELS: Record<string, string> = {
  RIG_SHEET_PENDING: 'Rig Sheet Upload Pending',
  EQUIPMENT_HEALTH_CHECKUP_PENDING: 'Health Check Overdue',
  DRR_PENDING_APPROVAL: 'DRR Approval',
  DRR_APPROVAL_ESCALATION: 'DRR Escalation',
  DRR_APPROVED: 'DRR Approval',
  DRR_REJECTED: 'DRR Rejection',
  SERVICE_DUE_SOON: 'Service Due',
  SERVICE_OVERDUE: 'Service Overdue',
  SERVICE_OVERDUE_ESCALATION: 'Service Overdue',
  HEALTH_CHECK_DUE_SOON: 'Health Check Due',
  HEALTH_CHECK_OVERDUE_ESCALATION: 'Health Check Overdue',
};

function targetPath(n: Notification): string | null {
  if (n.type.startsWith('DRR_') && n.entityId) return `/drr/reports/${n.entityId}`;
  if ((n.type.startsWith('SERVICE_') || n.type.startsWith('HEALTH_CHECK_') || n.type === 'EQUIPMENT_HEALTH_CHECKUP_PENDING') && n.equipmentId) {
    return `/equipment/${n.equipmentId}`;
  }
  return null;
}

export default function Notifications() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState('');
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState<'' | 'unread' | 'open' | 'resolved'>('');
  const [busy, run] = useBusy();

  async function load() {
    const data = await api.get<{ notifications: Notification[] }>('/notifications');
    setItems(data.notifications);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  const filtered = (items ?? []).filter((n) => {
    if (severity && n.severity !== severity) return false;
    if (status === 'unread' && n.isRead) return false;
    if (status === 'open' && n.resolvedAt) return false;
    if (status === 'resolved' && !n.resolvedAt) return false;
    return true;
  });

  async function markAll() {
    try {
      await run(async () => { await api.post('/notifications/read-all'); await load(); });
    } catch (e) { setError((e as Error).message); }
  }

  async function open(n: Notification) {
    if (!n.isRead) {
      try { await api.post(`/notifications/${n.id}/read`); await load(); } catch { /* non-fatal */ }
    }
    const path = targetPath(n);
    if (path) navigate(path);
  }

  if (!items) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Notification Center"
        subtitle="Every DRR approval, service and health-check alert this account is eligible for — in-app history, kept even after a notification resolves."
        actions={<button className="btn-ghost" onClick={() => void markAll()}><CheckCheck size={14} /> Mark all read</button>}
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card p-3 mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Priority">
          <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All priorities</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </Field>
        <Field label="Status">
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">All</option>
            <option value="unread">Unread</option>
            <option value="open">Open (unresolved)</option>
            <option value="resolved">Resolved</option>
          </select>
        </Field>
      </div>

      <div className="card divide-y divide-slate-100">
        {filtered.length === 0 && <div className="p-6"><Empty message="No notifications match these filters." /></div>}
        {filtered.map((n) => (
          <button
            key={n.id}
            onClick={() => void open(n)}
            className={`w-full text-left px-4 py-3 hover:bg-slate-50 flex gap-3 ${n.isRead ? 'opacity-70' : ''}`}
          >
            <span className="pt-1 shrink-0">
              <span className={`inline-block w-2 h-2 rounded-full ${
                n.severity === 'critical' ? 'bg-red-600' : n.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500'
              }`} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{TYPE_LABELS[n.type] ?? n.type}</span>
                {!n.isRead && <span className="pill-upcoming text-[10px]">New</span>}
                {n.resolvedAt
                  ? <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-700"><CircleCheck size={11} /> Resolved</span>
                  : <span className="text-[10px] text-slate-400">Open</span>}
              </span>
              <span className="block text-sm font-medium text-slate-800 mt-0.5">{n.title ?? n.type}</span>
              <span className="block text-sm text-slate-600 whitespace-pre-line mt-0.5">{n.message}</span>
              <span className="block text-[11px] text-slate-400 mt-1">{n.createdAt ? dateTime(n.createdAt) : ''}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
