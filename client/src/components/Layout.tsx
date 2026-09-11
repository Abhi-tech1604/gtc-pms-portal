import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity, Bell, Building2, CalendarCheck, ChevronDown, ChevronRight, ClipboardCheck, ClipboardList, Cog, Factory,
  FileSpreadsheet, FlaskConical, Fuel, Gauge, Grid3x3, HeartPulse, History, IndianRupee, KeyRound, LayoutList, LogOut,
  Mail, Package, PackageOpen, Plus, Repeat, Ruler, ScrollText, Settings, ShieldCheck, SlidersHorizontal, Truck, UploadCloud,
  Users, Wrench,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import type { ModuleCode, PermissionFlag } from '../lib/types';
import { MODULE_LABELS } from '../lib/types';
import { ErrorBox, Field, InfoBox, Modal, useBusy } from './ui';
import NotificationBell from './NotificationBell';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Gauge;
  /** PMS-area flag gate (Logs group's items) — unrelated to the Admin-page gate below. */
  right?: PermissionFlag;
  /**
   * The Admin > User Rights page this item is delegable through — an Admin
   * always sees every item regardless; a non-Admin sees it once granted View
   * on this exact (module, page). Items with neither stay Admin-role-only —
   * there is no page in the matrix yet for them (Manpower Roster, ILM
   * Contract Duration Rules, Demo Data, the DRR admin screens).
   */
  moduleCode?: ModuleCode;
  pageKey?: string;
}

/**
 * PMS's rig-user-facing sidebar is deliberately a short list — PMS is a
 * maintenance module, not another daily-entry system (DRR owns daily entry).
 * Everything else that used to live here (Mechanical Logs' Excel upload,
 * System Reports, Audit Registers, Companies, Material Transfers, Rig
 * Holidays) is only reachable from the Admin area's "Logs" group / top-level
 * "Reports" item — still fully functional, just not part of the daily
 * rig-user flow. "Status" was removed from this list per the Sept 2026
 * sidebar reorganization; the /status route itself is untouched.
 */
const MAIN: NavItem[] = [
  { to: '/equipment', label: 'Equipment Directory', icon: LayoutList },
  { to: '/healthcheckup', label: 'Health Checkup', icon: HeartPulse },
  { to: '/service-history', label: 'Service History', icon: History },
];

/** Admin sidebar: only "Dashboard" stays top-level; everything else lives in a group below. Admin-role-only — /admin's own dashboard has no page in the matrix to delegate through. */
const ADMIN_NAV = [
  { to: '/admin', label: 'Dashboard', icon: Gauge, end: true },
];

const ADMIN_MODULES: NavItem = { to: '/admin/modules', label: 'Modules', icon: Grid3x3, moduleCode: 'ADMIN', pageKey: 'modules' };
const ADMIN_NOTIFICATION_SETTINGS: NavItem = { to: '/admin/notification-settings', label: 'Notification Settings', icon: Bell, moduleCode: 'ADMIN', pageKey: 'notification_settings' };
const ADMIN_SMTP_SETTINGS: NavItem = { to: '/admin/smtp-settings', label: 'SMTP Configuration', icon: Mail, moduleCode: 'ADMIN', pageKey: 'smtp_settings' };
const ADMIN_RIG_MASTER: NavItem = { to: '/admin/rigs', label: 'Rig Master', icon: Factory, moduleCode: 'ADMIN', pageKey: 'rig_master' };
const ADMIN_EQUIPMENT_MASTER: NavItem = { to: '/admin/equipment-master', label: 'Equipment Master', icon: LayoutList, moduleCode: 'ADMIN', pageKey: 'equipment_master' };
const ADMIN_MATERIAL_MASTER: NavItem = { to: '/admin/material-master', label: 'Material Master', icon: Cog, moduleCode: 'ADMIN', pageKey: 'material_master' };
const ADMIN_TRANSFER_EQUIPMENT: NavItem = { to: '/admin/transfer-equipment', label: 'Transfer Equipment', icon: Repeat, moduleCode: 'ADMIN', pageKey: 'transfer_equipment' };
const ADMIN_OIL_LUBRICANT_MASTER: NavItem = { to: '/admin/oil-lubricants', label: 'Oil & Lubricant Master', icon: PackageOpen, moduleCode: 'ADMIN', pageKey: 'oil_lubricant_master' };
/** No page in the matrix yet — these three stay Admin-role-only regardless of what a non-Admin is granted. */
const ADMIN_MANPOWER_ROSTER: NavItem = { to: '/admin/manpower-roster', label: 'Manpower Roster', icon: Users };
const ADMIN_ILM_CONTRACT_DURATION_RULES: NavItem = { to: '/admin/ilm-contract-duration-rules', label: 'ILM Contract Duration Rules', icon: Ruler };
const ADMIN_DEMO_DATA: NavItem = { to: '/admin/demo-data', label: 'Demo Data', icon: FlaskConical };

/** "Master" group: Modules + Notification Settings + the existing master-data screens. */
const ADMIN_MASTER: NavItem[] = [
  ADMIN_MODULES,
  ADMIN_NOTIFICATION_SETTINGS,
  ADMIN_SMTP_SETTINGS,
  ADMIN_RIG_MASTER,
  ADMIN_EQUIPMENT_MASTER,
  ADMIN_MATERIAL_MASTER,
  ADMIN_TRANSFER_EQUIPMENT,
  ADMIN_OIL_LUBRICANT_MASTER,
  ADMIN_MANPOWER_ROSTER,
  ADMIN_ILM_CONTRACT_DURATION_RULES,
  ADMIN_DEMO_DATA,
];

/** "Create User" group. */
const ADMIN_CREATE_USER: NavItem[] = [
  { to: '/admin/users', label: 'Users', icon: Users, moduleCode: 'ADMIN', pageKey: 'users' },
  { to: '/admin/user-rights', label: 'User Rights', icon: ShieldCheck, moduleCode: 'ADMIN', pageKey: 'user_rights' },
];

/** "Logs" group — renamed from "Reports & Tools"; "System Reports" moved out to the top-level "Reports" item below. Gated per item by the same PMS flag its route itself checks (spec 5.2), not by the Admin-page matrix — these are PMS-area routes surfaced here for convenience. */
const ADMIN_LOGS: NavItem[] = [
  { to: '/mechanical-logs', label: 'Mechanical Logs', icon: FileSpreadsheet },
  { to: '/audit', label: 'Audit Registers', icon: ScrollText, right: 'canViewAuditLogs' },
  { to: '/companies', label: 'Companies', icon: Building2 },
  { to: '/transfers', label: 'Material Transfers', icon: Truck, right: 'canManageTransfers' },
  { to: '/holidays', label: 'Rig Holidays', icon: PackageOpen, right: 'canManageHolidays' },
];

/** New top-level "Reports" item — same /reports page previously nested as "System Reports". Dual-mapped (PMS.reports and ADMIN.reports both resolve it) since /reports is reachable from both areas — visibility is computed inline, not via moduleCode/pageKey. */
const ADMIN_REPORTS: NavItem = { to: '/reports', label: 'Reports', icon: ClipboardList };

/** "Follow-up" group — the standalone rig/equipment issue-tracking module. Every follow-up screen lives only here, nowhere else in Admin. */
const ADMIN_FOLLOWUP: NavItem[] = [
  { to: '/admin/followup', label: 'Follow-up Dashboard', icon: Gauge, moduleCode: 'FOLLOWUP', pageKey: 'dashboard' },
  { to: '/admin/followup/new', label: 'New Follow-up', icon: Plus, moduleCode: 'FOLLOWUP', pageKey: 'new' },
  { to: '/admin/followup/history', label: 'Follow-up History', icon: History, moduleCode: 'FOLLOWUP', pageKey: 'history' },
];

/** "Invoice" group — monthly invoice generation, read from Rig Master/Companies/DRR/DPR/ILM and per-rig Invoice Settings. Every invoice screen lives only here. */
const ADMIN_INVOICE: NavItem[] = [
  { to: '/admin/invoice', label: 'Invoice Dashboard', icon: Gauge, moduleCode: 'INVOICE', pageKey: 'dashboard' },
  { to: '/admin/invoice/new', label: 'Create Invoice', icon: Plus, moduleCode: 'INVOICE', pageKey: 'create' },
  { to: '/admin/invoice/history', label: 'Invoice History', icon: History, moduleCode: 'INVOICE', pageKey: 'history' },
  { to: '/admin/invoice/settings', label: 'Invoice Settings', icon: Settings, moduleCode: 'INVOICE', pageKey: 'settings' },
];

/** Admin-only DRR Excel Import — never rendered outside area === 'ADMIN', so it is structurally invisible to Rig Users. */
const ADMIN_DRR_IMPORT: NavItem = { to: '/admin/drr-import', label: 'Excel Import', icon: UploadCloud };
const ADMIN_DRR_RESPONSIBILITY: NavItem = { to: '/admin/drr-rig-responsibility', label: 'Rig Responsibility', icon: Users };

const MODULE_ICONS: Record<'PMS' | 'DPR' | 'ILM' | 'DRR', typeof Activity> = { PMS: Activity, DPR: ClipboardList, ILM: Package, DRR: ClipboardCheck };

type ActiveArea = 'PMS' | 'DPR' | 'ILM' | 'DRR' | 'ADMIN';

function areaFromPath(pathname: string): ActiveArea {
  if (pathname.startsWith('/dpr')) return 'DPR';
  if (pathname.startsWith('/ilm')) return 'ILM';
  if (pathname.startsWith('/drr')) return 'DRR';
  if (pathname.startsWith('/admin')) return 'ADMIN';
  return 'PMS';
}

export default function Layout() {
  const { user, signOut, can, canPage, hasModule, hasModuleAction, isAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [adminMasterOpen, setAdminMasterOpen] = useState(true);
  const [adminCreateUserOpen, setAdminCreateUserOpen] = useState(false);
  const [adminLogsOpen, setAdminLogsOpen] = useState(false);
  const [adminDrrOpen, setAdminDrrOpen] = useState(false);
  const [adminFollowupOpen, setAdminFollowupOpen] = useState(false);
  const [adminInvoiceOpen, setAdminInvoiceOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const visible = (item: NavItem) => !item.right || can(item.right);

  /** An Admin sees every item unconditionally; a non-Admin sees it once granted View on its exact (module, page) — items with neither stay Admin-role-only. */
  const canSeeAdminItem = (item: NavItem) =>
    isAdmin || (!!item.moduleCode && !!item.pageKey && canPage(item.moduleCode, item.pageKey, 'view'));

  const dprCanView = hasModuleAction('DPR', 'view');

  const ilmCanView = hasModuleAction('ILM', 'view');

  const drrCanView = hasModuleAction('DRR', 'view');
  const drrCanCreate = hasModuleAction('DRR', 'create');

  /** /reports is reachable from both the PMS area (canManageReports) and the Admin area (ADMIN.reports) — either is enough. */
  const reportsVisible = isAdmin || can('canManageReports') || canPage('ADMIN', 'reports', 'view');
  const logsGroupVisible = isAdmin || canPage('ADMIN', 'logs', 'view');
  const visibleAdminMaster = ADMIN_MASTER.filter(canSeeAdminItem);
  const visibleAdminCreateUser = ADMIN_CREATE_USER.filter(canSeeAdminItem);
  const visibleAdminFollowup = ADMIN_FOLLOWUP.filter(canSeeAdminItem);
  const visibleAdminInvoice = ADMIN_INVOICE.filter(canSeeAdminItem);
  const visibleAdminLogs = ADMIN_LOGS.filter(visible);

  /** Whether this account can enter the Admin sidebar area at all — an Admin always can; a non-Admin can once delegated at least one page somewhere inside it. */
  const canEnterAdminArea = isAdmin
    || visibleAdminMaster.length > 0
    || visibleAdminCreateUser.length > 0
    || visibleAdminFollowup.length > 0
    || visibleAdminInvoice.length > 0
    || reportsVisible
    || logsGroupVisible;

  const area = areaFromPath(location.pathname);
  const switcherModules = (['PMS', 'DPR', 'ILM', 'DRR'] as const).filter((code) => hasModule(code));
  const brandLabel = area === 'ADMIN' && canEnterAdminArea ? 'Admin Panel' : area === 'PMS' ? 'PMS Portal' : MODULE_LABELS[area === 'ADMIN' ? 'PMS' : area];

  return (
    <div className="flex h-full min-h-screen">
      <aside className="w-60 shrink-0 bg-slate-900 text-slate-300 flex flex-col">
        <div className="px-4 py-4 border-b border-slate-800">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-white min-w-0">
              <Activity size={20} className="text-rig-400 shrink-0" />
              <span className="font-semibold tracking-tight truncate">{brandLabel}</span>
            </div>
            {/* Every area now generates its own notifications (DRR approval, PMS service/health-check, ...), so the bell is no longer PMS-only — "Left Sidebar -> Notifications" for every role. */}
            <NotificationBell />
          </div>
          <div className="text-[11px] text-slate-500 mt-1">GTC Oilfield Pvt Ltd</div>
        </div>

        {(switcherModules.length > 1 || canEnterAdminArea) && (
          <div className="px-2 py-2 border-b border-slate-800 flex flex-wrap gap-1">
            {canEnterAdminArea && (
              <button
                onClick={() => navigate('/admin')}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium ${
                  area === 'ADMIN' ? 'bg-rig-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <ShieldCheck size={11} /> Admin
              </button>
            )}
            {switcherModules.map((code) => {
              const Icon = MODULE_ICONS[code];
              const active = area === code;
              return (
                <button
                  key={code}
                  onClick={() => navigate(code === 'PMS' ? '/' : code === 'DPR' ? '/dpr/operational-data' : code === 'ILM' ? '/ilm' : '/drr')}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium ${
                    active ? 'bg-rig-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <Icon size={11} /> {code}
                </button>
              );
            })}
            <button
              onClick={() => navigate('/select-module')}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-slate-800 text-slate-300 hover:bg-slate-700"
              title="All modules"
            >
              <SlidersHorizontal size={11} />
            </button>
          </div>
        )}

        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5 text-sm">
          {area === 'ADMIN' && canEnterAdminArea ? (
            <>
              {ADMIN_NAV.filter(canSeeAdminItem).map((item) => (
                <Item key={item.to} to={item.to} label={item.label} icon={item.icon} end={item.end} />
              ))}
              {visibleAdminMaster.length > 0 && (
                <div>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-slate-800 text-slate-300"
                    onClick={() => setAdminMasterOpen((v) => !v)}
                  >
                    <LayoutList size={16} />
                    <span className="flex-1 text-left">Master</span>
                    {adminMasterOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  {adminMasterOpen && (
                    <div className="ml-4 border-l border-slate-800 pl-2 space-y-0.5">
                      {visibleAdminMaster.map((item) => (
                        <Item key={item.to} to={item.to} label={item.label} icon={item.icon} />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {visibleAdminCreateUser.length > 0 && (
                <div>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-slate-800 text-slate-300"
                    onClick={() => setAdminCreateUserOpen((v) => !v)}
                  >
                    <Users size={16} />
                    <span className="flex-1 text-left">Create User</span>
                    {adminCreateUserOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  {adminCreateUserOpen && (
                    <div className="ml-4 border-l border-slate-800 pl-2 space-y-0.5">
                      {visibleAdminCreateUser.map((item) => (
                        <Item key={item.to} to={item.to} label={item.label} icon={item.icon} />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {logsGroupVisible && visibleAdminLogs.length > 0 && (
                <div>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-slate-800 text-slate-300"
                    onClick={() => setAdminLogsOpen((v) => !v)}
                  >
                    <ScrollText size={16} />
                    <span className="flex-1 text-left">Logs</span>
                    {adminLogsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  {adminLogsOpen && (
                    <div className="ml-4 border-l border-slate-800 pl-2 space-y-0.5">
                      {visibleAdminLogs.map((item) => (
                        <Item key={item.to} to={item.to} label={item.label} icon={item.icon} />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {reportsVisible && <Item to={ADMIN_REPORTS.to} label={ADMIN_REPORTS.label} icon={ADMIN_REPORTS.icon} />}
              {visibleAdminFollowup.length > 0 && (
                <div>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-slate-800 text-slate-300"
                    onClick={() => setAdminFollowupOpen((v) => !v)}
                  >
                    <Wrench size={16} />
                    <span className="flex-1 text-left">Follow-up</span>
                    {adminFollowupOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  {adminFollowupOpen && (
                    <div className="ml-4 border-l border-slate-800 pl-2 space-y-0.5">
                      {visibleAdminFollowup.map((item) => (
                        <Item key={item.to} to={item.to} label={item.label} icon={item.icon} />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {visibleAdminInvoice.length > 0 && (
                <div>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-slate-800 text-slate-300"
                    onClick={() => setAdminInvoiceOpen((v) => !v)}
                  >
                    <IndianRupee size={16} />
                    <span className="flex-1 text-left">Invoice</span>
                    {adminInvoiceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  {adminInvoiceOpen && (
                    <div className="ml-4 border-l border-slate-800 pl-2 space-y-0.5">
                      {visibleAdminInvoice.map((item) => (
                        <Item key={item.to} to={item.to} label={item.label} icon={item.icon} />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {isAdmin && (
                <div>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-slate-800 text-slate-300"
                    onClick={() => setAdminDrrOpen((v) => !v)}
                  >
                    <ClipboardCheck size={16} />
                    <span className="flex-1 text-left">DRR</span>
                    {adminDrrOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  {adminDrrOpen && (
                    <div className="ml-4 border-l border-slate-800 pl-2 space-y-0.5">
                      <Item to={ADMIN_DRR_RESPONSIBILITY.to} label={ADMIN_DRR_RESPONSIBILITY.label} icon={ADMIN_DRR_RESPONSIBILITY.icon} />
                      <Item to={ADMIN_DRR_IMPORT.to} label={ADMIN_DRR_IMPORT.label} icon={ADMIN_DRR_IMPORT.icon} />
                    </div>
                  )}
                </div>
              )}
            </>
          ) : area === 'DPR' ? (
            <>
              {dprCanView && (
                <>
                  <Item to="/dpr/operational-data" label="Dashboard" icon={Gauge} end />
                  <div className="pt-3 mt-2 border-t border-slate-800">
                    <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-slate-600">Daily Progress</div>
                    <Item to="/dpr/progress-report" label="Progress Report" icon={CalendarCheck} />
                  </div>
                  <div className="pt-3 mt-2 border-t border-slate-800">
                    <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-slate-600">DPR Report</div>
                    <Item to="/dpr/hsd-report" label="HSD Report" icon={Fuel} />
                  </div>
                </>
              )}
            </>
          ) : area === 'ILM' ? (
            <>
              {ilmCanView && (
                <>
                  <Item to="/ilm" label="Dashboard" icon={Gauge} end />
                  <Item to="/ilm/trailer-summary" label="Trailer Dashboard" icon={Truck} />
                  <Item to="/ilm/crane-summary" label="Crane Dashboard" icon={Package} />
                </>
              )}

              {ilmCanView && (
                <div className="pt-3 mt-2 border-t border-slate-800">
                  <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-slate-600">Daily Progress</div>
                  <Item to="/ilm/progress-report" label="ILM Add" icon={CalendarCheck} />
                </div>
              )}
            </>
          ) : area === 'DRR' ? (
            <>
              {drrCanView && <Item to="/drr" label="Dashboard" icon={Gauge} end />}
              {drrCanCreate && <Item to="/drr/new" label="New Daily Report" icon={ClipboardCheck} />}
              {drrCanView && <Item to="/drr/reports" label="All Reports" icon={ClipboardList} />}
            </>
          ) : (
            <>
          {can('canViewDashboard') && <Item to="/" label="Dashboard" icon={Gauge} end />}

          {MAIN.filter(visible).map((item) => (
            <Item key={item.to} to={item.to} label={item.label} icon={item.icon} />
          ))}
            </>
          )}
        </nav>

        <div className="px-3 py-3 border-t border-slate-800">
          <div className="text-sm text-white font-medium truncate">{user?.name}</div>
          <div className="text-[11px] text-slate-500 truncate">{user?.role}</div>
          {!!user?.rigIds?.length && (
            <div className="text-[11px] text-amber-400 mt-1">
              {user.rigIds.length === 1 ? 'Limited to one rig' : `Limited to ${user.rigIds.length} rigs`}
            </div>
          )}
          {!user?.rigIds?.length && user?.rigId && (
            <div className="text-[11px] text-amber-400 mt-1">Limited to one rig</div>
          )}
          <button
            className="mt-2 w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-slate-300 hover:bg-slate-800"
            onClick={() => setPasswordOpen(true)}
          >
            <KeyRound size={14} /> Change password
          </button>
          <button
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-slate-300 hover:bg-slate-800"
            onClick={() => { signOut(); navigate('/login'); }}
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-x-hidden">
        <div className="p-5 max-w-[1600px]">
          <Outlet />
        </div>
      </main>

      <ChangePassword open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}

function ChangePassword({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, run] = useBusy();

  useEffect(() => {
    if (open) { setForm({ currentPassword: '', newPassword: '', confirm: '' }); setError(''); setDone(false); }
  }, [open]);

  async function save() {
    setError('');
    if (form.newPassword.length < 8) { setError('The new password must be at least 8 characters.'); return; }
    if (form.newPassword !== form.confirm) { setError('The two new passwords do not match.'); return; }
    try {
      await run(() => api.post('/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      }));
      setDone(true);
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <Modal open={open} title="Change your password" onClose={onClose} width="max-w-md">
      {done ? (
        <div className="space-y-4">
          <InfoBox>Your password has been changed. It applies the next time you sign in.</InfoBox>
          <div className="flex justify-end">
            <button className="btn-primary" onClick={onClose}>Close</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <ErrorBox message={error} onDismiss={() => setError('')} />
          <Field label="Current password">
            <input className="input" type="password" value={form.currentPassword}
              onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <input className="input" type="password" value={form.newPassword}
              onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
          </Field>
          <Field label="Confirm new password">
            <input className="input" type="password" value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={() => void save()} disabled={busy}>Change password</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Item({ to, label, icon: Icon, end }: { to: string; label: string; icon: typeof Gauge; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-2 rounded-md transition-colors ${
          isActive ? 'bg-rig-600 text-white' : 'hover:bg-slate-800 text-slate-300'
        }`
      }
    >
      <Icon size={16} />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}
