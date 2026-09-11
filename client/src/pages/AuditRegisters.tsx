import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { count, dateTime } from '../lib/format';
import { Empty, ErrorBox, Field, InfoBox, PageHeader, Spinner, Tabs } from '../components/ui';

interface AuditEntry {
  id: string; user: string | null; time: string; ip: string | null; action: string;
  entity: string | null; entityId: string | null; field: string | null;
  oldValue: string | null; newValue: string | null; detail: string | null;
}

interface LoginEntry {
  id: string; username: string; time: string; ip: string | null;
  success: number; userAgent: string | null; reason: string | null;
}

export default function AuditRegisters() {
  const [tab, setTab] = useState<'changes' | 'logins'>('changes');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [logins, setLogins] = useState<LoginEntry[] | null>(null);
  const [users, setUsers] = useState<{ user: string }[]>([]);
  const [actions, setActions] = useState<{ action: string }[]>([]);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ user: '', action: '', from: '', to: '' });

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    const data = await api.get<{ entries: AuditEntry[]; users: { user: string }[]; actions: { action: string }[] }>(
      `/audit?${q}`,
    );
    setEntries(data.entries);
    setUsers(data.users);
    setActions(data.actions);
  }, [filters]);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  useEffect(() => {
    if (tab !== 'logins' || logins) return;
    api.get<{ logins: LoginEntry[] }>('/logins').then((d) => setLogins(d.logins)).catch((e) => setError((e as Error).message));
  }, [tab, logins]);

  return (
    <div>
      <PageHeader
        title="Audit Registers"
        subtitle="Who changed what, when, and from where. Records are append-only."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <InfoBox>
        Nothing on this screen can be edited or deleted. Workbook ingestion writes one entry per field
        it changes on an existing machine.
      </InfoBox>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[{ key: 'changes', label: 'Data changes' }, { key: 'logins', label: 'Login history' }]}
      />

      {tab === 'changes' && (
        <>
          <div className="card p-3 mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
            <Field label="User">
              <select className="input" value={filters.user} onChange={(e) => setFilters({ ...filters, user: e.target.value })}>
                <option value="">All users</option>
                {users.map((u) => <option key={u.user}>{u.user}</option>)}
              </select>
            </Field>
            <Field label="Action">
              <select className="input" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
                <option value="">All actions</option>
                {actions.map((a) => <option key={a.action}>{a.action}</option>)}
              </select>
            </Field>
            <Field label="From"><input className="input" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Field>
            <Field label="To"><input className="input" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Field>
          </div>

          {!entries ? <Spinner /> : (
            <div className="card overflow-x-auto">
              <div className="card-header"><h2 className="card-title">{count(entries.length)} entries</h2></div>
              <table className="table">
                <thead>
                  <tr><th>When</th><th>User</th><th>IP</th><th>Action</th><th>Entity</th><th>Field</th><th>Old value</th><th>New value</th><th>Detail</th></tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap text-xs">{dateTime(e.time)}</td>
                      <td className="text-xs">{e.user ?? '-'}</td>
                      <td className="text-xs">{e.ip ?? '-'}</td>
                      <td className="text-xs font-medium">{e.action}</td>
                      <td className="text-xs">{e.entity ?? '-'}</td>
                      <td className="text-xs">{e.field ?? '-'}</td>
                      <td className="text-xs max-w-[180px] truncate" title={e.oldValue ?? ''}>{e.oldValue ?? '-'}</td>
                      <td className="text-xs max-w-[180px] truncate" title={e.newValue ?? ''}>{e.newValue ?? '-'}</td>
                      <td className="text-xs max-w-[240px] truncate" title={e.detail ?? ''}>{e.detail ?? '-'}</td>
                    </tr>
                  ))}
                  {entries.length === 0 && <tr><td colSpan={9}><Empty message="No audit entries match these filters." /></td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'logins' && (
        !logins ? <Spinner /> : (
          <div className="card overflow-x-auto">
            <table className="table">
              <thead><tr><th>When</th><th>Username</th><th>IP</th><th>Result</th><th>Reason</th><th>Agent</th></tr></thead>
              <tbody>
                {logins.map((l) => (
                  <tr key={l.id}>
                    <td className="whitespace-nowrap text-xs">{dateTime(l.time)}</td>
                    <td className="text-xs font-medium">{l.username}</td>
                    <td className="text-xs">{l.ip ?? '-'}</td>
                    <td>
                      <span className={l.success ? 'pill-normal' : 'pill-overdue'}>{l.success ? 'Success' : 'Failed'}</span>
                    </td>
                    <td className="text-xs">{l.reason ?? '-'}</td>
                    <td className="text-xs max-w-[280px] truncate" title={l.userAgent ?? ''}>{l.userAgent ?? '-'}</td>
                  </tr>
                ))}
                {logins.length === 0 && <tr><td colSpan={6}><Empty message="No sign-in attempts recorded." /></td></tr>}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
