import nodemailer from 'nodemailer';
import { db } from '../db/index.js';
import { nowIso } from '../util/date.js';

/**
 * Admin > SMTP Configuration — the single mail provider every outbound email
 * in the app sends through (starting with notification_settings' email
 * channel in services/notifications.ts). One row, id='default', matching the
 * notification_settings singleton-per-key pattern already used in this file's
 * sibling.
 */

export interface SmtpSettings {
  enabled: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  hasPassword: boolean;
  fromEmail: string | null;
  fromName: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface SmtpRow {
  id: string; enabled: number; host: string | null; port: number | null; secure: number;
  username: string | null; password: string | null; fromEmail: string | null; fromName: string | null;
  updatedBy: string | null; updatedAt: string | null;
}

function readRow(): SmtpRow | undefined {
  return db.prepare<[], SmtpRow>("SELECT * FROM smtp_settings WHERE id = 'default'").get();
}

/** Client-facing view — never returns the stored password, only whether one is set. */
export function getSmtpSettings(): SmtpSettings {
  const row = readRow();
  if (!row) {
    return { enabled: false, host: null, port: null, secure: false, username: null, hasPassword: false, fromEmail: null, fromName: null, updatedBy: null, updatedAt: null };
  }
  return {
    enabled: !!row.enabled, host: row.host, port: row.port, secure: !!row.secure,
    username: row.username, hasPassword: !!row.password, fromEmail: row.fromEmail, fromName: row.fromName,
    updatedBy: row.updatedBy, updatedAt: row.updatedAt,
  };
}

export interface SmtpUpdateInput {
  enabled: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  password?: string;    // omitted or '' => keep the existing stored password
  fromEmail: string | null;
  fromName: string | null;
}

export function updateSmtpSettings(input: SmtpUpdateInput, updatedBy: string): SmtpSettings {
  const existing = readRow();
  const password = input.password ? input.password : (existing?.password ?? null);
  db.prepare(`
    INSERT INTO smtp_settings (id, enabled, host, port, secure, username, password, fromEmail, fromName, updatedBy, updatedAt)
    VALUES ('default', @enabled, @host, @port, @secure, @username, @password, @fromEmail, @fromName, @updatedBy, @updatedAt)
    ON CONFLICT (id) DO UPDATE SET
      enabled = excluded.enabled, host = excluded.host, port = excluded.port, secure = excluded.secure,
      username = excluded.username, password = excluded.password, fromEmail = excluded.fromEmail,
      fromName = excluded.fromName, updatedBy = excluded.updatedBy, updatedAt = excluded.updatedAt
  `).run({
    enabled: input.enabled ? 1 : 0,
    host: input.host, port: input.port, secure: input.secure ? 1 : 0,
    username: input.username, password, fromEmail: input.fromEmail, fromName: input.fromName,
    updatedBy, updatedAt: nowIso(),
  });
  return getSmtpSettings();
}

interface TransportConfig {
  host: string; port: number; secure: boolean; username: string | null; password: string | null;
  fromEmail: string; fromName: string | null;
}

function buildTransport(cfg: TransportConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.password ?? undefined } : undefined,
  });
}

export interface SendMailInput { to: string; subject: string; text: string; html?: string }

/**
 * Sends a test email using either the currently SAVED settings, or (when the
 * Admin is testing before hitting Save) an ad-hoc override merged over them —
 * so "Send Test Email" always reflects what's on screen, not what's in the DB.
 * Ignores the `enabled` flag entirely: a test must be able to prove a
 * configuration works before an Admin turns real delivery on.
 */
export async function sendTestEmail(to: string, override?: Partial<SmtpUpdateInput>): Promise<void> {
  const row = readRow();
  const host = override?.host ?? row?.host ?? null;
  const port = override?.port ?? row?.port ?? null;
  const secure = override?.secure ?? !!row?.secure;
  const username = override?.username ?? row?.username ?? null;
  const password = override?.password || row?.password || null;
  const fromEmail = override?.fromEmail ?? row?.fromEmail ?? null;
  const fromName = override?.fromName ?? row?.fromName ?? null;

  if (!host || !port || !fromEmail) {
    throw new Error('Host, port and From Email are required before a test email can be sent.');
  }
  const transport = buildTransport({ host, port, secure, username, password, fromEmail, fromName });
  await transport.sendMail({
    from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    to,
    subject: 'GTC Oilfield Portal — SMTP test email',
    text: 'This is a test email from GTC Oilfield Portal’s Admin > SMTP Configuration. If you received this, outbound email is working.',
  });
}

/**
 * The single choke point every notification type funnels email delivery
 * through (see services/notifications.ts). No-ops quietly — never throws —
 * whenever SMTP isn't configured or is turned off, so a delivery failure
 * never blocks the in-app notification it accompanies.
 */
export async function sendMail(input: SendMailInput): Promise<void> {
  const row = readRow();
  if (!row || !row.enabled || !row.host || !row.port || !row.fromEmail) {
    console.log(`[mailer] SMTP not configured/enabled — logged only: to=${input.to} :: ${input.subject}`);
    return;
  }
  try {
    const transport = buildTransport({
      host: row.host, port: row.port, secure: !!row.secure,
      username: row.username, password: row.password, fromEmail: row.fromEmail, fromName: row.fromName,
    });
    await transport.sendMail({
      from: row.fromName ? `"${row.fromName}" <${row.fromEmail}>` : row.fromEmail,
      to: input.to, subject: input.subject, text: input.text, html: input.html,
    });
  } catch (err) {
    console.error(`[mailer] send failed: to=${input.to} :: ${input.subject}`, err);
  }
}
