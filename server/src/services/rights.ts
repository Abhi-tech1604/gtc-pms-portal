/** Spec 5.2. The ten permission flags the Admin can toggle individually. */
export const PERMISSION_FLAGS = [
  'canViewDashboard',
  'canManageRigs',
  'canManageEquipment',
  'canUploadMechanicalLogs',
  'canManageHolidays',
  'canManageHealthcheckup',
  'canManageTransfers',
  'canManageReports',
  'canViewAuditLogs',
  'canManageUserRights',
] as const;

export type PermissionFlag = (typeof PERMISSION_FLAGS)[number];
export type Rights = Record<PermissionFlag, boolean>;

export const ROLES = [
  'Admin', 'Operational Manager', 'Storekeeper', 'PMS User', 'Rig Supervisor', 'Field Manager', 'Auditor',
] as const;
export type Role = (typeof ROLES)[number];

function make(flags: Partial<Rights>): Rights {
  const out = {} as Rights;
  for (const f of PERMISSION_FLAGS) out[f] = flags[f] ?? false;
  return out;
}

/** Spec 5.1. Defaults applied when a user is created; the Admin may then adjust. */
export const ROLE_DEFAULTS: Record<Role, Rights> = {
  Admin: make(Object.fromEntries(PERMISSION_FLAGS.map((f) => [f, true])) as Rights),
  'PMS User': make({
    canViewDashboard: true,
    canManageRigs: true,
    canManageEquipment: true,
    canUploadMechanicalLogs: true,
    canManageHolidays: true,
    canManageHealthcheckup: true,
    canManageTransfers: true,
    canManageReports: true,
  }),
  'Rig Supervisor': make({
    canViewDashboard: true,
    canUploadMechanicalLogs: true,
    canManageHealthcheckup: true,
    canManageEquipment: true,
  }),
  'Field Manager': make({
    canViewDashboard: true,
    canManageTransfers: true,
    canManageReports: true,
  }),
  Auditor: make({
    canViewDashboard: true,
    canManageReports: true,
    canViewAuditLogs: true,
  }),
  // Storekeeper/Operational Manager are DRR-first roles — their real access
  // is the DRR module grid (moduleAccess.ts) plus their Rig Assignment
  // (drr_rig_responsibility), not this PMS-specific flag set. They get no
  // PMS rights by default; an Admin can still add PMS access if one person
  // genuinely does both jobs.
  'Operational Manager': make({ canViewDashboard: true }),
  Storekeeper: make({ canViewDashboard: true }),
};

export function parseRights(json: string | null | undefined, role: Role): Rights {
  const base = ROLE_DEFAULTS[role] ?? make({});
  if (!json) return { ...base };
  try {
    const parsed = JSON.parse(json) as Partial<Rights>;
    const out = {} as Rights;
    for (const f of PERMISSION_FLAGS) out[f] = typeof parsed[f] === 'boolean' ? parsed[f]! : base[f];
    return out;
  } catch {
    return { ...base };
  }
}

export function serialiseRights(rights: Partial<Rights>, role: Role): string {
  const base = ROLE_DEFAULTS[role] ?? make({});
  const out = {} as Rights;
  for (const f of PERMISSION_FLAGS) out[f] = typeof rights[f] === 'boolean' ? rights[f]! : base[f];
  return JSON.stringify(out);
}
