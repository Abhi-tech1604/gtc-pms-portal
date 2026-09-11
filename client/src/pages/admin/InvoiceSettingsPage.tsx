import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { rigLabel } from '../../lib/rig';
import type { InvoiceSettings, Rig } from '../../lib/types';
import { ErrorBox, Field, InfoBox, PageHeader, Spinner, useBusy } from '../../components/ui';

const BLANK: Partial<InvoiceSettings> = {
  standbyRatePct: 70, repairRatePct: 60, forceMajeureRate: 0, sgstPercent: 9, cgstPercent: 9,
};

/**
 * Admin > Invoice > Invoice Settings: the one place the contract/commercial
 * terms an invoice needs — Contract No., Accounting Code, our own GSTIN/PAN/
 * bank details, day rates, GST % — are entered, since none of this exists
 * anywhere else in the database. One row per rig; Create Invoice reads this
 * live, and freezes a copy onto every invoice it saves.
 */
export default function InvoiceSettingsPage() {
  const [rigs, setRigs] = useState<Rig[]>([]);
  const [rigId, setRigId] = useState('');
  const [form, setForm] = useState<Partial<InvoiceSettings>>(BLANK);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, run] = useBusy();

  useEffect(() => {
    api.get<{ rigs: Rig[] }>('/rigs').then((d) => setRigs(d.rigs.filter((r) => r.status === 'Active'))).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (!rigId) { setForm(BLANK); setLoaded(false); return; }
    setLoaded(false);
    api.get<{ settings: InvoiceSettings | null }>(`/invoice-settings/${rigId}`)
      .then((d) => { setForm(d.settings ?? BLANK); setLoaded(true); })
      .catch((e) => { setError((e as Error).message); setLoaded(true); });
  }, [rigId]);

  async function save() {
    if (!rigId) return;
    setError(''); setSaved(false);
    try {
      await run(async () => {
        const d = await api.put<{ settings: InvoiceSettings }>(`/invoice-settings/${rigId}`, form);
        setForm(d.settings);
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { setError((e as Error).message); }
  }

  function set<K extends keyof InvoiceSettings>(key: K, value: InvoiceSettings[K]) {
    setForm({ ...form, [key]: value });
  }

  return (
    <div>
      <PageHeader title="Invoice Settings" subtitle="Per-rig contract, day-rate and bank/GST details — configured once here, reused by every invoice for that rig." />
      <ErrorBox message={error} onDismiss={() => setError('')} />
      {saved && <InfoBox>Invoice Settings saved for this rig.</InfoBox>}

      <div className="card p-4 mb-5 max-w-sm">
        <Field label="Rig">
          <select className="input" value={rigId} onChange={(e) => setRigId(e.target.value)}>
            <option value="">Choose a rig...</option>
            {rigs.map((r) => <option key={r.id} value={r.id}>{rigLabel(r)}</option>)}
          </select>
        </Field>
      </div>

      {!rigId ? null : !loaded ? <Spinner /> : (
        <div className="space-y-5">
          <section className="card p-4">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">Contract</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Contract No.">
                <input className="input" value={form.contractNo ?? ''} onChange={(e) => set('contractNo', e.target.value)} />
              </Field>
              <Field label="Accounting Code">
                <input className="input" value={form.accountingCode ?? ''} onChange={(e) => set('accountingCode', e.target.value)} />
              </Field>
              <div className="md:col-span-2">
                <Field label="Client Address / Contact Details" hint="Client name and GSTIN come automatically from Admin > Companies via this rig's assigned company — enter only the address, phone, fax, email lines here.">
                  <textarea className="input" rows={3} value={form.clientAddressBlock ?? ''} onChange={(e) => set('clientAddressBlock', e.target.value)} />
                </Field>
              </div>
              <Field label="Our Address" hint="Printed as this contract's operating/registered address.">
                <textarea className="input" rows={2} value={form.contractorAddress ?? ''} onChange={(e) => set('contractorAddress', e.target.value)} />
              </Field>
              <Field label="Our GSTIN">
                <input className="input" value={form.contractorGstin ?? ''} onChange={(e) => set('contractorGstin', e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="card p-4">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">Day Rates</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="Operating Day Rate" hint="Base rate; Standby/Repair below are computed as a % of this.">
                <input className="input" type="number" min={0} value={form.operatingDayRate ?? ''} onChange={(e) => set('operatingDayRate', e.target.value ? Number(e.target.value) : null)} />
              </Field>
              <Field label="Standby Rate (% of Operating)">
                <input className="input" type="number" min={0} max={100} value={form.standbyRatePct ?? 70} onChange={(e) => set('standbyRatePct', Number(e.target.value))} />
              </Field>
              <Field label="Repair Rate (% of Operating)">
                <input className="input" type="number" min={0} max={100} value={form.repairRatePct ?? 60} onChange={(e) => set('repairRatePct', Number(e.target.value))} />
              </Field>
              <Field label="Force Majeure Rate" hint="Usually 0 — no charge during ILM force majeure.">
                <input className="input" type="number" min={0} value={form.forceMajeureRate ?? 0} onChange={(e) => set('forceMajeureRate', Number(e.target.value))} />
              </Field>
              <Field label="ILM Charge Rate" hint="Lumpsum rate per completed ILM event.">
                <input className="input" type="number" min={0} value={form.ilmChargeRate ?? ''} onChange={(e) => set('ilmChargeRate', e.target.value ? Number(e.target.value) : null)} />
              </Field>
            </div>
          </section>

          <section className="card p-4">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">GST</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-md">
              <Field label="SGST %">
                <input className="input" type="number" min={0} max={100} value={form.sgstPercent ?? 9} onChange={(e) => set('sgstPercent', Number(e.target.value))} />
              </Field>
              <Field label="CGST %">
                <input className="input" type="number" min={0} max={100} value={form.cgstPercent ?? 9} onChange={(e) => set('cgstPercent', Number(e.target.value))} />
              </Field>
            </div>
          </section>

          <section className="card p-4">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">Bank &amp; Signatory Details</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <Field label="Name and Address of contractor as per Bank record">
                  <textarea className="input" rows={2} value={form.bankAccountName ?? ''} onChange={(e) => set('bankAccountName', e.target.value)} />
                </Field>
              </div>
              <div className="md:col-span-2">
                <Field label="Name and Address of Bank with Branch details">
                  <textarea className="input" rows={2} value={form.bankName ?? ''} onChange={(e) => set('bankName', e.target.value)} />
                </Field>
              </div>
              <Field label="Type of Bank A/C">
                <select className="input" value={form.bankAccountType ?? ''} onChange={(e) => set('bankAccountType', e.target.value)}>
                  <option value="">Choose...</option>
                  <option>Current</option>
                  <option>Savings</option>
                  <option>Cash Credit</option>
                </select>
              </Field>
              <Field label="Bank Account Number">
                <input className="input" value={form.bankAccountNumber ?? ''} onChange={(e) => set('bankAccountNumber', e.target.value)} />
              </Field>
              <Field label="IFSC/NEFT Code">
                <input className="input" value={form.bankIfsc ?? ''} onChange={(e) => set('bankIfsc', e.target.value)} />
              </Field>
              <Field label="PAN under Income Tax Act">
                <input className="input" value={form.pan ?? ''} onChange={(e) => set('pan', e.target.value)} />
              </Field>
              <Field label="e-mail address of authorised official">
                <input className="input" type="email" value={form.authorisedEmail ?? ''} onChange={(e) => set('authorisedEmail', e.target.value)} />
              </Field>
              <Field label="Signatory line" hint='e.g. "For, GTC Oilfield Services Limited"'>
                <input className="input" value={form.signatoryCompanyName ?? ''} onChange={(e) => set('signatoryCompanyName', e.target.value)} />
              </Field>
            </div>
          </section>

          <div className="flex justify-end">
            <button className="btn-primary" onClick={() => void save()} disabled={busy}>Save Invoice Settings</button>
          </div>
        </div>
      )}
    </div>
  );
}
