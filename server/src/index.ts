import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { loadUser, requireModule } from './middleware/auth.js';
import { errorHandler, wrap } from './middleware/http.js';
import { authRouter } from './routes/auth.js';
import { rigsRouter } from './routes/rigs.js';
import { equipmentRouter } from './routes/equipment.js';
import { logsRouter } from './routes/mechanicalLogs.js';
import { healthRouter } from './routes/health.js';
import { dashboardRouter } from './routes/dashboard.js';
import { reportsRouter } from './routes/reports.js';
import { usersRouter } from './routes/users.js';
import { supportRouter } from './routes/support.js';
import { notificationsRouter } from './routes/notifications.js';
import { healthNarrativesRouter } from './routes/healthNarratives.js';
import { equipmentTransfersRouter } from './routes/equipmentTransfers.js';
import { adminRouter } from './routes/admin.js';
import { departmentsRouter } from './routes/departments.js';
import { oilLubricantsRouter } from './routes/oilLubricants.js';
import { employeesRouter } from './routes/employees.js';
import { manpowerRosterRouter } from './routes/manpowerRoster.js';
import { materialMasterRouter } from './routes/materialMaster.js';
import { equipmentOilLubricantsRouter } from './routes/equipmentOilLubricants.js';
import { demoDataRouter } from './routes/demoData.js';
import { dprRouter } from './routes/dpr.js';
import { hsdRouter } from './routes/hsd.js';
import { drrRouter } from './routes/dailyRigReport.js';
import { drrResponsibilityRouter } from './routes/drrResponsibility.js';
import { drrImportRouter } from './routes/drrImport.js';
import { ilmRouter } from './routes/ilm.js';
import { dprRigsRouter } from './routes/dprRigs.js';
import { ilmRigsRouter } from './routes/ilmRigs.js';
import { ilmContractDurationRouter } from './routes/ilmContractDuration.js';
import { internalFollowupRouter } from './routes/internalFollowup.js';
import { invoiceSettingsRouter } from './routes/invoiceSettings.js';
import { smtpSettingsRouter } from './routes/smtpSettings.js';
import { invoicesRouter } from './routes/invoices.js';
import { ensureSeed } from './db/seed.js';
import { startNotificationScheduler, stopNotificationScheduler } from './services/scheduler.js';
import { healthCheck, shutdown as closePostgres } from './db/postgres.js';

migrate();
ensureSeed();

const app = express();
app.set('trust proxy', true);
app.use(helmet());
app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(loadUser);

/**
 * Liveness + database reachability. Reports the database NAME and round-trip
 * time so an operator can tell a healthy connection from a slow one — never
 * the host, user, password or connection string (see redact() in
 * db/postgres.ts). Returns 503 when the database is unreachable so a monitor
 * or load balancer sees the failure rather than a cheerful 200.
 */
app.get('/api/health', wrap(async (_req, res) => {
  // During the SQLite -> PostgreSQL transition the application still reads
  // SQLite until each module is converted, so health must report on the
  // database actually in use. PostgreSQL is only probed once it is genuinely
  // configured — otherwise a correctly-running SQLite deployment would report
  // itself degraded and page someone for nothing.
  if (!config.postgres.configured) {
    res.json({
      status: 'ok', ok: true, database: 'sqlite',
      timezone: config.timezone, time: new Date().toISOString(),
    });
    return;
  }

  const db = await healthCheck();
  res.status(db.connected ? 200 : 503).json({
    status: db.connected ? 'ok' : 'degraded',
    ok: db.connected,
    database: 'postgresql',
    databaseName: db.database,
    databaseConnected: db.connected,
    databaseResponseMs: db.responseMs,
    ...(db.error ? { databaseError: db.error } : {}),
    timezone: config.timezone,
    time: new Date().toISOString(),
  });
}));

// Brute-force protection on login only (spec 23) — every other endpoint is
// already behind requireAuth, so it isn't a credential-guessing surface.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in a few minutes.' },
});

app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/admin/departments', departmentsRouter);
app.use('/api/admin/oil-lubricants', oilLubricantsRouter);
app.use('/api/employees', requireModule('PMS'), employeesRouter);
app.use('/api/manpower-roster', requireModule('PMS'), manpowerRosterRouter);
app.use('/api/internal-followups', requireModule('FOLLOWUP'), internalFollowupRouter);
app.use('/api/invoice-settings', requireModule('INVOICE'), invoiceSettingsRouter);
app.use('/api/invoices', requireModule('INVOICE'), invoicesRouter);
app.use('/api/admin/demo', demoDataRouter);
app.use('/api/admin/smtp-settings', smtpSettingsRouter);
app.use('/api/admin', adminRouter);

// Every existing PMS endpoint now also requires PMS module access, on top of
// whatever permission flag it already checked — the PMS route files
// themselves are unchanged (spec 16: do not touch PMS business functionality).
app.use('/api/rigs', requireModule('PMS'), rigsRouter);
app.use('/api/equipment', requireModule('PMS'), equipmentRouter);
app.use('/api/material-master', requireModule('PMS'), materialMasterRouter);
app.use('/api/equipment-oil-lubricants', requireModule('PMS'), equipmentOilLubricantsRouter);
app.use('/api/mechanical-logs', requireModule('PMS'), logsRouter);
app.use('/api/healthcheckup', requireModule('PMS'), healthRouter);
app.use('/api/dashboard', requireModule('PMS'), dashboardRouter);
app.use('/api/reports', requireModule('PMS'), reportsRouter);
app.use('/api/notifications', requireModule('PMS'), notificationsRouter);
app.use('/api/health-narratives', requireModule('PMS'), healthNarrativesRouter);
app.use('/api/equipment-transfers', requireModule('PMS'), equipmentTransfersRouter);

app.use('/api/dpr/rigs', requireModule('DPR'), dprRigsRouter);
app.use('/api/dpr', requireModule('DPR'), dprRouter);
// HSD is a second import stream inside the DPR module, so it sits behind the
// same DPR module gate rather than being a module of its own.
app.use('/api/hsd', requireModule('DPR'), hsdRouter);
app.use('/api/ilm/rigs', requireModule('ILM'), ilmRigsRouter);
app.use('/api/ilm/contract-duration-rules', requireModule('ILM'), ilmContractDurationRouter);
app.use('/api/ilm', requireModule('ILM'), ilmRouter);
app.use('/api/drr/rig-responsibility', requireModule('DRR'), drrResponsibilityRouter);
app.use('/api/drr', requireModule('DRR'), drrRouter);
app.use('/api/drr-import', requireModule('DRR'), drrImportRouter);

// supportRouter's own routes (companies, holidays, transfers, documents,
// audit/logins) are bare top-level paths (/api/companies, /api/holidays, ...)
// with no shared prefix, so it has to stay mounted at bare '/api' rather than
// a specific one. It MUST be declared LAST: `app.use('/api', ...)` matches
// every request whose path starts with '/api' — which is all of them — so if
// it ran before the module-specific mounts above, its requireModule('PMS')
// gate would 403 every DPR/ILM/DRR request from an account with DRR-only (or
// DPR/ILM-only) access before those routers ever got a chance to match. Only
// once this is genuinely last does it correctly catch just what nothing more
// specific already handled.
app.use('/api', requireModule('PMS'), supportRouter);

// In production the built client is served from the same origin, so the portal
// is reachable over the LAN on one fixed port.
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`PMS Portal API listening on http://${config.host}:${config.port}`);
  console.log(`Database: ${config.dbFile}`);
  console.log(`Timezone: ${config.timezone}`);
});

startNotificationScheduler();

/**
 * Ordered shutdown: stop accepting new work (scheduler, then HTTP), and only
 * then close the PostgreSQL pool, so no in-flight request loses its
 * connection mid-query. Forced exit after 10s in case a socket refuses to
 * drain.
 */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — closing down.`);

    const force = setTimeout(() => {
      console.error('[shutdown] forced exit after timeout.');
      process.exit(1);
    }, 10_000);
    force.unref();

    stopNotificationScheduler();
    server.close(() => {
      void closePostgres()
        .catch((err) => console.error('[shutdown] closing PostgreSQL pool failed:', (err as Error).message))
        .finally(() => process.exit(0));
    });
  });
}
