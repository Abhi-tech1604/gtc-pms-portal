import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { api } from '../../lib/api';
import { ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

interface SmtpSettings {
  enabled: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  hasPassword: boolean;
  fromEmail: string | null;
  fromName: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

const BLANK: SmtpSettings = {
  enabled: false, host: null, port: 587, secure: false, username: null, hasPassword: false,
  fromEmail: null, fromName: null, updatedBy: null, updatedAt: null,
};

/**
 * Admin > SMTP Configuration: the one mail-provider setup screen every
 * outbound email in the app sends through, starting with Notification
 * Settings' email channel. The stored password never round-trips back to
 * this form after saving — "Password" stays blank and is left untouched on
 * Save unless something new is typed, same as the User Rights password-reset
 * field convention elsewhere in Admin.
 */
export default function SmtpSettingsPage() {
  const [form, setForm] = useState<SmtpSettings>(BLANK);
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [busy, run] = useBusy();
  const [testBusy, setTestBusy] = useState(false);

  useEffect(() => {
    api.get<{ settings: SmtpSettings }>('/admin/smtp-settings')
      .then((d) => { setForm(d.settings); setLoaded(true); })
      .catch((e) => { setError((e as Error).message); setLoaded(true); });
  }, []);

  function set<K extends keyof SmtpSettings>(key: K, value: SmtpSettings[K]) {
    setForm({ ...form, [key]: value });
  }

  async function save() {
    setError(''); setSaved(false);
    try {
      await run(async () => {
        const d = await api.put<{ settings: SmtpSettings }>('/admin/smtp-settings', { ...form, password: password || undefined });
        setForm(d.settings);
        setPassword('');
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { setError((e as Error).message); }
  }

  async function sendTest() {
    if (!testTo) return;
    setError(''); setTestResult('');
    setTestBusy(true);
    try {
      await api.post('/admin/smtp-settings/test', { ...form, password: password || undefined, to: testTo });
      setTestResult(`Test email sent to ${testTo}. Check its inbox (and spam folder).`);
    } catch (e) { setError((e as Error).message); }
    finally { setTestBusy(false); }
  }

  if (!loaded) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="SMTP Configuration"
        subtitle="The mail server the portal sends outbound email through — notification alerts, and anything else that emails a user."
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      {saved && <InfoBox>SMTP Configuration saved.</InfoBox>}

      <div className="space-y-5 max-w-2xl">
        <section className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-800">Server</h3>
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <input type="checkbox" className="h-4 w-4 accent-rig-600" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
              Enabled
            </label>
          </div>
          {!form.enabled && (
            <p className="text-xs text-slate-500 mb-3">
              Off: emails are logged on the server only, never actually sent. Turn this on once "Send Test Email" below confirms delivery works.
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="SMTP Host" hint='e.g. smtp.gmail.com, smtp.office365.com'>
              <input className="input" value={form.host ?? ''} onChange={(e) => set('host', e.target.value || null)} placeholder="smtp.example.com" />
            </Field>
            <Field label="Port" hint="465 for implicit TLS, 587 for STARTTLS">
              <input className="input" type="number" min={1} max={65535} value={form.port ?? ''} onChange={(e) => set('port', e.target.value ? Number(e.target.value) : null)} />
            </Field>
            <Field label="Username">
              <input className="input" value={form.username ?? ''} onChange={(e) => set('username', e.target.value || null)} autoComplete="off" />
            </Field>
            <Field label="Password" hint={form.hasPassword ? 'A password is already saved — leave blank to keep it.' : 'Not set yet.'}>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={form.hasPassword ? '••••••••' : ''} />
            </Field>
            <label className="flex items-center gap-2 text-sm text-slate-700 md:col-span-2">
              <input type="checkbox" className="h-4 w-4 accent-rig-600" checked={form.secure} onChange={(e) => set('secure', e.target.checked)} />
              Use TLS (secure connection — typically port 465)
            </label>
          </div>
        </section>

        <section className="card p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">Sender Identity</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="From Email">
              <input className="input" type="email" value={form.fromEmail ?? ''} onChange={(e) => set('fromEmail', e.target.value || null)} placeholder="notifications@yourcompany.com" />
            </Field>
            <Field label="From Name">
              <input className="input" value={form.fromName ?? ''} onChange={(e) => set('fromName', e.target.value || null)} placeholder="GTC Oilfield Portal" />
            </Field>
          </div>
        </section>

        <section className="card p-4">
          <h3 className="text-sm font-semibold text-slate-800 mb-3">Send Test Email</h3>
          <p className="text-xs text-slate-500 mb-3">Uses whatever is currently in the form above, even if not saved yet — confirm it works, then Save.</p>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <div className="flex-1">
              <Field label="Send to">
                <input className="input" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
              </Field>
            </div>
            <button className="btn-ghost" onClick={() => void sendTest()} disabled={testBusy || !testTo}>
              <Send size={14} /> {testBusy ? 'Sending…' : 'Send Test Email'}
            </button>
          </div>
          {testResult && <InfoBox>{testResult}</InfoBox>}
        </section>

        <div className="flex justify-end">
          <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save SMTP Configuration</button>
        </div>
      </div>
    </div>
  );
}
