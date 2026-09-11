import { Router } from 'express';
import { requireAuth, requirePage } from '../middleware/auth.js';
import { badRequest, wrap } from '../middleware/http.js';
import { audit } from '../services/audit.js';
import { getSmtpSettings, sendTestEmail, updateSmtpSettings } from '../services/mailer.js';

/** Admin > SMTP Configuration: the single mail-provider setup screen every outbound email in the app sends through. */
export const smtpSettingsRouter = Router();

smtpSettingsRouter.get('/', requireAuth, requirePage('ADMIN', 'smtp_settings', 'view'), wrap((_req, res) => {
  res.json({ settings: getSmtpSettings() });
}));

smtpSettingsRouter.put('/', requireAuth, requirePage('ADMIN', 'smtp_settings', 'edit'), wrap((req, res) => {
  const body = req.body ?? {};
  if (body.enabled && (!body.host || !body.port || !body.fromEmail)) {
    throw badRequest('Host, Port and From Email are required before SMTP can be enabled.');
  }
  const settings = updateSmtpSettings({
    enabled: !!body.enabled,
    host: body.host || null,
    port: body.port !== undefined && body.port !== null && body.port !== '' ? Number(body.port) : null,
    secure: !!body.secure,
    username: body.username || null,
    password: typeof body.password === 'string' ? body.password : undefined,
    fromEmail: body.fromEmail || null,
    fromName: body.fromName || null,
  }, req.user!.username);
  audit({ user: req.user!.username, ip: req.clientIp, action: 'smtpSettings.update', entity: 'smtp_settings', entityId: 'default', newValue: { ...settings } });
  res.json({ settings });
}));

smtpSettingsRouter.post('/test', requireAuth, requirePage('ADMIN', 'smtp_settings', 'edit'), wrap(async (req, res) => {
  const body = req.body ?? {};
  if (!body.to) throw badRequest('A recipient email address is required.');
  try {
    await sendTestEmail(body.to, {
      host: body.host || undefined,
      port: body.port !== undefined && body.port !== null && body.port !== '' ? Number(body.port) : undefined,
      secure: body.secure,
      username: body.username || undefined,
      password: typeof body.password === 'string' && body.password ? body.password : undefined,
      fromEmail: body.fromEmail || undefined,
      fromName: body.fromName || undefined,
    });
  } catch (err) {
    throw badRequest((err as Error).message || 'Could not send the test email — check the SMTP details.');
  }
  audit({ user: req.user!.username, ip: req.clientIp, action: 'smtpSettings.test', entity: 'smtp_settings', entityId: 'default', newValue: { to: body.to } });
  res.json({ ok: true });
}));
