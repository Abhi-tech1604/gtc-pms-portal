/**
 * Every hour figure in this system is a whole number (spec 9.6 / defect D12).
 * Spreadsheet arithmetic yields values like 82.14999999999964; rounding happens
 * both here (at the point of storage) and again in the client (at display).
 */
export function roundHours(v: unknown): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  return Math.round(n);
}

/** Parses a cell value into a number, treating blanks and junk as absent. */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return null;
  const s = String(v).trim();
  if (s === '') return null;
  // Tolerate values written as "1,234", "12 hrs", "266 KPA".
  const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** True when a cell holds an actual crew entry, including a typed zero. */
export function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  const s = String(v).trim();
  return s !== '';
}

/** A numeric cell the crew actually typed (zero counts, blank does not). */
export function presentNumber(v: unknown): number | null {
  if (!isPresent(v)) return null;
  return toNumber(v);
}

export function cleanText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}
