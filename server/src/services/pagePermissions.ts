import type { Rights } from './rights.js';
import { hasModuleAccess, type ModuleAccess, type ModuleCode } from './moduleAccess.js';

/**
 * Page-level permission matrix (Admin > User Rights): Module -> Page ->
 * {view, create, edit, delete}. Layered on TOP of the existing per-module
 * `users.moduleAccess` grid — that grid still owns the module's "Access"
 * switch (must be on before any page underneath can be enabled, per spec)
 * and still supplies the DEFAULT for every page that has no explicit
 * override, so nothing changes for any existing user until an Admin
 * deliberately customises a specific page. Stored in the SAME
 * `users.moduleAccess` JSON column, as a sibling `pages` key — reusing the
 * existing User<->Module relationship rather than a parallel table.
 */

export const PAGE_ACTIONS = ['view', 'create', 'edit', 'delete'] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];

export interface PagePermission { view: boolean; create: boolean; edit: boolean; delete: boolean }
export interface PageDef { key: string; label: string }

/** One static, canonical registry of every page this matrix governs — mirrored on the client (lib/types.ts) for the UI. */
export const MODULE_PAGES: Record<ModuleCode, PageDef[]> = {
  PMS: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'equipment', label: 'Equipment Directory' },
    { key: 'healthcheckup', label: 'Health Checkup' },
    { key: 'service', label: 'Service History' },
    { key: 'reports', label: 'Reports' },
    // Rig Master is also reachable as a PMS-area screen (/rigs, gated by the
    // legacy canManageRigs flag) as well as under Admin > Master — kept here
    // too so that existing non-Admin canManageRigs holders keep working
    // (Admin > User Rights lists it once, under PMS, matching that route).
    { key: 'rig_master', label: 'Rig Master' },
  ],
  DPR: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'progress_report', label: 'Progress Report' },
    { key: 'hsd_report', label: 'HSD Report' },
    { key: 'import', label: 'Excel Import' },
  ],
  ILM: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'ilm_add', label: 'ILM Add' },
    { key: 'trailer_dashboard', label: 'Trailer Dashboard' },
    { key: 'crane_dashboard', label: 'Crane Dashboard' },
    { key: 'import', label: 'Excel Import' },
  ],
  DRR: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'new_report', label: 'New Daily Report' },
    { key: 'reports', label: 'All Reports' },
  ],
  FOLLOWUP: [
    { key: 'dashboard', label: 'Follow-up Dashboard' },
    { key: 'new', label: 'New Follow-up' },
    { key: 'history', label: 'Follow-up History' },
  ],
  INVOICE: [
    { key: 'dashboard', label: 'Invoice Dashboard' },
    { key: 'create', label: 'Create Invoice' },
    { key: 'history', label: 'Invoice History' },
    { key: 'settings', label: 'Invoice Settings' },
  ],
  ADMIN: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'users', label: 'Users' },
    { key: 'user_rights', label: 'User Rights' },
    { key: 'rig_master', label: 'Rig Master' },
    { key: 'equipment_master', label: 'Equipment Master' },
    { key: 'material_master', label: 'Material Master' },
    { key: 'oil_lubricant_master', label: 'Oil & Lubricant Master' },
    { key: 'transfer_equipment', label: 'Transfer Equipment' },
    { key: 'modules', label: 'Modules' },
    { key: 'notification_settings', label: 'Notification Settings' },
    { key: 'smtp_settings', label: 'SMTP Configuration' },
    { key: 'logs', label: 'Logs' },
    { key: 'reports', label: 'Reports' },
  ],
};

export type PagePermissionsByModule = Partial<Record<ModuleCode, Record<string, Partial<PagePermission>>>>;

function permission(p: Partial<PagePermission> | undefined): PagePermission {
  return { view: !!p?.view, create: !!p?.create, edit: !!p?.edit, delete: !!p?.delete };
}

/** Reads the raw JSON blob stored in users.moduleAccess without assuming its shape — tolerant of legacy rows that predate the `pages` key. */
function parseBlob(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The Admin-entered per-page overrides only — never module defaults or legacy flags (those are applied by hasPagePermission at read time). */
export function parsePagePermissions(json: string | null | undefined): PagePermissionsByModule {
  const pages = parseBlob(json).pages;
  return pages && typeof pages === 'object' ? (pages as PagePermissionsByModule) : {};
}

/** Merges a full replacement `pages` map into the existing moduleAccess JSON blob, preserving every other key (the module-level grid) untouched. */
export function serialisePagePermissions(existingJson: string | null | undefined, pages: PagePermissionsByModule): string {
  const blob = parseBlob(existingJson);
  const cleaned: PagePermissionsByModule = {};
  for (const [code, pagesForModule] of Object.entries(pages)) {
    if (!pagesForModule) continue;
    const out: Record<string, PagePermission> = {};
    for (const [key, perm] of Object.entries(pagesForModule)) out[key] = permission(perm);
    cleaned[code as ModuleCode] = out;
  }
  return JSON.stringify({ ...blob, pages: cleaned });
}

/**
 * PMS pages carried real per-flag granularity long before this matrix
 * existed (services/rights.ts's PERMISSION_FLAGS) — every existing PMS user
 * keeps EXACTLY that behaviour as the default for each page, until an Admin
 * sets an explicit override in the new matrix. `view` on Equipment/Health
 * Checkup/Service History was never separately flag-gated (any PMS-access
 * account could already see them) — only Reports and the Dashboard itself
 * had dedicated view flags.
 */
function legacyPmsDefault(rights: Rights, pageKey: string, action: PageAction): boolean {
  if (action === 'view') {
    if (pageKey === 'dashboard') return rights.canViewDashboard;
    if (pageKey === 'reports') return rights.canManageReports;
    return true;
  }
  if (pageKey === 'equipment') return rights.canManageEquipment;
  if (pageKey === 'healthcheckup') return rights.canManageHealthcheckup;
  if (pageKey === 'rig_master') return rights.canManageRigs;
  return false;
}

/**
 * A handful of Admin Panel pages (Rig/Equipment/Material Master, Transfer
 * Equipment, Reports, Users/User Rights) are also reachable — with the same
 * backend routes — from PMS-area screens that a non-Admin account could
 * already use via a rights.ts flag (canManageRigs, canManageEquipment, ...).
 * Falling back to that same flag here means opening this page under Admin
 * changes nothing for anyone who already had the equivalent PMS-area access.
 * Pages that were always Admin-role-only (Modules, Notification Settings,
 * Oil & Lubricant Master, Logs, Dashboard) have no such flag and default to
 * false — exactly today's behaviour for every non-Admin account.
 */
function legacyAdminDefault(rights: Rights, pageKey: string, action: PageAction): boolean {
  switch (pageKey) {
    case 'rig_master': return rights.canManageRigs;
    case 'equipment_master': return rights.canManageEquipment;
    case 'material_master': return rights.canManageEquipment;
    // Transfer Equipment's actual API (routes/equipmentTransfers.ts) is
    // gated by canManageEquipment, not canManageTransfers (that flag governs
    // the separate Material Transfers screen under Logs) — matching the
    // real existing gate here, not the more plausible-sounding flag name.
    case 'transfer_equipment': return rights.canManageEquipment;
    case 'reports': return action === 'view' ? rights.canManageReports : false;
    case 'users': return rights.canManageUserRights;
    case 'user_rights': return rights.canManageUserRights;
    case 'logs': return action === 'view'
      ? (rights.canUploadMechanicalLogs || rights.canViewAuditLogs || rights.canManageTransfers || rights.canManageHolidays)
      : false;
    default: return false;
  }
}

export interface PagePermissionUser {
  role: string;
  rights: Rights;
  moduleAccess: ModuleAccess;
  pagePermissions: PagePermissionsByModule;
}

/**
 * The one function every page-level check (server middleware, client UI)
 * resolves through. Order: Admin role is always unrestricted (spec: "Keep
 * Admin unrestricted unless intentionally configured otherwise" — no code
 * path in this app has ever let Admin be locked out, so this stays a hard
 * bypass) -> the module's Access switch must be on, or nothing underneath it
 * can ever be true -> an explicit per-page override wins if the Admin set
 * one -> otherwise fall back to the pre-existing default for that module
 * (PMS/Admin's legacy per-flag rules, or the other modules' own
 * view/create/edit/delete grid) so no existing account's effective access
 * changes on its own.
 */
export function hasPagePermission(user: PagePermissionUser, moduleCode: ModuleCode, pageKey: string, action: PageAction): boolean {
  if (user.role === 'Admin') return true;
  if (!hasModuleAccess(user.moduleAccess, moduleCode)) return false;

  const explicit = user.pagePermissions[moduleCode]?.[pageKey]?.[action];
  if (typeof explicit === 'boolean') return explicit;

  if (moduleCode === 'PMS') return legacyPmsDefault(user.rights, pageKey, action);
  if (moduleCode === 'ADMIN') return legacyAdminDefault(user.rights, pageKey, action);
  return !!user.moduleAccess[moduleCode]?.[action];
}
