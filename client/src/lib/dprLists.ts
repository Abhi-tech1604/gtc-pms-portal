/**
 * The dropdown lists the generated DPR Excel template uses
 * (server/src/excel/dprTemplate.ts's hidden "Lists" sheet) — copied from
 * there, not reinvented, so the manual-entry web form offers exactly the
 * same choices as the Excel dropdowns (spec: Excel and manual entry must be
 * identical).
 *
 * Breakdown Equipment is deliberately NOT here — it used to be a static list
 * but now comes live from PMS's Equipment Master (GET /dpr/equipment?rigId=,
 * see DprLineItemsEditor.tsx's `equipmentOptions` prop), scoped to whichever
 * rig is selected, so adding/editing/deactivating equipment there is
 * reflected in DPR with no code change.
 */

export const DPR_WORK_TYPES = ['R0', 'R1', 'R2', 'R2/2', 'R3', 'ILM'];

export const DPR_ACTIVITY_CODES = [
  '02 - Drilling', '03 - Reaming', '04 - Coring', '05 - C&C', '06 - Tripping', '07 - Lubrication',
  '08 - Breakdown', '09 - Slip & Cut', '10 - Deviation Survey', '11 - Logging', '12 - Casing R/in',
  '13 - Wait on Cement', '14 - Nipple Up/Down BOP', '15 - Test BOP', '16 - Drill Stem BOP',
  '17 - Plug Back', '18 - Cementing', '19 - Fishing', '20 - Directional Work', '21 - Tubing Job',
  '22 - Testing LOT CIT', '23 - Other',
];

export const DPR_BIT_SIZES = ['5 1/2"', '6"', '8 1/2"', '12 1/4"', '17 1/2"', '26"'];

export const DPR_CASING_SIZES = ['2 7/8"', '4 1/2"', '5"', '5 1/2"', '7"', '9 5/8"', '13 3/8"', '20"'];

/**
 * Which of the Drill Sec./Casing Sec./Breakdown fields are relevant to each
 * operation — used by DprLineItemsEditor to grey out fields that don't apply
 * to a row's selected Operation (spec: "show only relevant fields for that
 * operation"). Drilling-section fields apply to the depth-related drilling
 * operations; casing-section fields apply to running casing; breakdown
 * fields apply only to the Breakdown operation itself. Every other operation
 * (Lubrication, Logging, Cementing, etc.) shows none of these three groups —
 * only the always-relevant Well/Work Type/Start/End/Description fields.
 */
const DRILLING_OPERATIONS = ['02 - Drilling', '03 - Reaming', '04 - Coring'];
const CASING_OPERATIONS = ['12 - Casing R/in'];
const BREAKDOWN_OPERATIONS = ['08 - Breakdown'];

export function isDrillingOperation(operationCode: string | null | undefined): boolean {
  return !!operationCode && DRILLING_OPERATIONS.includes(operationCode);
}
export function isCasingOperation(operationCode: string | null | undefined): boolean {
  return !!operationCode && CASING_OPERATIONS.includes(operationCode);
}
export function isBreakdownOperation(operationCode: string | null | undefined): boolean {
  return !!operationCode && BREAKDOWN_OPERATIONS.includes(operationCode);
}
