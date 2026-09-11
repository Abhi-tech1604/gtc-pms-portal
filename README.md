# PMS Portal

Preventive Maintenance System for a fleet of drilling and work-over rigs. Rig crews keep a
standardised Excel workbook — the Daily Mechanical Report — and upload it each morning; the portal
ingests it, updates each machine's cumulative running hours, and shows which machines across the
whole fleet are due or overdue.

Built to the Scope of Work dated 20 August 2026.

## Layout

```
pms-portal/
├─ server/                  Node.js + Express + TypeScript API
│  ├─ src/
│  │  ├─ config.ts          Port, paths, timezone, secrets — all from .env
│  │  ├─ db/                SQLite connection, schema.sql, seed
│  │  ├─ excel/             The ingestion engine and the template generator
│  │  │  ├─ normalize.ts    Rig / machine / serial identity rules  (spec 8.1, 8.4)
│  │  │  ├─ parseWorkbook.ts  Steps 1–4: read, identify, locate, group  (8.1–8.4)
│  │  │  ├─ ingest.ts       Steps 5–7: days, register, gates, commit   (8.5–8.7)
│  │  │  └─ template.ts     The Daily Mechanical Report workbook       (section 7)
│  │  ├─ services/          Calculations, compliance, audit, rights
│  │  ├─ routes/            One router per functional module
│  │  └─ middleware/        Auth, permission enforcement, error handling
│  └─ tests/                45 tests, run against real rig workbooks
└─ client/                  React 18 + Vite + Tailwind single-page application
```

## Running it

```bash
cd pms-portal/server && npm install && cp .env.example .env
```

```bash
cd pms-portal/client && npm install && npm run build
```

```bash
cd pms-portal/server && npm start
```

The API and the built client are served from one origin on the configured port (default 4000), so
the portal is reachable across the LAN at `http://<server>:4000`.

For front-end development, run `npm run dev` in `client/` instead; Vite proxies `/api` to port 4000.

### First sign-in

The first start creates one Admin account and the 16-rig fleet. No demo machines, uploads or log
rows are created — every figure in the portal comes from a real workbook.

- Username `admin`, password `ChangeMe123!` — **change it immediately** from the account menu.
- Override the defaults before first start with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

## Tests

```bash
cd pms-portal/server && npm test
```

The fixtures in `server/tests/fixtures/` are real workbooks from rigs 50-02, 50-03, 100-01 and
200-01 — merged cells, a "Opning Running HRS" typo, serial numbers written into the wrong column,
floating-point noise and all. Each test names the acceptance criterion or defect it covers.

## Other commands

| Command | What it does |
| --- | --- |
| `npm run migrate` | Applies and verifies the schema (also done automatically on boot) |
| `npm run seed` | Registers the 16-rig fleet and the Admin account if missing |
| `npm run backup -- 30` | Consistent online backup, pruning copies older than 30 days |
| `npm run reset -- --yes` | Clears all operational data, keeping rigs and users |

## Documents

- [DEPLOYMENT.md](DEPLOYMENT.md) — Windows service installation, updates, backup and restore
- [USER_GUIDE.md](USER_GUIDE.md) — the operational guide for rig crews
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — how each section of the scope, and each defect, is addressed
