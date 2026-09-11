import type { Role } from './rights.js';

/**
 * The application modules sharing one login, PLUS FOLLOWUP/INVOICE/ADMIN —
 * added so the Admin > User Rights page-permission matrix (services/
 * pagePermissions.ts) can govern the Follow-up module, the Invoice module,
 * and the Admin Panel's own screens the exact same way it governs PMS/DPR/
 * ILM/DRR. FOLLOWUP/INVOICE/ADMIN are not offered on the module-select
 * landing page (client/src/pages/ModuleSelect.tsx keeps its own literal
 * ['PMS','DPR','ILM','DRR'] list) — they exist here purely as permission
 * buckets. PMS's own real permissions still stay primarily in
 * services/rights.ts (the legacy PERMISSION_FLAGS grid); this module's entry
 * for PMS carries the access switch, and pagePermissions.ts's PMS pages fall
 * back to those same flags as their default until an Admin sets an explicit
 * per-page override.
 */
export const MODULE_CODES = ['PMS', 'DPR', 'ILM', 'DRR', 'FOLLOWUP', 'INVOICE', 'ADMIN'] as const;
export type ModuleCode = (typeof MODULE_CODES)[number];

export interface ModulePermission {
  access: boolean;
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
}

export type ModuleAccess = Record<ModuleCode, ModulePermission>;

const CRUD_ACTIONS = ['view', 'create', 'edit', 'delete'] as const;
export type ModuleAction = (typeof CRUD_ACTIONS)[number];

function permission(p: Partial<ModulePermission>): ModulePermission {
  return {
    access: p.access ?? false,
    view: p.view ?? false,
    create: p.create ?? false,
    edit: p.edit ?? false,
    delete: p.delete ?? false,
  };
}

function make(modules: Partial<Record<ModuleCode, Partial<ModulePermission>>>): ModuleAccess {
  const out = {} as ModuleAccess;
  for (const code of MODULE_CODES) out[code] = permission(modules[code] ?? {});
  return out;
}

/** Applied when a user is created; the Admin may then adjust per module. */
export const MODULE_ROLE_DEFAULTS: Record<Role, ModuleAccess> = {
  Admin: make({
    PMS: { access: true },
    DPR: { access: true, view: true, create: true, edit: true, delete: true },
    ILM: { access: true, view: true, create: true, edit: true, delete: true },
    DRR: { access: true, view: true, create: true, edit: true, delete: true },
    FOLLOWUP: { access: true, view: true, create: true, edit: true, delete: true },
    INVOICE: { access: true, view: true, create: true, edit: true, delete: true },
    ADMIN: { access: true, view: true, create: true, edit: true, delete: true },
  }),
  'PMS User': make({ PMS: { access: true } }),
  'Rig Supervisor': make({ PMS: { access: true } }),
  'Field Manager': make({ PMS: { access: true } }),
  Auditor: make({ PMS: { access: true } }),
  Storekeeper: make({ DRR: { access: true, view: true, create: true, edit: true } }),
  'Operational Manager': make({ DRR: { access: true, view: true, edit: true } }),
};

export function parseModuleAccess(json: string | null | undefined, role: Role): ModuleAccess {
  const base = MODULE_ROLE_DEFAULTS[role] ?? make({});
  if (!json) return base;
  try {
    const parsed = JSON.parse(json) as Partial<Record<ModuleCode, Partial<ModulePermission>>>;
    const out = {} as ModuleAccess;
    for (const code of MODULE_CODES) {
      const p = parsed[code];
      out[code] = p
        ? {
            access: typeof p.access === 'boolean' ? p.access : base[code].access,
            view: typeof p.view === 'boolean' ? p.view : base[code].view,
            create: typeof p.create === 'boolean' ? p.create : base[code].create,
            edit: typeof p.edit === 'boolean' ? p.edit : base[code].edit,
            delete: typeof p.delete === 'boolean' ? p.delete : base[code].delete,
          }
        : base[code];
    }
    return out;
  } catch {
    return base;
  }
}

export function serialiseModuleAccess(access: Partial<ModuleAccess>, role: Role): string {
  const base = MODULE_ROLE_DEFAULTS[role] ?? make({});
  const out = {} as ModuleAccess;
  for (const code of MODULE_CODES) out[code] = access[code] ? permission(access[code]!) : base[code];
  return JSON.stringify(out);
}

/**
 * Reconciles an admin's raw edit of the module-access matrix: a module's own
 * view/create/edit/delete flags can never be true while its access switch is
 * off, no matter what the caller sent (spec 21: "If module access is OFF,
 * internal permissions should be disabled/ignored").
 */
export function sanitizeModuleAccessInput(
  input: Partial<Record<ModuleCode, Partial<ModulePermission>>>,
): Partial<ModuleAccess> {
  const out: Partial<ModuleAccess> = {};
  for (const code of MODULE_CODES) {
    const m = input[code];
    if (!m) continue;
    const access = !!m.access;
    out[code] = {
      access,
      view: access && !!m.view,
      create: access && !!m.create,
      edit: access && !!m.edit,
      delete: access && !!m.delete,
    };
  }
  return out;
}

export function hasModuleAccess(access: ModuleAccess, code: ModuleCode): boolean {
  return !!access[code]?.access;
}

/** A module's own View/Create/Edit/Delete flags only matter once its access switch is on. */
export function hasModuleAction(access: ModuleAccess, code: ModuleCode, action: ModuleAction): boolean {
  const m = access[code];
  return !!m?.access && !!m[action];
}
