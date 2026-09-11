/**
 * Amount-in-words for an Invoice's Net Amount, in the Indian numbering
 * system (Crore/Lakh/Thousand/Hundred) — matches the reference invoice's
 * "Eighty One Lakh(s) Thirty One Thousand Three Hundred ... Rupees And ...
 * Paise Only" style exactly (including the literal "Lakh(s)" token).
 */

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return `${TENS[t]}${o ? ' ' + ONES[o] : ''}`;
}

function threeDigits(n: number): string {
  if (n === 0) return '';
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return `${h ? ONES[h] + ' Hundred' : ''}${h && rest ? ' ' : ''}${rest ? twoDigits(rest) : ''}`;
}

/** Indian grouping: units in groups of (3, 2, 2, 2, ...) from the right — Hundred, Thousand, Lakh, Crore. */
function integerToWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  const hundred = n;

  const parts: string[] = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore${crore !== 1 ? '(s)' : ''}`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh${lakh !== 1 ? '(s)' : ''}`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (hundred) parts.push(threeDigits(hundred));
  return parts.join(' ');
}

/** e.g. 8131396.23 -> "Eighty One Lakh(s) Thirty One Thousand Three Hundred Ninety Six Rupees And Twenty Three Paise Only". Never used for anything but display. */
export function amountInWords(amount: number): string {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  const rupeeWords = integerToWords(rupees);
  const words = `${rupeeWords} Rupees`;
  if (paise > 0) {
    return `${words} And ${twoDigits(paise)} Paise Only`;
  }
  return `${words} Only`;
}
