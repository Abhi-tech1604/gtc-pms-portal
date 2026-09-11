import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileSpreadsheet, FileText, Printer, XCircle } from 'lucide-react';
import { api, download } from '../../lib/api';
import { count, date } from '../../lib/format';
import type { Invoice } from '../../lib/types';
import { ConfirmDialog, ErrorBox, PageHeader, Spinner, useBusy } from '../../components/ui';
import gtcLetterhead from '../../assets/gtc-letterhead.png';

const BAND = 'bg-sky-100';

/** Full invoice detail, laid out and styled to match the reference invoice (2607.xlsx) exactly — the actual GTC letterhead, light-blue section bands, bordered "To,"/header block, Price Elements table, GST/Net totals, amount in words, then the bank/GST/signatory footer. */
export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, run] = useBusy();
  const [downloadBusy, runDownload] = useBusy();

  async function load() {
    if (!id) return;
    const d = await api.get<{ invoice: Invoice }>(`/invoices/${id}`);
    setInvoice(d.invoice);
  }

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [id]);

  async function cancelInvoice() {
    if (!id) return;
    try {
      await run(async () => { await api.put(`/invoices/${id}/cancel`); await load(); });
      setConfirmCancel(false);
    } catch (e) { setError((e as Error).message); }
  }

  if (!invoice) return <Spinner />;

  return (
    <div>
      <PageHeader
        title={invoice.invoiceNumber}
        subtitle={`${invoice.rigName} — ${invoice.periodLabel}`}
        actions={
          <div className="flex gap-2 no-print">
            <button className="btn-ghost" onClick={() => window.print()}><Printer size={14} /> Print</button>
            <button className="btn-ghost" disabled={downloadBusy}
              onClick={() => void runDownload(() => download(`/invoices/${invoice.id}/excel`, `${invoice.invoiceNumber.replace(/\//g, '-')}.xlsx`))}>
              <FileSpreadsheet size={14} /> Download Excel
            </button>
            <button className="btn-ghost" disabled={downloadBusy}
              onClick={() => void runDownload(() => download(`/invoices/${invoice.id}/pdf`, `${invoice.invoiceNumber.replace(/\//g, '-')}.pdf`))}>
              <FileText size={14} /> Generate PDF
            </button>
            {invoice.status === 'Final' && (
              <button className="btn-danger" onClick={() => setConfirmCancel(true)}><XCircle size={14} /> Cancel Invoice</button>
            )}
          </div>
        }
      />
      <ErrorBox message={error} onDismiss={() => setError('')} />

      {invoice.status === 'Cancelled' && (
        <div className="mb-4 rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-700 no-print">
          This invoice has been cancelled. Its figures are preserved for history but it is not payable.
        </div>
      )}

      <div className="invoice-print-area card p-0 max-w-4xl overflow-hidden border border-slate-900">
        <img src={gtcLetterhead} alt="GTC Oilfield Services Limited" className="w-full block" />

        <h2 className={`text-center text-base font-bold py-2 border-y border-slate-900 ${BAND}`}>MONTHLY INVOICE / TAX INVOICE</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 text-sm border-b border-slate-900">
          <div className="whitespace-pre-line p-3 border-r border-slate-900 font-semibold">
            To,
            {'\n'}{invoice.clientName}
            {invoice.clientAddressBlock ? `\n${invoice.clientAddressBlock}` : ''}
            {invoice.clientGstin ? `\nGSTIN: ${invoice.clientGstin}` : ''}
          </div>
          <div>
            <LV label="Invoice No." value={invoice.invoiceNumber} />
            <LV label="Date." value={date(invoice.invoiceDate)} />
            <LV label="Rig" value={`${invoice.rigName}${invoice.rigNumber && invoice.rigNumber !== invoice.rigName ? ` (${invoice.rigNumber})` : ''}`} />
            <LV label="Period of Invoice" value={invoice.periodLabel} />
            <LV label="Contract No." value={invoice.contractNo} />
            <LV label="Address" value={invoice.contractorAddress} />
            <LV label="GSTIN" value={invoice.contractorGstin} />
            <LV label="Accounting Code" value={invoice.accountingCode} />
            <LV label="Well Location" value={invoice.wellLocation} last />
          </div>
        </div>

        <div className="text-sm px-3 py-2 border-b border-slate-900">
          Sub :- Operation Invoice for the month of {invoice.periodLabel.split(' (')[0].replace("'", '-')}, Under Contract No.{invoice.contractNo ?? ''}
        </div>

        <h3 className={`text-center font-semibold py-1 text-sm border-b border-slate-900 ${BAND}`}>PRICE ELEMENTS</h3>
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className={BAND}>
              <Th>S.No</Th><Th>Particulars</Th><Th align="right">Total Hrs</Th>
              <Th align="right">Qty.</Th><Th>UOM</Th><Th align="right">Rate</Th>
              <Th align="right">Gross Amount Without GST</Th>
            </tr>
          </thead>
          <tbody>
            {invoice.priceLines.map((l) => (
              <tr key={l.sNo}>
                <Td align="center">{l.sNo}</Td>
                <Td>{l.particulars}</Td>
                <Td align="right">{l.totalHrs.toFixed(2)}</Td>
                <Td align="right">{l.qty.toFixed(3)}</Td>
                <Td align="center">{l.uom}</Td>
                <Td align="right">{count(l.rate)}</Td>
                <Td align="right">{count(l.grossAmount)}</Td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="text-sm border-t border-slate-900">
          <TotalRow label="Total Amount (INR) Rs." value={count(invoice.totalAmount)} bold />
          <TotalRow label={`Add SGST ${invoice.sgstPercent}%`} value={count(invoice.sgstAmount)} />
          <TotalRow label={`Add CGST ${invoice.cgstPercent}%`} value={count(invoice.cgstAmount)} />
          <TotalRow label="Net Amount Including GST (INR) Rs." value={count(invoice.netAmount)} bold shaded />
        </div>

        <div className="text-sm italic font-semibold px-3 py-2 border-b border-slate-900">{invoice.amountInWords}</div>

        {invoice.remarks && <div className="text-sm px-3 py-2 border-b border-slate-900"><span className="font-semibold">Remarks: </span>{invoice.remarks}</div>}

        <div className="text-sm">
          <div className={`font-semibold px-3 py-1 border-b border-slate-900 ${BAND}`}>Bank Details for Payment</div>
          <LV label="Name and Address of contractor as per Bank record" value={invoice.bankAccountName} />
          <LV label="Name and Address of Bank with Branch details" value={invoice.bankName} />
          <LV label="Type of Bank A/C" value={invoice.bankAccountType} />
          <LV label="Bank Account Number" value={invoice.bankAccountNumber} />
          <LV label="IFSC/NEFT Code" value={invoice.bankIfsc} />
          <LV label="PAN under Income Tax Act" value={invoice.pan} />
          <LV label="GST Regn. No." value={invoice.contractorGstin} />
          <LV label="e-mail address of authorised official" value={invoice.authorisedEmail} last />
        </div>

        <div className="text-center text-sm py-6">
          <div className="font-semibold text-base">{invoice.signatoryCompanyName}</div>
          <div className="mt-10 font-medium">Authorized Signatory</div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this invoice?"
        body={<>Cancelling <strong>{invoice.invoiceNumber}</strong> keeps its historical values but marks it Cancelled — it will no longer count toward the Invoice Dashboard's totals.</>}
        confirmLabel="Cancel Invoice"
        tone="danger"
        busy={busy}
        onConfirm={() => void cancelInvoice()}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  );
}

function LV({ label, value, last }: { label: string; value: string | null; last?: boolean }) {
  return (
    <div className={`flex gap-3 px-3 py-1 ${last ? '' : 'border-b border-slate-300'}`}>
      <span className="text-slate-600 shrink-0">{label}:</span>
      <span className="whitespace-pre-line font-medium">{value || '-'}</span>
    </div>
  );
}

function TotalRow({ label, value, bold, shaded }: { label: string; value: string; bold?: boolean; shaded?: boolean }) {
  return (
    <div className={`flex justify-between px-3 py-1 border-b border-slate-900 ${bold ? 'font-semibold' : ''} ${shaded ? BAND : ''}`}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

const ALIGN_CLASS = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return <th className={`border border-slate-900 px-2 py-1 font-semibold ${ALIGN_CLASS[align]}`}>{children}</th>;
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return <td className={`border border-slate-900 px-2 py-1 ${ALIGN_CLASS[align]}`}>{children}</td>;
}
