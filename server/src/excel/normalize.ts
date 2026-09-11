/**
 * Identity normalisation. Field workbooks write the same rig and the same
 * machine many different ways; every comparison in the ingestion engine runs
 * through the functions here so both sides are normalised identically.
 */

/** Prefix tokens that name the fleet or the word "rig" itself and carry no identity. */
const RIG_PREFIXES = new Set(['gtc', 'rig', 'rigno', 'rignumber', 'rigname']);

/**
 * Rig key (spec 8.1).
 *
 *   lowercase -> non-alphanumeric runs become spaces -> split letter/digit
 *   boundaries -> tokenise -> strip leading zeros from numeric tokens ->
 *   drop a leading fleet/"rig" prefix -> join with hyphens
 *
 * All of these collapse to the same key:
 *   "GTC-50-1"  "GTC 50-01"  "RIG-50-01"  "gtc#50#1"  "Rig 50-02"  ->  50-1 / 50-2
 *
 * The prefix is dropped rather than canonicalised so that "Rig 50-02" (how the
 * crews actually write it in the workbook) matches the registered "GTC 50-02".
 */
export function rigKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value).toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, ' ');
  s = s.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
  let tokens = s.split(/\s+/).filter(Boolean);
  tokens = tokens.map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));
  while (tokens.length > 1 && RIG_PREFIXES.has(tokens[0])) tokens.shift();
  return tokens.join('-');
}

/** Machine name key: lowercase, all non-alphanumerics removed (spec 8.4). */
export function nameKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const BLANK_SERIALS = new Set(['', 'na', 'nil', 'none', 'null', '0']);

/**
 * Serial key (spec 8.4): strip any "M/C Sr No" style prefix, lowercase, remove
 * all non-alphanumerics. "na", "nil" and "none" are treated as blank.
 */
export function serialKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value).trim().toLowerCase();
  s = s.replace(/^(m\s*\/?\s*c\s*)?(sr|serial)\s*\.?\s*(no|number)?\s*[:.\-]?\s*/i, '');
  s = s.replace(/[^a-z0-9]+/g, '');
  if (BLANK_SERIALS.has(s)) return '';
  return s;
}

/** Header-cell key used when locating columns; tolerates typos in spacing/punctuation. */
export function headerKey(value: unknown): string {
  return nameKey(value);
}
