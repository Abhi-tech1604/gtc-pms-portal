import type { ModuleAccess, ModuleCode, PageAction, PagePermissionsByModule, Rights } from './types';

/**
 * Mirrors server/src/services/pagePermissions.ts's hasPagePermission() exactly
 * (same order: Admin bypass -> module Access must be on -> explicit per-page
 * override -> PMS/Admin's legacy per-flag fallback -> the other modules' own
 * CRUD grid) so the UI never shows a control the server would then reject.
 * This is a convenience check only — the server enforces the same rule
 * independently on every request.
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

function legacyAdminDefault(rights: Rights, pageKey: string, action: PageAction): boolean {
  switch (pageKey) {
    case 'rig_master': return rights.canManageRigs;
    case 'equipment_master': return rights.canManageEquipment;
    case 'material_master': return rights.canManageEquipment;
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

export function hasPagePermission(
  role: string | undefined,
  rights: Rights | undefined,
  moduleAccess: ModuleAccess | undefined,
  pagePermissions: PagePermissionsByModule | undefined,
  moduleCode: ModuleCode,
  pageKey: string,
  action: PageAction,
): boolean {
  if (role === 'Admin') return true;
  if (!moduleAccess?.[moduleCode]?.access) return false;

  const explicit = pagePermissions?.[moduleCode]?.[pageKey]?.[action];
  if (typeof explicit === 'boolean') return explicit;

  if (!rights) return false;
  if (moduleCode === 'PMS') return legacyPmsDefault(rights, pageKey, action);
  if (moduleCode === 'ADMIN') return legacyAdminDefault(rights, pageKey, action);
  return !!moduleAccess[moduleCode]?.[action];
}
