import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { InvoiceRecord } from './invoices.js';

/**
 * Reproduces the reference invoice (2607.xlsx) as closely as ExcelJS/pdfkit
 * allow: same column widths, row heights, borders, light-blue section
 * banding, fonts and number formats, plus the actual GTC letterhead image
 * from that file — not just the same headings/order. Only the VALUES come
 * from `invoices` (an already-frozen, saved record) — never live DRR/DPR/
 * ILM/Settings.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const LETTERHEAD_PATH = path.join(here, '../assets/gtc-letterhead.png');
/** The actual gtc-letterhead.png is 1202x337px — used to size it without distorting the aspect ratio (pdfkit's `image()` does not preserve it automatically when only `width` is given for layout purposes). */
const LETTERHEAD_ASPECT = 337 / 1202;

const N = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "2026-08-31" -> "31.08.2026", matching the reference invoice's date style. */
function ddmmyyyy(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Accent1 (5B9BD5) tinted +0.8, the reference file's actual header-band color. */
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDEEBF7' } };

export async function buildInvoiceExcel(inv: InvoiceRecord): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Invoice', { views: [{ showGridLines: false }] });
  ws.columns = [
    { width: 3 }, { width: 5.5 }, { width: 38 }, { width: 8 }, { width: 9.5 }, { width: 9.5 }, { width: 13.5 }, { width: 14.5 },
  ];
  ws.getRow(2).height = 93.75;
  ws.getRow(9).height = 40;
  ws.getRow(15).height = 30;
  ws.getRow(27).height = 30;
  ws.getRow(28).height = 30;
  ws.getRow(36).height = 30;

  const thin: ExcelJS.Border = { style: 'thin', color: { argb: 'FF000000' } };
  const medium: ExcelJS.Border = { style: 'medium', color: { argb: 'FF000000' } };
  const box: Partial<ExcelJS.Borders> = { top: thin, left: thin, bottom: thin, right: thin };
  const outerBox: Partial<ExcelJS.Borders> = { top: medium, left: medium, bottom: medium, right: medium };
  const center: Partial<ExcelJS.Alignment> = { vertical: 'middle', horizontal: 'center', wrapText: true };
  const left: Partial<ExcelJS.Alignment> = { vertical: 'top', horizontal: 'left', wrapText: true };
  const FONT = 'Calibri';

  function columnsBetween(a: string, b: string): string[] {
    const idx = (s: string) => s.charCodeAt(0) - 64;
    const out: string[] = [];
    for (let i = idx(a); i <= idx(b); i++) out.push(String.fromCharCode(64 + i));
    return out;
  }
  function applyBorder(range: string, border: Partial<ExcelJS.Borders>) {
    const [a, b] = range.split(':');
    const colA = a.match(/[A-Z]+/)![0], rowA = Number(a.match(/\d+/)![0]);
    const colB = (b ?? a).match(/[A-Z]+/)![0], rowB = Number((b ?? a).match(/\d+/)![0]);
    for (let r = rowA; r <= rowB; r++) {
      for (const c of columnsBetween(colA, colB)) ws.getCell(`${c}${r}`).border = border;
    }
  }
  function merge(range: string, value: unknown, opts?: { font?: Partial<ExcelJS.Font>; align?: Partial<ExcelJS.Alignment>; fill?: ExcelJS.Fill; border?: Partial<ExcelJS.Borders> }) {
    if (range.includes(':')) ws.mergeCells(range);
    const anchor = ws.getCell(range.split(':')[0]);
    anchor.value = value as ExcelJS.CellValue;
    anchor.font = { name: FONT, size: 11, ...opts?.font };
    anchor.alignment = opts?.align ?? left;
    if (opts?.fill) anchor.fill = opts.fill;
    if (opts?.border) applyBorder(range, opts.border);
  }

  // Letterhead image, same B2:H2 band the reference file uses.
  if (fs.existsSync(LETTERHEAD_PATH)) {
    const imageId = wb.addImage({ buffer: fs.readFileSync(LETTERHEAD_PATH) as unknown as ExcelJS.Buffer, extension: 'png' });
    ws.addImage(imageId, 'B2:H2');
  }

  merge('B3:H3', 'MONTHLY INVOICE / TAX INVOICE', { font: { bold: true, size: 13 }, align: center, fill: HEADER_FILL, border: outerBox });

  const toBlock = [
    'To,',
    inv.clientName ?? '',
    ...(inv.clientAddressBlock ? inv.clientAddressBlock.split('\n') : []),
    inv.clientGstin ? `GSTIN: ${inv.clientGstin}` : '',
  ].filter(Boolean).join('\n');
  merge('B4:C12', toBlock, { font: { bold: true, size: 12 }, align: left, border: outerBox });

  const headerRows: [string, string][] = [
    ['Invoice No.', inv.invoiceNumber],
    ['Date.', ddmmyyyy(inv.invoiceDate)],
    ['Rig', `${inv.rigName}${inv.rigNumber && inv.rigNumber !== inv.rigName ? ` (${inv.rigNumber})` : ''}`],
    ['Period of Invoice', inv.periodLabel],
    ['Contract No.', inv.contractNo ?? ''],
    ['Address', inv.contractorAddress ?? ''],
    ['GSTIN', inv.contractorGstin ?? ''],
    ['Accounting Code', inv.accountingCode ?? ''],
    ['Well Location', inv.wellLocation ?? ''],
  ];
  headerRows.forEach(([label, value], i) => {
    const row = 4 + i;
    merge(`D${row}:E${row}`, label, { font: { bold: true }, align: left, border: box });
    merge(`F${row}:H${row}`, value, { align: left, border: box });
  });
  applyBorder('B4:H12', outerBox);

  merge('B13:H13', `Sub :- Operation Invoice for the month of ${inv.periodLabel.split(' (')[0].replace("'", '-')}, Under Contract No.${inv.contractNo ?? ''}`, { font: { bold: true }, align: left, border: outerBox });
  merge('B14:H14', 'PRICE ELEMENTS', { font: { bold: true, size: 12 }, align: center, fill: HEADER_FILL, border: outerBox });

  const headers = ['S.No', 'Particulars', 'Total Hrs', 'Qty.', 'UOM', 'Rate ', 'Gross Amount Without GST'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(15, 2 + i);
    cell.value = h;
    cell.font = { name: FONT, size: 11, bold: true };
    cell.alignment = center;
    cell.fill = HEADER_FILL;
    cell.border = box;
  });

  inv.priceLines.forEach((l, i) => {
    const r = 16 + i;
    ws.getCell(`B${r}`).value = l.sNo;
    ws.getCell(`C${r}`).value = l.particulars;
    ws.getCell(`D${r}`).value = l.totalHrs;
    ws.getCell(`E${r}`).value = l.qty;
    ws.getCell(`F${r}`).value = l.uom;
    ws.getCell(`G${r}`).value = l.rate;
    ws.getCell(`H${r}`).value = N(l.grossAmount);
    for (const c of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) {
      const cell = ws.getCell(`${c}${r}`);
      cell.border = box;
      cell.font = { name: FONT, size: 11 };
      cell.alignment = c === 'B' || c === 'D' || c === 'E' || c === 'F' ? center : (c === 'C' ? left : { vertical: 'middle', horizontal: 'right' });
    }
    ws.getCell(`D${r}`).numFmt = '0.00';
    ws.getCell(`E${r}`).numFmt = '0.000';
    ws.getCell(`G${r}`).numFmt = '#,##0.00';
    ws.getCell(`H${r}`).numFmt = '#,##0.00';
  });
  applyBorder('B15:H20', outerBox);

  merge('B21:G21', 'Total Amount (INR) Rs.', { font: { bold: true }, align: left, border: box });
  ws.getCell('H21').value = N(inv.totalAmount); ws.getCell('H21').numFmt = '#,##0.00';
  ws.getCell('H21').border = box; ws.getCell('H21').font = { name: FONT, size: 11, bold: true };
  ws.getCell('H21').alignment = { vertical: 'middle', horizontal: 'right' };

  merge('B22:G22', `Add SGST ${inv.sgstPercent}%`, { align: left, border: box });
  ws.getCell('H22').value = N(inv.sgstAmount); ws.getCell('H22').numFmt = '#,##0.00';
  ws.getCell('H22').border = box; ws.getCell('H22').font = { name: FONT, size: 11 };
  ws.getCell('H22').alignment = { vertical: 'middle', horizontal: 'right' };

  merge('B23:G23', `Add CGST ${inv.cgstPercent}%`, { align: left, border: box });
  ws.getCell('H23').value = N(inv.cgstAmount); ws.getCell('H23').numFmt = '#,##0.00';
  ws.getCell('H23').border = box; ws.getCell('H23').font = { name: FONT, size: 11 };
  ws.getCell('H23').alignment = { vertical: 'middle', horizontal: 'right' };

  merge('B24:G24', 'Net Amount Including GST (INR) Rs. ', { font: { bold: true }, align: left, fill: HEADER_FILL, border: box });
  ws.getCell('H24').value = N(inv.netAmount); ws.getCell('H24').numFmt = '#,##0.00';
  ws.getCell('H24').border = box; ws.getCell('H24').font = { name: FONT, size: 11, bold: true };
  ws.getCell('H24').alignment = { vertical: 'middle', horizontal: 'right' };
  ws.getCell('H24').fill = HEADER_FILL;
  applyBorder('B21:H24', outerBox);

  merge('B25:H25', inv.amountInWords, { font: { bold: true, italic: true, size: 12 }, align: left, border: outerBox });

  merge('B26:C26', 'Bank Details for Payment', { font: { bold: true }, align: left, border: box });
  merge('D26:H26', `Invoice shall be due for payment for the month of ${inv.periodLabel.split(' (')[0].replace("'", '-')}`, { align: left, border: box });

  const footerRows: [string, string][] = [
    ['Name and Address of contractor as per Bank record', inv.bankAccountName ?? ''],
    ['Name and Address of Bank with Branch details', inv.bankName ?? ''],
    ['Type of Bank A/C:Current/Savings/Cash Credit', inv.bankAccountType ?? ''],
    ['Bank Account Number', inv.bankAccountNumber ?? ''],
    ['IFSC/NEFT Code(11 Digitcode)', inv.bankIfsc ?? ''],
    ['PAN under Income Tax Act', inv.pan ?? ''],
    ['GST Regn. No.', inv.contractorGstin ?? ''],
    ['e-mail address of authorised official', inv.authorisedEmail ?? ''],
  ];
  footerRows.forEach(([label, value], i) => {
    const row = 27 + i;
    merge(`B${row}:C${row}`, label, { align: left, border: box });
    merge(`D${row}:H${row}`, value, { align: left, border: box });
  });
  applyBorder('B26:H34', outerBox);

  merge('B35:H35', inv.signatoryCompanyName ?? '', { font: { bold: true, size: 13 }, align: center, border: outerBox });
  merge('B36:H36', 'Authorized Signatory', { font: { bold: true }, align: center, border: outerBox });

  if (inv.remarks) {
    ws.getCell('B37').value = `Remarks: ${inv.remarks}`;
    ws.getCell('B37').font = { name: FONT, italic: true };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * A PDF reproduction of the same reference layout — the actual letterhead
 * image, light-blue section bands, and a bordered table — not just plain
 * text, so Print/Generate PDF match the Excel/on-screen invoice.
 */
export function buildInvoicePdf(inv: InvoiceRecord): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width - 72;
    const x0 = 36;
    const HEADER_BAND = '#dbe9f7';

    if (fs.existsSync(LETTERHEAD_PATH)) {
      // pdfkit's image() never advances doc.y itself, so the next element
      // must be placed explicitly below the image's actual rendered height
      // (computed from its real pixel aspect ratio) or it gets drawn on top.
      const letterheadTop = doc.y;
      const letterheadHeight = pageW * LETTERHEAD_ASPECT;
      doc.image(LETTERHEAD_PATH, x0, letterheadTop, { width: pageW });
      doc.y = letterheadTop + letterheadHeight + 8;
    }

    function band(text: string, height = 20, size = 12) {
      const y = doc.y;
      doc.rect(x0, y, pageW, height).fillAndStroke(HEADER_BAND, '#000000');
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(size).text(text, x0, y + (height - size) / 2 - 1, { width: pageW, align: 'center' });
      doc.y = y + height + 4;
    }

    band('MONTHLY INVOICE / TAX INVOICE', 22, 13);

    const boxTop = doc.y;
    doc.rect(x0, boxTop, pageW, 130).stroke();
    doc.moveTo(x0 + pageW * 0.45, boxTop).lineTo(x0 + pageW * 0.45, boxTop + 130).stroke();

    doc.fontSize(9).font('Helvetica-Bold').text('To,', x0 + 6, boxTop + 6, { width: pageW * 0.42 });
    doc.font('Helvetica-Bold').fontSize(10).text(inv.clientName ?? '', x0 + 6, doc.y, { width: pageW * 0.42 });
    doc.font('Helvetica').fontSize(9);
    if (inv.clientAddressBlock) doc.text(inv.clientAddressBlock, x0 + 6, doc.y, { width: pageW * 0.42 });
    if (inv.clientGstin) doc.text(`GSTIN: ${inv.clientGstin}`, x0 + 6, doc.y, { width: pageW * 0.42 });

    const pairs: [string, string][] = [
      ['Invoice No.', inv.invoiceNumber], ['Date.', ddmmyyyy(inv.invoiceDate)],
      ['Rig', `${inv.rigName}${inv.rigNumber && inv.rigNumber !== inv.rigName ? ` (${inv.rigNumber})` : ''}`],
      ['Period of Invoice', inv.periodLabel], ['Contract No.', inv.contractNo ?? '-'], ['Address', inv.contractorAddress ?? '-'],
      ['GSTIN', inv.contractorGstin ?? '-'], ['Accounting Code', inv.accountingCode ?? '-'], ['Well Location', inv.wellLocation ?? '-'],
    ];
    let py = boxTop + 6;
    const rx = x0 + pageW * 0.45 + 6;
    const rw = pageW * 0.55 - 12;
    for (const [label, value] of pairs) {
      doc.font('Helvetica-Bold').fontSize(8).text(label, rx, py, { width: rw, continued: false });
      doc.font('Helvetica').fontSize(8.5).text(value, rx + 90, py, { width: rw - 90 });
      py = Math.max(py + 12, doc.y);
    }
    doc.y = boxTop + 130 + 6;

    doc.font('Helvetica').fontSize(9).text(
      `Sub :- Operation Invoice for the month of ${inv.periodLabel.split(' (')[0].replace("'", '-')}, Under Contract No.${inv.contractNo ?? ''}`,
      x0, doc.y, { width: pageW },
    );
    doc.moveDown(0.5);

    band('PRICE ELEMENTS', 18, 11);

    const colW = [30, pageW - 30 - 55 - 45 - 35 - 55 - 90, 55, 45, 35, 55, 90];
    const colX: number[] = [x0];
    for (let i = 0; i < colW.length - 1; i++) colX.push(colX[i] + colW[i]);
    const headers = ['S.No', 'Particulars', 'Total Hrs', 'Qty.', 'UOM', 'Rate', 'Gross Amt'];

    const tableTop = doc.y;
    doc.rect(x0, tableTop, pageW, 18).fillAndStroke(HEADER_BAND, '#000000');
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
    headers.forEach((h, i) => doc.text(h, colX[i] + 2, tableTop + 5, { width: colW[i] - 4, align: i >= 2 ? 'right' : 'left' }));
    let rowY = tableTop + 18;

    doc.font('Helvetica').fontSize(8.5);
    for (const l of inv.priceLines) {
      const rowH = 16;
      doc.rect(x0, rowY, pageW, rowH).stroke();
      const cells = [String(l.sNo), l.particulars, l.totalHrs.toFixed(2), l.qty.toFixed(3), l.uom, N(l.rate).toLocaleString('en-IN'), N(l.grossAmount).toLocaleString('en-IN')];
      cells.forEach((c, i) => doc.text(c, colX[i] + 2, rowY + 4, { width: colW[i] - 4, align: i >= 2 ? 'right' : 'left' }));
      rowY += rowH;
    }
    doc.y = rowY + 6;

    const totals: [string, string, boolean][] = [
      ['Total Amount (INR) Rs.', N(inv.totalAmount).toLocaleString('en-IN'), true],
      [`Add SGST ${inv.sgstPercent}%`, N(inv.sgstAmount).toLocaleString('en-IN'), false],
      [`Add CGST ${inv.cgstPercent}%`, N(inv.cgstAmount).toLocaleString('en-IN'), false],
      ['Net Amount Including GST (INR) Rs.', N(inv.netAmount).toLocaleString('en-IN'), true],
    ];
    for (const [label, value, bold] of totals) {
      const y = doc.y;
      doc.rect(x0, y, pageW, 16).stroke();
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(label, x0 + 4, y + 4, { width: pageW - 100 });
      doc.text(value, x0 + pageW - 96, y + 4, { width: 92, align: 'right' });
      doc.y = y + 16;
    }

    const wordsY = doc.y;
    doc.rect(x0, wordsY, pageW, 24).stroke();
    doc.font('Helvetica-BoldOblique').fontSize(9.5).text(inv.amountInWords, x0 + 4, wordsY + 6, { width: pageW - 8 });
    doc.y = wordsY + 24 + 6;

    band('Bank Details for Payment', 16, 10);

    const footer: [string, string][] = [
      ['Name and Address of contractor as per Bank record', inv.bankAccountName ?? '-'],
      ['Name and Address of Bank with Branch details', inv.bankName ?? '-'],
      ['Type of Bank A/C', inv.bankAccountType ?? '-'],
      ['Bank Account Number', inv.bankAccountNumber ?? '-'],
      ['IFSC/NEFT Code', inv.bankIfsc ?? '-'],
      ['PAN under Income Tax Act', inv.pan ?? '-'],
      ['GST Regn. No.', inv.contractorGstin ?? '-'],
      ['e-mail address of authorised official', inv.authorisedEmail ?? '-'],
    ];
    doc.fontSize(8.5);
    for (const [label, value] of footer) {
      doc.font('Helvetica-Bold').text(`${label}: `, x0, doc.y, { continued: true, width: pageW }).font('Helvetica').text(value);
    }
    if (inv.remarks) { doc.moveDown(0.4); doc.font('Helvetica-Oblique').fontSize(8.5).text(`Remarks: ${inv.remarks}`, x0, doc.y, { width: pageW }); }

    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(11).text(inv.signatoryCompanyName ?? '', x0, doc.y, { width: pageW, align: 'center' });
    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').fontSize(10).text('Authorized Signatory', x0, doc.y, { width: pageW, align: 'center' });

    doc.end();
  });
}
