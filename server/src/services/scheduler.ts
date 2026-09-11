import cron from 'node-cron';
import { config } from '../config.js';
import { runDailyNotificationChecks } from './notifications.js';

/**
 * Runs hourly, in the business timezone from config (Asia/Kolkata by default,
 * overridable via TIMEZONE — never server-local or UTC time).
 *
 * This used to run once a day at 12:00; it moved to hourly so the time-
 * sensitive checks added alongside DRR approval escalation and service/
 * health-check warnings — a 24-hour escalation, an hours-remaining threshold
 * that changes as a machine runs — reflect within about an hour of crossing
 * their threshold, not up to a day late. The calendar-based checks (rig sheet
 * pending, health-check overdue) are unaffected by running more often: they
 * are keyed to a specific date, not "how many times has this run today."
 *
 * There is no job queue or worker process in this deployment, so the schedule
 * lives in the same Node process as the API server: a small, well-understood
 * tradeoff for a single-instance system, and consistent with how backups and
 * the seed step already run as plain in-process scripts here.
 *
 * Every generator this calls is idempotent (services/notifications.ts) via
 * its dedupe key + unique index, so running it more than once for the same
 * requirement — a restart, a delayed tick, the manual admin-triggered
 * endpoint — can never create a duplicate notification. That is what makes
 * the two safety nets below safe to have:
 *
 *  1. A catch-up run at startup, in case the process was down and so missed
 *     one or more ticks entirely.
 *  2. The cron job itself, on the hour, every hour.
 */
export function startNotificationScheduler(): void {
  try {
    const summary = runDailyNotificationChecks();
    logSummary('startup catch-up', summary);
  } catch (err) {
    console.error('[scheduler] startup catch-up run failed:', err);
  }

  cron.schedule('0 * * * *', () => {
    try {
      const summary = runDailyNotificationChecks();
      logSummary('hourly check', summary);
    } catch (err) {
      console.error('[scheduler] hourly check failed:', err);
    }
  }, { timezone: config.timezone });

  console.log(`[scheduler] Notification check scheduled hourly (${config.timezone}).`);
}

function logSummary(label: string, summary: Record<string, { created: number }>): void {
  const parts = Object.entries(summary).map(([type, s]) => `${type}=${s.created}`).join(', ');
  console.log(`[scheduler] ${label}: ${parts || 'nothing to check'}`);
}
