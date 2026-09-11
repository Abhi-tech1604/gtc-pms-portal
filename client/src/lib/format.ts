/**
 * Every hour figure is rounded again at the point of display, so a decimal can
 * never reach the screen even if one somehow reached the database (D12).
 */
export function hours(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return Math.round(value).toLocaleString('en-IN');
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return Math.round(value).toLocaleString('en-IN');
}

/** Dates display in one consistent format throughout: 20 Aug 2026. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function date(iso: string | null | undefined): string {
  if (!iso) return '-';
  const s = String(iso).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${date(d.toISOString())} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function monthLabel(month: string | null | undefined): string {
  if (!month) return '-';
  const [y, m] = month.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

export function statusClass(status: string): string {
  switch (status) {
    case 'Overdue': return 'pill-overdue';
    case 'Upcoming': return 'pill-upcoming';
    case 'Breakdown': return 'pill-breakdown';
    case 'Pending': return 'pill-overdue';
    case 'Uploaded': return 'pill-normal';
    case 'Exempt': return 'pill-exempt';
    default: return 'pill-normal';
  }
}

export function todayIso(): string {
  // The server works in Asia/Kolkata; the browser mirrors it for default values.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function currentMonth(): string {
  return todayIso().slice(0, 7);
}
