import type { IfuEquipmentStatus, IfuPriority, IfuStatus } from './types';

/** Badge classes for Internal Follow-up's three status-shaped fields — reuses the shared `.pill` base class (index.css), each with its own color so the three concepts never look interchangeable at a glance. */
export function equipmentStatusPill(status: IfuEquipmentStatus | string): string {
  switch (status) {
    case 'Working': return 'pill bg-emerald-100 text-emerald-800';
    case 'Stopped': return 'pill bg-slate-200 text-slate-700';
    case 'Breakdown': return 'pill bg-red-100 text-red-800';
    case 'Under Maintenance': return 'pill bg-amber-100 text-amber-800';
    default: return 'pill bg-slate-100 text-slate-700';
  }
}

export function priorityPill(priority: IfuPriority | string): string {
  switch (priority) {
    case 'Critical': return 'pill bg-red-100 text-red-800';
    case 'High': return 'pill bg-orange-100 text-orange-800';
    case 'Medium': return 'pill bg-amber-100 text-amber-800';
    case 'Low': return 'pill bg-slate-100 text-slate-700';
    default: return 'pill bg-slate-100 text-slate-700';
  }
}

export function followupStatusPill(status: IfuStatus | string): string {
  switch (status) {
    case 'Open': return 'pill bg-sky-100 text-sky-800';
    case 'In Progress': return 'pill bg-amber-100 text-amber-800';
    case 'Completed': return 'pill bg-emerald-100 text-emerald-800';
    case 'On Hold': return 'pill bg-slate-200 text-slate-700';
    default: return 'pill bg-slate-100 text-slate-700';
  }
}
