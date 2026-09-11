import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, transact } from '../src/db/index.js';
import { newId } from '../src/util/id.js';
import { nowIso } from '../src/util/date.js';
import { rigKey } from '../src/excel/normalize.js';
import { saveDprReport, withRigMatchCheck } from '../src/routes/dpr.js';
import { getDprReport, listDprReports } from '../src/services/dprView.js';
import type { ParsedDprLine } from '../src/excel/dprIngest.js';
import { FLEET } from '../src/db/seed.js';

/**
 * DPR reports are saved through the same saveDprReport() function whether the
 * caller is a manual entry or a committed Excel import — this is what makes
 * "both sources share one data model" (spec 2/12) an actual property of the
 * code, not just a promise.
 */

const ctx = { user: 'tester', ip: '127.0.0.1' };

function reset(): void {
  transact(() => {
    for (const table of ['dpr_line_items', 'dpr_reports', 'dpr_import_batches', 'dpr_rigs']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const rigNumber of FLEET) {
      db.prepare(`
        INSERT INTO dpr_rigs (id, name, rigNumber, rigKey, status, createdAt)
        VALUES (?, ?, ?, ?, 'Active', ?)
      `).run(newId('dprrig'), rigNumber.replace(/^GTC\s*/i, 'Rig '), rigNumber, rigKey(rigNumber), nowIso());
    }
  });
}

function rig(rigNumber: string): { id: string; rigNumber: string } {
  return db.prepare<[string], { id: string; rigNumber: string }>(
    'SELECT id, rigNumber FROM dpr_rigs WHERE rigNumber = ?',
  ).get(rigNumber)!;
}

function line(opts: Partial<ParsedDprLine> = {}): ParsedDprLine {
  return {
    lineNo: 1, wellName: 'WELL-A', operationCode: '02 - Drilling', workType: 'R1',
    startTime: '06:00', endTime: '12:00', totalHours: 6,
    description: null, breakdownEquipment: null, breakdownReason: null,
    drillingSection: null, drillingFrom: null, drillingTo: null, drillingTotal: null,
    casingSection: null, casingFrom: null, casingTo: null, casingTotal: null,
    ...opts,
  };
}

before(reset);
// dpr_reports.rigId is ON DELETE RESTRICT against dpr_rigs (DPR's own
// independent Rig Master, not PMS's) — so any row this file leaves behind
// would block a *different* test file's own reset() from deleting dpr_rigs.
// Leave the table empty when done.
after(reset);

test('a manual entry and an Excel import for the same rig both land in the one DPR data model', () => {
  reset();
  const target = rig('GTC 50-01');

  const manualId = saveDprReport({
    existingReportId: null, rigId: target.id, dprDate: '2026-08-20', source: 'manual',
    importBatchId: null, lines: [line({ wellName: 'WELL-MANUAL' })], ctx,
  });
  const excelId = saveDprReport({
    existingReportId: null, rigId: target.id, dprDate: '2026-08-21', source: 'excel',
    importBatchId: null, lines: [line({ wellName: 'WELL-EXCEL' })], ctx,
  });

  const list = listDprReports({ rigId: target.id });
  assert.equal(list.length, 2, 'both sources show up together');
  const sources = list.map((r) => r.source).sort();
  assert.deepEqual(sources, ['excel', 'manual']);

  const manual = getDprReport(manualId)!;
  const excel = getDprReport(excelId)!;
  assert.equal(manual.lines[0].wellName, 'WELL-MANUAL');
  assert.equal(excel.lines[0].wellName, 'WELL-EXCEL');
  // Same shape either way — nothing downstream can special-case the source.
  assert.deepEqual(Object.keys(manual.lines[0]).sort(), Object.keys(excel.lines[0]).sort());
});

test('re-saving the same rig+date replaces the report rather than creating a second one', () => {
  reset();
  const target = rig('GTC 50-02');

  const firstId = saveDprReport({
    existingReportId: null, rigId: target.id, dprDate: '2026-08-20', source: 'manual',
    importBatchId: null, lines: [line({ wellName: 'FIRST-VERSION' })], ctx,
  });

  const existing = db.prepare<[string, string], { id: string }>(
    'SELECT id FROM dpr_reports WHERE rigId = ? AND dprDate = ?',
  ).get(target.id, '2026-08-20');
  assert.equal(existing!.id, firstId);

  const secondId = saveDprReport({
    existingReportId: existing!.id, rigId: target.id, dprDate: '2026-08-20', source: 'manual',
    importBatchId: null, lines: [line({ wellName: 'REPLACED-VERSION' })], ctx, isUpdate: true,
  });

  assert.equal(secondId, firstId, 'the same report row is reused, not duplicated');
  const count = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM dpr_reports').get()!.n;
  assert.equal(count, 1, 'exactly one report exists for this rig+date');
  const report = getDprReport(firstId)!;
  assert.equal(report.lines.length, 1);
  assert.equal(report.lines[0].wellName, 'REPLACED-VERSION', 'the old line items were replaced, not appended');
});

test('a database-level constraint blocks two reports for the same rig+date, not only the application check', () => {
  reset();
  const target = rig('GTC 50-03');
  saveDprReport({
    existingReportId: null, rigId: target.id, dprDate: '2026-08-20', source: 'manual',
    importBatchId: null, lines: [line()], ctx,
  });

  assert.throws(() => {
    db.prepare(`
      INSERT INTO dpr_reports (id, rigId, dprDate, source, createdBy, createdAt, updatedAt)
      VALUES (?, ?, ?, 'manual', 'x', ?, ?)
    `).run(newId('dpr'), target.id, '2026-08-20', nowIso(), nowIso());
  }, /UNIQUE constraint/);
});

test('deleting a report cascades its line items', () => {
  reset();
  const target = rig('GTC 100-01');
  const reportId = saveDprReport({
    existingReportId: null, rigId: target.id, dprDate: '2026-08-20', source: 'manual',
    importBatchId: null, lines: [line(), line({ lineNo: 2, wellName: 'WELL-B' })], ctx,
  });
  assert.equal(
    db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dpr_line_items WHERE reportId = ?').get(reportId)!.n,
    2,
  );

  db.prepare('DELETE FROM dpr_reports WHERE id = ?').run(reportId);
  assert.equal(
    db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM dpr_line_items WHERE reportId = ?').get(reportId)!.n,
    0,
  );
});

test('totalHours on the report view is the sum of its line items, recomputed, not trusted from any source file', () => {
  reset();
  const target = rig('GTC 100-02');
  const reportId = saveDprReport({
    existingReportId: null, rigId: target.id, dprDate: '2026-08-20', source: 'excel',
    importBatchId: null,
    lines: [line({ totalHours: 6 }), line({ lineNo: 2, totalHours: 4.25 })],
    ctx,
  });
  const report = getDprReport(reportId)!;
  assert.equal(report.totalHours, 10.25);
  assert.equal(report.lineCount, 2);
});

test('the well filter on listDprReports matches a report by any of its line items\' well name', () => {
  reset();
  const target = rig('GTC 100-03');
  saveDprReport({
    existingReportId: null, rigId: target.id, dprDate: '2026-08-20', source: 'manual',
    importBatchId: null, lines: [line({ wellName: 'ALPHA' })], ctx,
  });
  saveDprReport({
    existingReportId: null, rigId: target.id, dprDate: '2026-08-21', source: 'manual',
    importBatchId: null, lines: [line({ wellName: 'BETA' })], ctx,
  });

  const alphaOnly = listDprReports({ well: 'ALPHA' });
  assert.equal(alphaOnly.length, 1);
  assert.equal(alphaOnly[0].dprDate, '2026-08-20');
});

/**
 * A rig's history reuses audit_logs as-is (GET /dpr/rig-history/:rigId) —
 * every saveDprReport() call already writes a dpr.create/dpr.update row, so
 * this locks in that the join-through-dpr_reports query finds exactly the
 * rows for one rig, none from another, ordered newest first.
 */
test('a rig\'s audit history is every audit_logs row for its own reports, and none from another rig\'s', () => {
  reset();
  const alpha = rig('GTC 100-04');
  const beta = rig('GTC 100-07');

  const reportId = saveDprReport({
    existingReportId: null, rigId: alpha.id, dprDate: '2026-08-20', source: 'manual',
    importBatchId: null, lines: [line()], ctx,
  });
  saveDprReport({
    existingReportId: reportId, rigId: alpha.id, dprDate: '2026-08-20', source: 'manual',
    importBatchId: null, lines: [line({ wellName: 'WELL-B' })], ctx, isUpdate: true,
  });
  saveDprReport({
    existingReportId: null, rigId: beta.id, dprDate: '2026-08-20', source: 'manual',
    importBatchId: null, lines: [line()], ctx,
  });

  const entries = db.prepare(`
    SELECT a.id, a.user, a.time, a.action, a.entityId, a.detail
    FROM audit_logs a
    WHERE a.entity = 'dpr_reports' AND a.entityId IN (SELECT id FROM dpr_reports WHERE rigId = ?)
    ORDER BY a.time DESC
  `).all(alpha.id) as { action: string; entityId: string }[];

  assert.equal(entries.length, 2, 'create + update for alpha\'s one report, nothing from beta');
  assert.ok(entries.every((e) => e.entityId === reportId));
  assert.deepEqual(entries.map((e) => e.action).sort(), ['dpr.create', 'dpr.update']);
});

/**
 * Regression: withRigMatchCheck must return the mismatch issue in the array
 * it hands back — an earlier version pushed it onto a local copy while the
 * caller kept serving the original array, so the exact spec-worded message
 * never reached the response even though the import was still (correctly)
 * rejected. This locks that response body, not just the reject/accept
 * decision, in place.
 */
test('withRigMatchCheck returns the exact spec-worded message when the file names a different rig', () => {
  const issues = withRigMatchCheck(
    { rigKeyInFile: '50-1', rigTextInFile: 'GTC 50-01', issues: [] },
    { rigNumber: 'GTC 200-01', rigKey: '200-1' },
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'fatal');
  assert.equal(issues[0].message, 'Incorrect Rig Template. This file belongs to GTC 50-01 but GTC 200-01 was selected.');
});

test('withRigMatchCheck adds nothing when the file\'s rig matches the one selected', () => {
  const issues = withRigMatchCheck(
    { rigKeyInFile: '200-1', rigTextInFile: 'GTC 200-01', issues: [] },
    { rigNumber: 'GTC 200-01', rigKey: '200-1' },
  );
  assert.deepEqual(issues, []);
});

test('withRigMatchCheck does not check the rig when the file already has a fatal issue (avoids a misleading second error)', () => {
  const original = [{ level: 'fatal' as const, message: 'No activity rows were found.' }];
  const issues = withRigMatchCheck(
    { rigKeyInFile: '50-1', rigTextInFile: 'GTC 50-01', issues: original },
    { rigNumber: 'GTC 200-01', rigKey: '200-1' },
  );
  assert.deepEqual(issues, original);
});
