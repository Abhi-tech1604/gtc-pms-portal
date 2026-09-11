import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { ErrorBox, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

interface ModuleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

/**
 * Spec 7: the admin-manageable module list. Deactivating a module here closes
 * it to every account, Admin included, until switched back on — the server
 * enforces this on every request behind the module (middleware/auth.ts's
 * requireModule), not only in this screen.
 */
export default function AdminModules() {
  const [modules, setModules] = useState<ModuleRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useBusy();

  async function load() {
    const data = await api.get<{ modules: ModuleRow[] }>('/admin/modules');
    setModules(data.modules);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, []);

  async function toggle(m: ModuleRow) {
    setError('');
    try {
      await run(async () => {
        await api.put(`/admin/modules/${m.code}`, { isActive: !m.isActive });
        await load();
      });
    } catch (e) { setError((e as Error).message); }
  }

  if (!modules) return <Spinner />;

  return (
    <div>
      <PageHeader title="Modules" subtitle="The application modules that share this login." />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      <InfoBox>
        DPR and ILM are currently placeholder modules — real business functionality for each is
        developed separately. Turning a module off here blocks it for everyone immediately.
      </InfoBox>

      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Code</th><th>Name</th><th>Description</th><th>Status</th><th /></tr></thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.id}>
                <td className="font-mono text-xs font-semibold">{m.code}</td>
                <td className="font-medium">{m.name}</td>
                <td className="text-sm text-slate-600">{m.description ?? '-'}</td>
                <td><span className={m.isActive ? 'pill-normal' : 'pill-place'}>{m.isActive ? 'Active' : 'Inactive'}</span></td>
                <td className="text-right">
                  <button className="btn-ghost btn-sm" onClick={() => void toggle(m)} disabled={busy}>
                    {m.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
