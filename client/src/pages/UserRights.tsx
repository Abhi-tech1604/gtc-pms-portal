import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, Save, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';
import { hasPagePermission } from '../lib/permissions';
import {
  MODULE_CODES, MODULE_LABELS, MODULE_PAGES,
  type ModuleAccess, type ModuleCode, type PageAction, type PagePermission, type PagePermissionsByModule, type User,
} from '../lib/types';
import { Empty, ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy } from '../components/ui';

const ACTIONS: PageAction[] = ['view', 'create', 'edit', 'delete'];
const ACTION_LABELS: Record<PageAction, string> = { view: 'View', create: 'Create/Add', edit: 'Edit', delete: 'Delete' };

const BLANK_PERM: PagePermission = { view: false, create: false, edit: false, delete: false };

function resolvePerm(p: Partial<PagePermission> | undefined): PagePermission {
  return { view: !!p?.view, create: !!p?.create, edit: !!p?.edit, delete: !!p?.delete };
}

/**
 * Admin > User Rights: Module -> Inner Page -> View/Create/Edit/Delete, per
 * user. Every checkbox starts pre-filled with that user's CURRENT effective
 * permission (an explicit override if one exists, else the module's own
 * default, else — for PMS/Admin pages — the legacy per-flag rule), computed
 * by the exact same resolver the server enforces (lib/permissions.ts). A
 * module's own Access switch must be on before any page beneath it can be
 * enabled — the page rows disable themselves the moment it's off. Saving
 * writes the whole matrix for this user as explicit overrides in one request
 * (PUT /admin/users/:id/module-access), so nothing here is "half saved."
 */
export default function UserRights() {
  const [params, setParams] = useSearchParams();
  const [users, setUsers] = useState<User[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [moduleAccess, setModuleAccess] = useState<ModuleAccess | null>(null);
  const [pages, setPages] = useState<PagePermissionsByModule>({});
  const [openModule, setOpenModule] = useState<ModuleCode | null>('PMS');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, run] = useBusy();

  async function loadUsers(): Promise<User[]> {
    const data = await api.get<{ users: User[] }>('/users');
    setUsers(data.users);
    return data.users;
  }

  useEffect(() => {
    loadUsers()
      .then((list) => {
        const fromQuery = params.get('user');
        setSelectedId(fromQuery && list.some((u) => u.id === fromQuery) ? fromQuery : (list[0]?.id ?? ''));
      })
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedUser = users?.find((u) => u.id === selectedId) ?? null;

  useEffect(() => {
    setError(''); setSaved('');
    if (!selectedUser) { setModuleAccess(null); setPages({}); return; }
    setModuleAccess(JSON.parse(JSON.stringify(selectedUser.moduleAccess)) as ModuleAccess);

    const seeded: PagePermissionsByModule = {};
    for (const code of MODULE_CODES) {
      const forModule: Record<string, PagePermission> = {};
      for (const page of MODULE_PAGES[code]) {
        forModule[page.key] = {
          view: hasPagePermission(selectedUser.role, selectedUser.rights, selectedUser.moduleAccess, selectedUser.pagePermissions, code, page.key, 'view'),
          create: hasPagePermission(selectedUser.role, selectedUser.rights, selectedUser.moduleAccess, selectedUser.pagePermissions, code, page.key, 'create'),
          edit: hasPagePermission(selectedUser.role, selectedUser.rights, selectedUser.moduleAccess, selectedUser.pagePermissions, code, page.key, 'edit'),
          delete: hasPagePermission(selectedUser.role, selectedUser.rights, selectedUser.moduleAccess, selectedUser.pagePermissions, code, page.key, 'delete'),
        };
      }
      seeded[code] = forModule;
    }
    setPages(seeded);
  }, [selectedUser?.id]);

  function selectUser(id: string) {
    setSelectedId(id);
    const next = new URLSearchParams(params);
    if (id) next.set('user', id); else next.delete('user');
    setParams(next, { replace: true });
  }

  function toggleAccess(code: ModuleCode) {
    setModuleAccess((d) => (d ? { ...d, [code]: { ...d[code], access: !d[code].access } } : d));
  }

  function togglePage(code: ModuleCode, pageKey: string, action: PageAction) {
    setPages((d) => {
      const forModule = { ...(d[code] ?? {}) };
      const current = forModule[pageKey] ?? BLANK_PERM;
      forModule[pageKey] = { ...current, [action]: !current[action] };
      return { ...d, [code]: forModule };
    });
  }

  async function save() {
    if (!selectedUser || !moduleAccess) return;
    setError(''); setSaved('');
    try {
      // A module's pages can never be effectively on while its own Access
      // switch is off — zeroed here so what's saved matches what the server
      // (and this same screen, next time it's opened) will actually show.
      const cleanedPages: PagePermissionsByModule = {};
      for (const code of MODULE_CODES) {
        const accessOn = moduleAccess[code]?.access;
        const forModule: Record<string, PagePermission> = {};
        for (const page of MODULE_PAGES[code]) {
          forModule[page.key] = accessOn ? resolvePerm(pages[code]?.[page.key]) : BLANK_PERM;
        }
        cleanedPages[code] = forModule;
      }
      await run(() => api.put(`/admin/users/${selectedUser.id}/module-access`, {
        moduleAccess, pagePermissions: cleanedPages,
      }));
      setSaved(`Permissions saved for ${selectedUser.username}. They take effect on that user's next request.`);
      await loadUsers();
    } catch (e) { setError((e as Error).message); }
  }

  if (!users) return <Spinner />;

  const isAdminUser = selectedUser?.role === 'Admin';

  return (
    <div>
      <PageHeader
        title="User Rights"
        subtitle="Module → Inner Page → View / Create / Edit / Delete. Enforced on the server for every request, not only hidden in the menus."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      {saved && <InfoBox>{saved}</InfoBox>}

      <div className="card p-4 mb-5 max-w-sm">
        <Field label="User">
          <select className="input" value={selectedId} onChange={(e) => selectUser(e.target.value)}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.username} — {u.role}</option>)}
          </select>
        </Field>
      </div>

      {users.length === 0 && <Empty message="No user accounts yet." />}

      {selectedUser && moduleAccess && (
        <>
          {isAdminUser && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 mb-4">
              <ShieldAlert size={16} className="mt-0.5 shrink-0" />
              <div>Admin accounts are always unrestricted — this matrix has no effect on <b>{selectedUser.username}</b> and can't be edited here.</div>
            </div>
          )}

          <div className="space-y-3">
            {MODULE_CODES.map((code) => (
              <ModuleCard
                key={code}
                code={code}
                access={moduleAccess[code].access}
                open={openModule === code}
                pages={pages[code] ?? {}}
                disabled={isAdminUser}
                onToggleOpen={() => setOpenModule((m) => (m === code ? null : code))}
                onToggleAccess={() => toggleAccess(code)}
                onTogglePage={(pageKey, action) => togglePage(code, pageKey, action)}
              />
            ))}
          </div>

          <div className="flex justify-end pt-5">
            <button className="btn-primary" disabled={busy || isAdminUser} onClick={() => void save()}>
              <Save size={14} /> Save Permissions
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ModuleCard({ code, access, open, pages, disabled, onToggleOpen, onToggleAccess, onTogglePage }: {
  code: ModuleCode;
  access: boolean;
  open: boolean;
  pages: Record<string, Partial<PagePermission>>;
  disabled: boolean;
  onToggleOpen: () => void;
  onToggleAccess: () => void;
  onTogglePage: (pageKey: string, action: PageAction) => void;
}) {
  const pageDefs = MODULE_PAGES[code];
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <button className="text-slate-400 hover:text-slate-700" onClick={onToggleOpen} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="font-medium text-slate-800 text-sm flex-1">{MODULE_LABELS[code]}</div>
        <label className={`flex items-center gap-2 text-xs font-medium ${disabled ? 'text-slate-300' : 'text-slate-600'}`}>
          <input type="checkbox" className="h-4 w-4 accent-rig-600" checked={access} disabled={disabled} onChange={onToggleAccess} />
          Access
        </label>
      </div>

      {open && (
        <div className="border-t border-slate-200 overflow-x-auto">
          <table className="table text-xs">
            <thead>
              <tr>
                <th>Page</th>
                {ACTIONS.map((a) => <th key={a} className="text-center">{ACTION_LABELS[a]}</th>)}
              </tr>
            </thead>
            <tbody>
              {pageDefs.map((page) => {
                const perm = resolvePerm(pages[page.key]);
                const rowDisabled = disabled || !access;
                return (
                  <tr key={page.key}>
                    <td className={rowDisabled ? 'text-slate-300' : 'text-slate-700'}>{page.label}</td>
                    {ACTIONS.map((action) => (
                      <td key={action} className="text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-rig-600"
                          checked={perm[action]}
                          disabled={rowDisabled}
                          onChange={() => onTogglePage(page.key, action)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {pageDefs.length === 0 && (
                <tr><td colSpan={ACTIONS.length + 1}><Empty message="This module has no pages in the matrix yet." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
