# Deployment Guide

Target: Windows Server, run as a service, restarting automatically on failure and on boot,
reachable across the LAN on a fixed port.

---

## 1. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js 20 LTS or newer | `node --version`. The build was verified on Node 24. |
| NSSM | <https://nssm.cc/download>. Unpack `nssm.exe` to `C:\Tools\nssm\`. |
| A service account | A local account with read/write on the install and data folders. |

Nothing else is required. SQLite is embedded; there is no separate database server to install.

## 2. Install

Copy the repository to the server, for example `C:\PMS\pms-portal`, then:

```bat
cd C:\PMS\pms-portal\server && npm ci --omit=dev
```

```bat
cd C:\PMS\pms-portal\client && npm ci && npm run build
```

The server serves `client/dist` automatically when it exists, so one process and one port cover the
whole portal.

## 3. Configure

Copy `server\.env.example` to `server\.env` and edit it. Nothing below is hard-coded in the source.

```ini
PORT=4000
HOST=0.0.0.0
DATA_DIR=D:\PMSData
DB_FILE=D:\PMSData\pms.db
UPLOAD_DIR=D:\PMSData\uploads
BACKUP_DIR=D:\PMSBackups
TIMEZONE=Asia/Kolkata
JWT_SECRET=<a long random string, unique to this installation>
SESSION_HOURS=12
MAX_UPLOAD_MB=25
CORS_ORIGINS=
```

Put `DATA_DIR` on a data volume, not on the system drive, so backups and disk growth are easy to
manage. `JWT_SECRET` signs sessions: changing it signs everyone out, and leaving it at the default
is not acceptable in production.

Set the initial administrator before the very first start:

```bat
set ADMIN_USERNAME=pmsadmin
set ADMIN_PASSWORD=<a strong password>
```

## 4. Open the firewall

```bat
netsh advfirewall firewall add rule name="PMS Portal" dir=in action=allow protocol=TCP localport=4000
```

## 5. Install the Windows service

```bat
C:\Tools\nssm\nssm.exe install PMSPortal "C:\Program Files\nodejs\npm.cmd" "run start"
```

Then set the rest of the parameters:

```bat
C:\Tools\nssm\nssm.exe set PMSPortal AppDirectory C:\PMS\pms-portal\server
```

```bat
C:\Tools\nssm\nssm.exe set PMSPortal AppEnvironmentExtra NODE_ENV=production
```

Setting `NODE_ENV=production` makes the server refuse to start if `JWT_SECRET` in `.env` is still
the placeholder value — a real secret must be set first (see the `.env` table above).

```bat
C:\Tools\nssm\nssm.exe set PMSPortal AppStdout D:\PMSData\logs\service.log
```

```bat
C:\Tools\nssm\nssm.exe set PMSPortal AppStderr D:\PMSData\logs\service-error.log
```

```bat
C:\Tools\nssm\nssm.exe set PMSPortal AppRotateFiles 1
```

```bat
C:\Tools\nssm\nssm.exe set PMSPortal Start SERVICE_AUTO_START
```

```bat
C:\Tools\nssm\nssm.exe set PMSPortal AppExit Default Restart
```

```bat
C:\Tools\nssm\nssm.exe set PMSPortal AppThrottle 5000
```

To run under a dedicated account:

```bat
C:\Tools\nssm\nssm.exe set PMSPortal ObjectName DOMAIN\svc_pms <password>
```

Start it:

```bat
net start PMSPortal
```

Confirm it answers:

```bat
curl http://localhost:4000/api/health
```

Users then reach the portal at `http://<server-name>:4000`.

## 6. Updating

1. Announce a short outage. Uploads in progress are transactional, so nothing is left half-written,
   but an in-flight request will fail.
2. Take a backup first (section 7).
3. Stop the service:

```bat
net stop PMSPortal
```

4. Replace the source (`git pull`, or copy the new folder over the old one, keeping `.env` and the
   data directory untouched).
5. Reinstall dependencies and rebuild the client:

```bat
cd C:\PMS\pms-portal\server && npm ci --omit=dev
```

```bat
cd C:\PMS\pms-portal\client && npm ci && npm run build
```

6. Start the service:

```bat
net start PMSPortal
```

The schema is applied automatically on boot; every statement is `CREATE ... IF NOT EXISTS`, so an
update never disturbs existing data.

7. Verify: sign in, open the dashboard, and confirm the Upload Status panel still shows each rig's
   last data date.

## 7. Backups

### Scheduled backup

`VACUUM INTO` writes a consistent copy while the service keeps running, so no outage is needed.

```bat
cd C:\PMS\pms-portal\server && npm run backup -- 30
```

That writes `pms-YYYY-MM-DD-HHmm.db` into `BACKUP_DIR` and prunes copies older than 30 days.

Schedule it nightly:

```bat
schtasks /create /tn "PMS Portal Backup" /tr "cmd /c cd /d C:\PMS\pms-portal\server && npm run backup -- 30" /sc daily /st 01:30 /ru SYSTEM
```

Also copy `BACKUP_DIR` off the machine — to a file share or offsite target — on the same schedule.
A backup that only exists on the server it protects is not a backup.

The uploaded workbooks themselves live in `UPLOAD_DIR`. Include that folder in the file-level backup
so the "download the originally processed workbook" action keeps working after a restore.

### Restore

1. Stop the service:

```bat
net stop PMSPortal
```

2. Move the current database aside rather than deleting it — if the restore turns out to be from the
   wrong date you will want it back:

```bat
move D:\PMSData\pms.db D:\PMSData\pms.db.before-restore
```

3. Remove the write-ahead log files that belong to the old database:

```bat
del D:\PMSData\pms.db-wal D:\PMSData\pms.db-shm
```

4. Copy the chosen backup into place:

```bat
copy D:\PMSBackups\pms-2026-08-20-0130.db D:\PMSData\pms.db
```

5. Restore `UPLOAD_DIR` from the same night's file backup.
6. Start the service and verify:

```bat
net start PMSPortal
```

Sign in, open **Mechanical Logs → Upload registry**, and confirm the most recent upload matches the
backup's date. Then open the dashboard and check the Upload Status panel.

### Testing the restore

Test the restore path at least once per quarter, on a copy — restore the previous night's backup
into a scratch folder, point a second instance at it with `DB_FILE`, start it on a different port,
and confirm the upload registry and equipment hours are intact. A restore procedure that has never
been run is an assumption, not a procedure.

## 8. Operational notes

- **Logs**: `AppStdout` / `AppStderr` above. Ingestion failures are logged with the file name.
- **Health check**: `GET /api/health` returns `{ ok: true }` with the configured timezone.
- **Timezone**: all date arithmetic uses `TIMEZONE`, not server-local time. Changing it changes what
  "yesterday" means for upload compliance.
- **Disk**: each uploaded workbook is kept so it can be downloaded from the registry later. Budget
  roughly 100 KB per upload — about 600 MB per year across 16 rigs uploading daily.
- **Sessions**: expire after `SESSION_HOURS`. Users are returned to the sign-in screen.
- **Concurrency**: the database runs in WAL mode with a 10-second busy timeout, and each ingestion
  is a single transaction, so 16 rigs uploading at once cannot corrupt each other's data.
