import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { NotificationSettings } from '../../lib/types';
import { ErrorBox, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

const TYPE_LABELS: Record<string, string> = {
  RIG_SHEET_PENDING: 'Rig Sheet Upload Pending',
  EQUIPMENT_HEALTH_CHECKUP_PENDING: 'Health Check Overdue (PMS users)',
  DRR_PENDING_APPROVAL: 'DRR Pending Approval (Operational Manager)',
  DRR_APPROVAL_ESCALATION: 'DRR Approval Escalation (Admin)',
  DRR_APPROVED: 'DRR Approved (Storekeeper)',
  DRR_REJECTED: 'DRR Rejected (Storekeeper)',
  SERVICE_DUE_SOON: 'Service Due Soon (PMS users)',
  SERVICE_OVERDUE: 'Service Overdue (PMS users)',
  SERVICE_OVERDUE_ESCALATION: 'Service Overdue Escalation (Admin)',
  HEALTH_CHECK_DUE_SOON: 'Health Check Due Soon (PMS users)',
  HEALTH_CHECK_OVERDUE_ESCALATION: 'Health Check Overdue Escalation (Admin)',
};

const THRESHOLD_LABEL: Record<string, { warning?: string; critical?: string; escalation?: string }> = {
  SERVICE_DUE_SOON: { warning: 'Warning threshold (hours remaining)' },
  SERVICE_OVERDUE: { critical: 'Critical threshold (hours remaining, normally 0)' },
  SERVICE_OVERDUE_ESCALATION: { escalation: 'Escalate to Admin after (hours overdue)' },
  HEALTH_CHECK_DUE_SOON: { warning: 'Warning threshold (days before due)' },
  HEALTH_CHECK_OVERDUE_ESCALATION: { escalation: 'Escalate to Admin after (days overdue)' },
  DRR_PENDING_APPROVAL: { escalation: undefined },
  DRR_APPROVAL_ESCALATION: { escalation: 'Escalate to Admin after (hours pending)' },
};

/**
 * Admin > Notification Settings (notification brief section 11) — one row
 * per notification type, all reading/writing GET/PUT /api/notifications/settings,
 * the exact settings services/notifications.ts's generators read at run time.
 * Email delivery has no real provider wired up yet (none exists anywhere in
 * this app) — the "Email" checkbox is honest about that in its own hint
 * rather than pretending to send anything.
 */
export default function NotificationSettingsPage() {
  const [items, setItems] = useState<NotificationSettings[] | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();
  const [savingType, setSavingType] = useState<string | null>(null);

  async function load() {
    const data = await api.get<{ settings: NotificationSettings[] }>('/notifications/settings');
    setItems(data.settings);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function save(type: string, patch: Partial<NotificationSettings>) {
    setError('');
    setSavingType(type);
    try {
      await run(async () => {
        await api.put(`/notifications/settings/${type}`, patch);
        await load();
      });
    } catch (e) { setError((e as Error).message); }
    finally { setSavingType(null); }
  }

  if (!items) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Notification Settings"
        subtitle="Per-type thresholds, escalation timing and delivery channels — read live by the notification engine on every scheduled check."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <InfoBox>
        Email delivery has no mail provider configured in this deployment yet — the Email checkbox records the
        intent and is logged server-side, ready for a real provider to be wired in later, but nothing is actually
        sent today. In-app notifications work regardless.
      </InfoBox>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Enabled</th>
              <th>Threshold(s)</th>
              <th>In-App</th>
              <th>Email</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => {
              const thresholds = THRESHOLD_LABEL[s.type] ?? {};
              const saving = savingType === s.type && busy;
              return (
                <tr key={s.type}>
                  <td className="font-medium text-slate-800 text-sm">{TYPE_LABELS[s.type] ?? s.type}</td>
                  <td>
                    <input
                      type="checkbox" checked={s.enabled} disabled={busy}
                      onChange={(e) => void save(s.type, { enabled: e.target.checked })}
                    />
                  </td>
                  <td className="text-xs space-y-1 min-w-[220px]">
                    {thresholds.warning && (
                      <ThresholdField label={thresholds.warning} value={s.warningThreshold} disabled={busy}
                        onSave={(v) => void save(s.type, { warningThreshold: v })} />
                    )}
                    {thresholds.critical && (
                      <ThresholdField label={thresholds.critical} value={s.criticalThreshold} disabled={busy}
                        onSave={(v) => void save(s.type, { criticalThreshold: v })} />
                    )}
                    {thresholds.escalation && (
                      <ThresholdField label={thresholds.escalation} value={s.escalationHours} disabled={busy}
                        onSave={(v) => void save(s.type, { escalationHours: v })} />
                    )}
                    {!thresholds.warning && !thresholds.critical && !thresholds.escalation && (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td>
                    <input
                      type="checkbox" checked={s.inApp} disabled={busy}
                      onChange={(e) => void save(s.type, { inApp: e.target.checked })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox" checked={s.email} disabled={busy}
                      onChange={(e) => void save(s.type, { email: e.target.checked })}
                    />
                  </td>
                  <td className="text-xs text-slate-400">{saving ? 'Saving…' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ThresholdField({ label, value, disabled, onSave }: {
  label: string; value: number | null; disabled: boolean; onSave: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => { setDraft(String(value ?? '')); }, [value]);
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-slate-500 flex-1">{label}</span>
      <input
        className="input py-0.5 px-1.5 w-20 text-right" type="number" disabled={disabled}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { const n = Number(draft); if (Number.isFinite(n) && String(n) !== String(value ?? '')) onSave(n); }}
      />
    </div>
  );
}
