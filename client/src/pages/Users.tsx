import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { rigLabel } from '../lib/rig';
import { History, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { count, dateTime } from '../lib/format';
import { ROLES, MODULE_CODES, MODULE_LABELS, type ModuleCode, type Rig, type Role, type User } from '../lib/types';
import { ConfirmDialog, Empty, ErrorBox, Field, Modal, PageHeader, Spinner, useBusy } from '../components/ui';
import { useAuth } from '../lib/auth';

interface Draft extends Partial<User> { password?: string; moduleCodes?: ModuleCode[] }

export default function UsersPage() {
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<User[] | null>(null);
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [logins, setLogins] = useState<{ user: User; entries: Record<string, unknown>[] } | null>(null);
  const [busy, run] = useBusy();

  async function load() {
    const [u, r] = await Promise.all([
      api.get<{ users: User[] }>('/users'),
      api.get<{ rigs: Rig[] }>('/rigs'),
    ]);
    setUsers(u.users);
    setRigs(r.rigs);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  /** Opens the edit modal with Module Access checkboxes pre-checked from the account's current per-module `access` flags. */
  function openEdit(u: User) {
    const moduleCodes = MODULE_CODES.filter((code) => u.moduleAccess[code]?.access);
    setEditing({ ...u, moduleCodes });
  }

  async function save() {
    if (!editing) return;
    setError('');
    try {
      await run(async () => {
        const payload = { ...editing, rigIds: editing.rigIds ?? [] };
        if (editing.id) await api.put(`/users/${editing.id}`, payload);
        else await api.post('/users', payload);
        await load();
      });
      setEditing(null);
    } catch (e) { setError((e as Error).message); }
  }

  function toggleModuleCode(code: ModuleCode) {
    if (!editing) return;
    const current = editing.moduleCodes ?? [];
    setEditing({
      ...editing,
      moduleCodes: current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
    });
  }

  function toggleRig(rigId: string) {
    if (!editing) return;
    const current = editing.rigIds ?? [];
    setEditing({
      ...editing,
      rigIds: current.includes(rigId) ? current.filter((r) => r !== rigId) : [...current, rigId],
    });
  }

  async function remove() {
    if (!deleting) return;
    try {
      await run(async () => { await api.del(`/users/${deleting.id}`); await load(); });
      setDeleting(null);
    } catch (e) { setError((e as Error).message); setDeleting(null); }
  }

  async function openLogins(user: User) {
    try {
      const data = await api.get<{ logins: Record<string, unknown>[] }>(`/users/${user.id}/logins`);
      setLogins({ user, entries: data.logins });
    } catch (e) { setError((e as Error).message); }
  }

  if (!users) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="User Login Option"
        subtitle={`${count(users.length)} account(s). Passwords are stored hashed and never shown.`}
        actions={
          <button className="btn-primary" onClick={() => setEditing({ role: 'PMS User', status: 'Active', moduleCodes: [], rigIds: [] })}>
            <Plus size={14} /> New user
          </button>
        }
      />

      <ErrorBox message={error} onDismiss={() => setError('')} />

      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr><th>Username</th><th>Name</th><th>Role</th><th>Module Access</th><th>Assigned Rigs</th><th>Email</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const modules = MODULE_CODES.filter((code) => u.moduleAccess[code]?.access);
              const rigNames = u.rigIds.map((id) => rigs.find((r) => r.id === id)).filter((r): r is Rig => !!r);
              return (
                <tr key={u.id}>
                  <td className="font-medium">{u.username}</td>
                  <td>{u.name}</td>
                  <td>{u.role}</td>
                  <td className="text-xs">
                    {modules.length ? modules.join(', ') : <span className="text-slate-400">-</span>}
                  </td>
                  <td className="text-xs">
                    {rigNames.length
                      ? rigNames.map((r) => rigLabel(r)).join(', ')
                      : <span className="text-slate-400">Whole fleet</span>}
                  </td>
                  <td className="text-xs">{u.email ?? '-'}</td>
                  <td><span className={u.status === 'Active' ? 'pill-normal' : 'pill-overdue'}>{u.status}</span></td>
                  <td className="whitespace-nowrap text-right">
                    <button className="btn-ghost btn-sm mr-1" onClick={() => void openLogins(u)} title="Login history">
                      <History size={12} />
                    </button>
                    {isAdmin && (
                      <button className="btn-ghost btn-sm mr-1" onClick={() => navigate(`/admin/user-rights?user=${u.id}`)} title="User Rights (Module → Page → View/Create/Edit/Delete)">
                        <ShieldCheck size={12} />
                      </button>
                    )}
                    <button className="btn-ghost btn-sm mr-1" onClick={() => openEdit(u)}>
                      <Pencil size={12} />
                    </button>
                    <button className="btn-ghost btn-sm text-red-700" onClick={() => setDeleting(u)}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {users.length === 0 && <tr><td colSpan={8}><Empty message="No user accounts yet." /></td></tr>}
          </tbody>
        </table>
      </div>

      <Modal open={!!editing} title={editing?.id ? `Edit ${editing.username}` : 'New user'} onClose={() => setEditing(null)}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username">
                <input className="input" value={editing.username ?? ''} disabled={!!editing.id}
                  onChange={(e) => setEditing({ ...editing, username: e.target.value })} />
              </Field>
              <Field label="Full name">
                <input className="input" value={editing.name ?? ''}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label="Role">
                <select className="input" value={editing.role ?? 'PMS User'}
                  onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })}>
                  {ROLES.map((r) => <option key={r}>{r}</option>)}
                </select>
              </Field>
              <Field label="Email">
                <input className="input" value={editing.email ?? ''}
                  onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
              </Field>
              <Field label="Status">
                <select className="input" value={editing.status ?? 'Active'}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                  <option>Active</option><option>Suspended</option>
                </select>
              </Field>
              <div className="col-span-2">
                <Field label={editing.id ? 'Reset password (leave blank to keep)' : 'Password'}
                  hint="At least 8 characters. Stored hashed.">
                  <input className="input" type="password" value={editing.password ?? ''}
                    onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
                </Field>
              </div>
            </div>

            <Field label="Module Access" hint="Which modules this account can open at all. Fine-grained view/create/edit/delete stays in the grid icon on the user's row.">
              <div className="flex flex-wrap gap-3">
                {MODULE_CODES.map((code) => (
                  <label key={code} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox" checked={(editing.moduleCodes ?? []).includes(code)}
                      onChange={() => toggleModuleCode(code)}
                    />
                    {MODULE_LABELS[code] ?? code}
                  </label>
                ))}
              </div>
            </Field>

            <Field
              label="Assigned Rigs"
              hint={
                editing.role === 'Storekeeper' || editing.role === 'Operational Manager'
                  ? 'Controls which rigs this account sees, AND — for this role — which rigs it is the Primary Storekeeper/Operational Manager for in DRR approval routing. Leave all unchecked for whole-fleet access.'
                  : "Controls which rigs this account sees across PMS, DPR and ILM. Leave all unchecked for whole-fleet access."
              }
            >
              <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-md p-2 grid grid-cols-2 gap-1">
                {rigs.map((r) => (
                  <label key={r.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox" checked={(editing.rigIds ?? []).includes(r.id)}
                      onChange={() => toggleRig(r.id)}
                    />
                    {rigLabel(r)}
                  </label>
                ))}
              </div>
            </Field>

            <div className="text-xs text-slate-500">
              Permission flags default to the role and can be tuned per user in User Rights Option.
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!logins} title={`Login history - ${logins?.user.username ?? ''}`} onClose={() => setLogins(null)}>
        <div className="max-h-[60vh] overflow-auto">
          <table className="table">
            <thead><tr><th>When</th><th>IP</th><th>Result</th><th>Reason</th></tr></thead>
            <tbody>
              {logins?.entries.map((l) => (
                <tr key={String(l.id)}>
                  <td className="whitespace-nowrap text-xs">{dateTime(String(l.time))}</td>
                  <td className="text-xs">{(l.ip as string) ?? '-'}</td>
                  <td><span className={l.success ? 'pill-normal' : 'pill-overdue'}>{l.success ? 'Success' : 'Failed'}</span></td>
                  <td className="text-xs">{(l.reason as string) ?? '-'}</td>
                </tr>
              ))}
              {logins?.entries.length === 0 && <tr><td colSpan={4}><Empty message="No sign-in attempts yet." /></td></tr>}
            </tbody>
          </table>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        tone="danger"
        title={`Delete ${deleting?.username ?? ''}?`}
        confirmLabel="Delete account"
        busy={busy}
        body={<p>{deleting?.name} ({deleting?.role}) will lose access immediately. Their audit and login history is kept.</p>}
        onConfirm={() => void remove()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
