import * as XLSX from 'xlsx';
import { rigKey } from './normalize.js';
import { parseCellDate } from '../util/date.js';

/**
 * Reads the "Engine Health Check-up" style workbook: an engineering log, not a
 * per-day form. Two sheets ("Engine Health Check up", "Transmission Health
 * Check up") share one column layout; a third ("Bakrol & Central Store") uses
 * the same nine-column shape but its own header text — column 6 is titled
 * "Problem" there yet its values are dates, and columns 7/8 hold what columns
 * 7/8 hold everywhere else (problem text, then the action taken). The header
 * row on that sheet is simply mislabelled by one column; the DATA lines up
 * positionally with the other two sheets, so this parser trusts position, not
 * header text, and the ninth column is genuinely "Place" there, exactly as
 * the workbook names it (spec: "Column I" is the location).
 */

export interface NarrativeIssue {
  level: 'warning';
  message: string;
}

export interface ParsedNarrativeRow {
  sourceSheet: string;
  category: 'Engine' | 'Transmission';
  rigText: string | null;
  rigKey: string;
  place: string | null;
  application: string | null;
  make: string | null;
  details: string | null;
  model: string | null;
  serialNumber: string | null;
  previousDate: string | null;
  previousDateRaw: string | null;
  lastDate: string | null;
  lastDateRaw: string | null;
  problem: string | null;
  action: string | null;
  outcomeNotes: string | null;
}

export interface ParsedNarrativeWorkbook {
  rows: ParsedNarrativeRow[];
  issues: NarrativeIssue[];
  sheetsFound: string[];
}

interface SheetPlan {
  /** Matched against the workbook's own sheet names, case/space-insensitive. */
  match: RegExp;
  category: 'Engine' | 'Transmission';
  /** Column 9 is a location on the yard/store sheet, engineering notes elsewhere. */
  ninthIsPlace: boolean;
  /** Sheet1/2 use merged cells: a blank Rig cell means "same rig as the row above". */
  carryForwardRig: boolean;
}

const SHEET_PLANS: SheetPlan[] = [
  { match: /transmission/i, category: 'Transmission', ninthIsPlace: false, carryForwardRig: true },
  { match: /engine/i, category: 'Engine', ninthIsPlace: false, carryForwardRig: true },
  { match: /bakrol|central\s*store|yard|store/i, category: 'Engine', ninthIsPlace: true, carryForwardRig: false },
];

export function parseHealthNarrativeWorkbook(buffer: Buffer): ParsedNarrativeWorkbook {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new Error(`The file could not be read as an Excel workbook: ${(err as Error).message}`);
  }

  const rows: ParsedNarrativeRow[] = [];
  const issues: NarrativeIssue[] = [];
  const sheetsFound: string[] = [];

  for (const sheetName of wb.SheetNames) {
    const plan = SHEET_PLANS.find((p) => p.match.test(sheetName));
    if (!plan) {
      issues.push({ level: 'warning', message: `Sheet "${sheetName}" was not recognised and was skipped.` });
      continue;
    }
    sheetsFound.push(sheetName);

    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
      header: 1, raw: false, defval: null,
    });

    // Row 0 is a title banner, row 1 is the header; data starts at row 2.
    let currentRigText: string | null = null;
    for (let i = 2; i < grid.length; i++) {
      const cells = grid[i] ?? [];
      const rigCell = text(cells[0]);
      const application = text(cells[1]);
      const make = text(cells[2]);
      const details = multiline(cells[3]);
      const col5 = text(cells[4]);
      const col6 = text(cells[5]);
      const problem = multiline(cells[6]);
      const action = multiline(cells[7]);
      const col9 = multiline(cells[8]);

      if (plan.carryForwardRig) {
        if (rigCell) currentRigText = rigCell;
      } else {
        currentRigText = rigCell;
      }

      // A fully blank row (no application, no rig, nothing) carries no data.
      if (!application && !currentRigText && !problem && !action && !col9) continue;

      const place = plan.ninthIsPlace ? col9 : null;
      const outcomeNotes = plan.ninthIsPlace ? null : col9;

      rows.push({
        sourceSheet: sheetName,
        category: plan.category,
        rigText: currentRigText,
        rigKey: rigKey(currentRigText),
        place,
        application,
        make,
        details,
        model: extractModel(details),
        serialNumber: extractSerial(details),
        previousDate: parseCellDate(col5),
        previousDateRaw: col5,
        lastDate: parseCellDate(col6),
        lastDateRaw: col6,
        problem,
        action,
        outcomeNotes,
      });
    }
  }

  if (rows.length === 0) {
    issues.push({ level: 'warning', message: 'No usable rows were found in any recognised sheet.' });
  }

  const unmatchedRigs = new Set(
    rows.filter((r) => r.rigText && !r.rigKey).map((r) => r.rigText as string),
  );
  for (const rig of unmatchedRigs) {
    issues.push({ level: 'warning', message: `"${rig}" could not be read as a rig number and was kept as text only.` });
  }

  return { rows, issues, sheetsFound };
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[ \t]+/g, ' ').trim();
  return s === '' ? null : s;
}

/** Preserves the crew's numbered-list line breaks; only trims and de-noises. */
function multiline(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return s === '' ? null : s;
}

/**
 * Best-effort extraction from the free-text Details block. Used both for
 * display and, in routes/healthNarratives.ts, to match against — and if
 * unmatched, to seed — a registered machine, exactly as the mechanical log's
 * own serial-then-name rule does.
 */
function extractSerial(details: string | null): string | null {
  if (!details) return null;
  const m = details.match(/sr\.?\s*no\.?\s*:?\s*([A-Za-z0-9/\-.]+)/i);
  return m ? m[1].trim() : null;
}

function extractModel(details: string | null): string | null {
  if (!details) return null;
  const m = details.match(/model\s*:?\s*([^\n]+)/i);
  return m ? m[1].trim() : null;
}
