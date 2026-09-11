import * as XLSX from 'xlsx';
import { rigKey } from './normalize.js';

/**
 * Reads a Material Master workbook: `Rig | Application | Make | Details |
 * Status`, where the Rig cell is filled only on the first row of each rig's
 * block (blank/merged for the rest). Both the "Engine Health Check up" and
 * "Transmission Health Check up" sheets are read from the same file in one
 * pass, each tagged with its materialType — this is the real shape of the
 * source workbook (both sheets together), so importing it once from the
 * Material Master tab populates both kinds together.
 */

export interface ParsedMaterialRow {
  sourceSheet: string;
  materialType: 'Engine' | 'Transmission';
  rigText: string | null;
  rigKey: string;
  name: string;
  make: string | null;
  model: string | null;
  serialNumber: string | null;
  status: 'Active' | 'Inactive';
}

export interface ParsedMaterialWorkbook {
  rows: ParsedMaterialRow[];
  sheetsFound: string[];
  warnings: string[];
}

const SHEET_PLANS: { match: RegExp; materialType: 'Engine' | 'Transmission' }[] = [
  { match: /transmission/i, materialType: 'Transmission' },
  { match: /engine/i, materialType: 'Engine' },
];

/**
 * `onlyType`, when given, imports only that sheet's rows — each Master tab's
 * own Import button pulls just its own kind, ignoring the other sheet if
 * it's present in the same uploaded workbook.
 */
export function parseMaterialMasterWorkbook(buffer: Buffer, onlyType?: 'Engine' | 'Transmission'): ParsedMaterialWorkbook {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new Error(`The file could not be read as an Excel workbook: ${(err as Error).message}`);
  }

  const rows: ParsedMaterialRow[] = [];
  const warnings: string[] = [];
  const sheetsFound: string[] = [];

  for (const sheetName of wb.SheetNames) {
    const plan = SHEET_PLANS.find((p) => p.match.test(sheetName));
    if (!plan) continue;
    if (onlyType && plan.materialType !== onlyType) continue;
    sheetsFound.push(sheetName);

    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: false, defval: null });

    // Row 0 is a title banner, row 1 is the header; data starts at row 2.
    let currentRigText: string | null = null;
    for (let i = 2; i < grid.length; i++) {
      const cells = grid[i] ?? [];
      const rigCell = text(cells[0]);
      const name = text(cells[1]);
      const make = text(cells[2]);
      const details = multiline(cells[3]);
      const statusCell = text(cells[4]);

      if (rigCell) currentRigText = rigCell;

      if (!name && !currentRigText && !make && !details) continue;
      if (!name) continue; // no machine named on this row — nothing to import

      rows.push({
        sourceSheet: sheetName,
        materialType: plan.materialType,
        rigText: currentRigText,
        rigKey: rigKey(currentRigText),
        name,
        make,
        model: extractModel(details),
        serialNumber: extractSerial(details),
        status: statusCell?.toLowerCase() === 'inactive' ? 'Inactive' : 'Active',
      });
    }
  }

  if (sheetsFound.length === 0) {
    warnings.push(onlyType ? `No "${onlyType}" sheet was found in this workbook.` : 'No "Engine" or "Transmission" sheet was found in this workbook.');
  }
  if (rows.length === 0 && sheetsFound.length > 0) {
    warnings.push('No usable rows were found in the recognised sheet(s).');
  }

  const unmatchedRigs = new Set(rows.filter((r) => r.rigText && !r.rigKey).map((r) => r.rigText as string));
  for (const rig of unmatchedRigs) {
    warnings.push(`"${rig}" could not be read as a rig number and was skipped.`);
  }

  return { rows, sheetsFound, warnings };
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[ \t]+/g, ' ').trim();
  return s === '' ? null : s;
}

function multiline(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return s === '' ? null : s;
}

/**
 * Best-effort split of the free-text Details block, e.g. "Model : C-9\nSR No : JSC01354".
 * Some rows run Model and SR No together on one physical line with no newline
 * between them ("MODEL : EE694TCI    SR No : E622...") — trim that trailing
 * marker off so it never leaks into the model value.
 */
function extractModel(details: string | null): string | null {
  if (!details) return null;
  const m = details.match(/model\s*:?\s*([^\n]+)/i);
  if (!m) return null;
  const value = m[1].replace(/\s*(?:sr\.?\s*no\.?|engine\s*no\.?)\s*:?.*/i, '').trim();
  return value || null;
}

/**
 * "SR No" is tried first and, when present, always wins — a few rows also
 * carry an unrelated "Engine No" earlier in the same block (e.g. "ENGINE NO-
 * 25386955 ... SR No : 35294"), and preferring whichever came first in the
 * text would grab the wrong one. "Engine No" is only used as a fallback for
 * the small number of rows that never mention "SR No" at all.
 */
function extractSerial(details: string | null): string | null {
  if (!details) return null;
  const sr = details.match(/sr\.?\s*no\.?\s*:?\s*([A-Za-z0-9][A-Za-z0-9/\-.]*)/i);
  if (sr) return sr[1].trim();
  const engineNo = details.match(/engine\s*no\.?\s*:?\s*([A-Za-z0-9][A-Za-z0-9/\-. ]*)/i);
  return engineNo ? engineNo[1].trim() : null;
}
