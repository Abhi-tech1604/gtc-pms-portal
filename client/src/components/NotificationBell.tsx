import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, CircleCheck } from 'lucide-react';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import type { Notification } from '../lib/types';

/**
 * Real-time note: this app has no WebSocket/SSE layer today (plain REST + JWT,
 * no socket server, no per-connection auth). Adding one would be a genuine
 * architectural change. Polling the existing unread-count endpoint needs none
 * of that — it reuses the same authenticated GET every other screen already
 * uses — so a new notification surfaces within one polling interval (60s)
 * without the user refreshing the page, at a fraction of the risk.
 */
const POLL_MS = 60_000;

const TITLE_FALLBACK: Record<string, string> = {
  RIG_SHEET_PENDING: 'Rig Sheet Upload Pending',
  EQUIPMENT_HEALTH_CHECKUP_PENDING: 'Equipment Health Checkup Pending',
  DRR_PENDING_APPROVAL: 'DRR Pending Approval',
  DRR_APPROVAL_ESCALATION: 'DRR Approval Overdue',
  DRR_APPROVED: 'All Good — DRR Submitted',
  DRR_REJECTED: 'DRR Rejected',
  SERVICE_DUE_SOON: 'Service Due Soon',
  SERVICE_OVERDUE: 'Service Overdue',
  SERVICE_OVERDUE_ESCALATION: 'Service Overdue',
  HEALTH_CHECK_DUE_SOON: 'Health Check Due Soon',
  HEALTH_CHECK_OVERDUE_ESCALATION: 'Health Check Overdue',
};

/** Where "click notification -> open the exact record" goes, by type. */
function targetPath(n: Notification): string | null {
  if (n.type.startsWith('DRR_') && n.entityId) return `/drr/reports/${n.entityId}`;
  if ((n.type.startsWith('SERVICE_') || n.type.startsWith('HEALTH_CHECK_')) && n.equipmentId) {
    return `/equipment/${n.equipmentId}`;
  }
  return null;
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[] | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const pollCount = useCallback(async () => {
    try {
      const data = await api.get<{ count: number }>('/notifications/unread-count');
      setUnread(data.count);
    } catch {
      // A transient failure here should never be loud; the next poll retries.
    }
  }, []);

  useEffect(() => {
    void pollCount();
    const id = window.setInterval(() => void pollCount(), POLL_MS);
    return () => window.clearInterval(id);
  }, [pollCount]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  async function loadList() {
    setBusy(true);
    try {
      const data = await api.get<{ notifications: Notification[] }>('/notifications');
      setItems(data.notifications);
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void loadList();
  }

  async function markOne(n: Notification) {
    if (n.isRead) return;
    setItems((prev) => prev?.map((x) => (x.id === n.id ? { ...x, isRead: 1 } : x)) ?? prev);
    setUnread((u) => Math.max(0, u - 1));
    try {
      await api.post(`/notifications/${n.id}/read`);
    } catch {
      void loadList();
      void pollCount();
    }
  }

  /** "Click notification -> open the exact DRR/equipment" — marks read as a side effect, same as before. */
  function openNotification(n: Notification) {
    void markOne(n);
    const path = targetPath(n);
    if (path) { setOpen(false); navigate(path); }
  }

  async function markAll() {
    if (unread === 0) return;
    setItems((prev) => prev?.map((x) => ({ ...x, isRead: 1 })) ?? prev);
    setUnread(0);
    try {
      await api.post('/notifications/read-all');
    } catch {
      void loadList();
      void pollCount();
    }
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        className="relative flex items-center justify-center w-8 h-8 rounded-md text-slate-300 hover:bg-slate-800"
        onClick={toggle}
        aria-label="Notifications"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold leading-4 text-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-80 max-h-[70vh] flex flex-col bg-white rounded-lg shadow-xl border border-slate-200 z-50 text-slate-800">
          <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between">
            <span className="text-sm font-semibold">Notifications</span>
            <button
              className="text-[11px] text-rig-700 hover:underline flex items-center gap-1 disabled:opacity-40 disabled:no-underline"
              onClick={() => void markAll()}
              disabled={unread === 0}
            >
              <CheckCheck size={12} /> Mark all read
            </button>
          </div>

          <div className="overflow-y-auto flex-1">
            {busy && !items && (
              <div className="px-3 py-6 text-center text-xs text-slate-500">Loading...</div>
            )}
            {items && items.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-slate-500">No notifications yet.</div>
            )}
            {items?.map((n) => (
              <button
                key={n.id}
                onClick={() => openNotification(n)}
                className={`w-full text-left px-3 py-2.5 border-b border-slate-100 last:border-0 hover:bg-slate-50 flex gap-2 ${
                  n.isRead ? 'opacity-70' : ''
                }`}
              >
                <span className="pt-1 shrink-0">
                  {n.isRead ? (
                    <span className="block w-2 h-2 rounded-full border border-slate-300" />
                  ) : (
                    <span
                      className={`block w-2 h-2 rounded-full ${
                        n.severity === 'critical' ? 'bg-red-600' : n.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500'
                      }`}
                    />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-slate-800 truncate">
                      {n.title ?? TITLE_FALLBACK[n.type] ?? n.type}
                    </span>
                    {n.resolvedAt && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-700 shrink-0">
                        <CircleCheck size={11} /> Resolved
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-slate-600 mt-0.5">{n.message}</span>
                  <span className="block text-[10px] text-slate-400 mt-1">{dateTime(n.createdAt)}</span>
                </span>
              </button>
            ))}
          </div>

          <button
            className="px-3 py-2 border-t border-slate-200 text-center text-[11px] font-medium text-rig-700 hover:bg-slate-50"
            onClick={() => { setOpen(false); navigate('/notifications'); }}
          >
            View all in Notification Center
          </button>
        </div>
      )}
    </div>
  );
}
