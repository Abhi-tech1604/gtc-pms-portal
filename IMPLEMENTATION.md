# Implementation Notes

How the build maps onto the Scope of Work, where the interesting decisions were made, and what a
reviewer should check first.

---

## The ingestion engine

Everything else in the portal is conventional CRUD. Three files carry the complexity:

| File | Scope section | Responsibility |
| --- | --- | --- |
| `server/src/excel/normalize.ts` | 8.1, 8.4 | Rig, machine and serial identity |
| `server/src/excel/parseWorkbook.ts` | 8.1 – 8.4 | Read the file, identify the rig, locate the data, decide which rows are real, group into machines. Touches no database. |
| `server/src/excel/ingest.ts` | 8.5 – 8.7 | Walk the days, match to the register, raise the confirmation gates, and commit the whole plan in one transaction. |

The split matters: `planIngestion` reads but never writes, so the preview the user approves is
exactly the plan that later gets committed by `commitIngestion`.

### Rig key normalisation

The spec's rule collapses `GTC-50-1`, `GTC 50-01`, `RIG-50-01` and `gtc#50#1` to one key. The real
workbooks add a fifth spelling: the crews write `Rig 50-02` in cell B1 while the fleet register holds
`GTC 50-02`. Both a `gtc` and a `rig` leading token are therefore dropped rather than kept, which is
what makes those two match. All 16 fleet rig numbers still produce distinct keys — there is a test
for exactly that, because dropping a prefix is the kind of change that could silently merge two rigs.

### The real-data test (8.3)

Implemented literally, in `isRealRow`:

```
hoursRunDay present OR hoursRunNight present
OR ((opening OR closing present) AND lastServiceHours present)
```

A typed zero counts as present; a blank does not. This is the rule the whole system's
trustworthiness rests on, and it is deliberately not "improved" anywhere downstream — see the note
on D7 below.

---

## Defect catalogue (section 10)

| # | Where it is prevented | Covering test |
| --- | --- | --- |
| D1 | `findRigNumber` scans the first eight rows for the label instead of reading a fixed cell | "the rig declaration is read wherever the label sits" |
| D2 | `resolveRig` returns `null` rather than falling back to the form; the import endpoint refuses to commit until `rigResolvedFrom === 'user'` | "an unrecognised rig stops and asks instead of guessing" |
| D3 | `groupRows` discards any machine with no real day | "a workbook nobody filled in produces no machines at all" |
| D4 | `buildRows` only walks days that passed the real-data test; there is no default-shift value anywhere in the codebase | "only the days the crew filled in become log rows" |
| D5 | `latestUpdate` returns the service baseline and interval, and `commitIngestion` writes both back | "the service baseline and interval are carried back to the register" |
| D6 | Column M is the baseline, O the interval, P the hours remaining; column S is passed through a date extractor that can only return a date | "the service baseline never comes from the column S sentence" |
| D7 | `latestUpdate` picks the highest `sheetDay` with no further filter | "the latest entry is the highest day number, idle or not" |
| D8 | `complianceFor` reads `MAX(logDate)` from the ingested rows and filters on no upload status at all | "compliance is judged on the data date, not the upload timestamp" |
| D9 | Both duplicate lookups filter by `rigId`, and every upload row stores its `rigId` as a non-null foreign key | "all rigs can upload the same day with no duplicate warnings" |
| D10 | Replacement deletes one upload by primary key | "re-uploading one rig flags only that rig, and replaces only that upload" |
| D11 | `matchEquipment` is handed only the candidates for one rig | "identically named machines on two rigs stay separate" |
| D12 | `roundHours` at parse time, `Math.round` at storage, `hours()` at display | "nothing stored anywhere carries a decimal" |
| D13 | `writeSection` always emits ten rows per section regardless of how many machines exist | "a rig with no equipment still gets ten fully wired rows per section" |
| D14 | `paintLocked` on B1 and Q1, `setFormula` locks K, L, N, P and J on days 2–31 | "the rig number and the date are locked, crew fields are not" |
| D15 | Every dashboard figure comes from a query; there is no hard-coded array in the client | The dashboard renders empty until a workbook is imported |

---

## Tests

45 tests, run with `npm test` in `server/`. The fixtures are genuine rig workbooks, not synthetic
ones:

| Fixture | What makes it useful |
| --- | --- |
| `rig-50-02-real.xlsx` | Filled on day 18; column S carries "LAST SERVICE DONE @ 25366 HRS. DT- 2026-07-01"; header S reads "LAST SERVICE DONE" rather than "Last Service Date" |
| `rig-100-01-real.xlsx` | Floating-point noise (25403.1, 308.6, 191.4); one machine name appears twice with the same serial; lube oil pressure written as text ("266 KPA") |
| `rig-200-01-real.xlsx` | 19 machines, several logged as not-in-use with typed zeros; a serial column containing the word "YES" |
| `rig-50-03-unfilled.xlsx` | A real seeded template nobody touched — every number in it is formula residue |

Every fixture carries the "Opning Running HRS" typo, merged title cells, and `Rig 50-0x` spellings.

---

## Deliberate decisions worth reviewing

**`lubeOilPressure` is stored as text, not an integer.** Section 4.4 types it as an integer, but the
real workbooks contain `266 KPA`, `3.6 KG/CM2` and `185 PSI`. Coercing those to a number would throw
away the unit and, for `3.6 KG/CM2`, the value itself. It is stored and displayed as written. It is
not used in any calculation, so nothing downstream is affected.

**A machine that has never had a health checkup counts as Overdue.** Section 9.4 defines the status
from `remainingHealthCheckDays`, which is undefined when `lastHealthCheckDate` is null. Treating it
as Normal would hide machines with no inspection record at all, so it is treated as Overdue. On a
fresh import this makes the "Overdue Health Checks" tile equal the machine count until the first
checkups are logged — that is accurate rather than alarming.

**A freshly generated template re-imports as one day-1 row per machine.** The template seeds column J
with the machine's current hours and column M with its service baseline, and under the rule in 8.3 a
meter reading alongside a hand-entered baseline is real data. The row re-imports to exactly the
figures the system already held, so nothing moves; the blank rows the template always emits are
discarded. There is a test asserting precisely this.

**Section 9.5 is referenced but absent from the specification.** Sections 6.2.2 and D8 make the rule
unambiguous — compliance is judged on `logDate` — and that is what `complianceFor` implements.

**Rig deletion cascades only after an explicit second confirmation.** The first attempt returns HTTP
409 with a message naming the exact counts of machines, uploads and log rows that would go; the UI
shows that message and requires a second press.

---

## Security

- Passwords are bcrypt hashed. Nothing in the codebase stores or returns a plaintext password.
- Every endpoint enforces its permission flag server-side via `requireRight`, not only in the UI.
- A rig-scoped user is filtered at the query level, and `assertRigAllowed` rejects any request that
  names another rig — the scope cannot be widened by editing a request.
- Uploads are limited by extension and size and parsed inside a try/catch that turns any parser
  failure into a readable message.
- Every login attempt, successful or not, is recorded with its timestamp and source IP.

## Data integrity

- Every ingestion runs inside one `IMMEDIATE` transaction. There is a test that corrupts a plan
  half-way through and asserts the database is left completely untouched.
- Foreign keys are enforced (`PRAGMA foreign_keys = ON`) between equipment and rigs, log rows and
  equipment, and log rows and uploads.
- Every delete in the codebase targets a primary key or a single scoped identifier. There is no
  broad predicate delete anywhere.
- WAL mode plus a 10-second busy timeout lets 16 rigs upload concurrently without blocking readers.
