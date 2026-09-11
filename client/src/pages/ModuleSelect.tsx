import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ArrowRight, ClipboardCheck, ClipboardList, LogOut, Package, ShieldCheck, Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MODULE_LABELS } from '../lib/types';
import { Spinner } from '../components/ui';
import gtcLogo from '../assets/gtc-logo.png';

/** The module-select landing page only ever offers these four workspaces — FOLLOWUP/INVOICE/ADMIN are permission-matrix-only buckets, never landing tiles. */
type LandingModule = 'PMS' | 'DPR' | 'ILM' | 'DRR';

const MODULE_ROUTES: Record<LandingModule, string> = { PMS: '/', DPR: '/dpr/operational-data', ILM: '/ilm', DRR: '/drr' };

const MODULE_DESCRIPTIONS: Record<LandingModule, string> = {
  PMS: 'Preventive Maintenance System for the rig fleet.',
  DPR: 'Daily Progress Report for the rig fleet.',
  ILM: 'Inventory / Logistics Management for the rig fleet.',
  DRR: 'One daily entry that updates DPR, Mechanical Log and HSD together.',
};

const MODULE_ICONS: Record<LandingModule, typeof Activity> = { PMS: Activity, DPR: ClipboardList, ILM: Package, DRR: ClipboardCheck };

/**
 * Per-module accent used only for the icon badge / hover glow so the four
 * cards read as a set while staying visually distinct — all still inside the
 * light, blue-led enterprise palette (no dark-theme colors introduced here).
 */
const MODULE_ACCENTS: Record<LandingModule, { badge: string; ring: string; glow: string }> = {
  PMS: { badge: 'from-blue-500 to-indigo-600', ring: 'group-hover:ring-blue-200', glow: 'bg-blue-400/30' },
  DPR: { badge: 'from-sky-500 to-blue-600', ring: 'group-hover:ring-sky-200', glow: 'bg-sky-400/30' },
  ILM: { badge: 'from-indigo-500 to-violet-600', ring: 'group-hover:ring-indigo-200', glow: 'bg-indigo-400/30' },
  DRR: { badge: 'from-violet-500 to-blue-600', ring: 'group-hover:ring-violet-200', glow: 'bg-violet-400/30' },
};

/**
 * The shared landing page after login (spec 4). Shows only the modules the
 * signed-in account has access to — the server independently enforces the
 * same access on every request behind each module, so hiding a tile here is
 * a convenience, not the authorization boundary (spec 5).
 */
export default function ModuleSelect() {
  const { user, hasModule, isAdmin, signOut } = useAuth();
  const navigate = useNavigate();
  const [activeCodes, setActiveCodes] = useState<LandingModule[] | null>(null);

  useEffect(() => {
    api.get<{ modules: { code: LandingModule }[] }>('/admin/modules/active')
      .then((d) => setActiveCodes(d.modules.map((m) => m.code)))
      .catch(() => setActiveCodes(['PMS', 'DPR', 'ILM', 'DRR'])); // fail open on this convenience check; the server still enforces per-module
  }, []);

  const available = activeCodes === null
    ? []
    : (['PMS', 'DPR', 'ILM', 'DRR'] as LandingModule[]).filter((code) => hasModule(code) && activeCodes.includes(code));

  const initials = useMemo(() => {
    const name = user?.name?.trim();
    if (!name) return '?';
    const parts = name.split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }, [user?.name]);

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-gradient-to-b from-slate-50 via-white to-blue-50/40">
      <BackgroundOrbs />

      <header className="relative z-10 border-b border-slate-200/70 bg-white/70 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="hidden sm:flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white ring-1 ring-slate-200 shadow-sm">
              <img src={gtcLogo} alt="GTC Oilfield Services Ltd." className="h-6 w-auto" draggable={false} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold tracking-wide text-slate-900 truncate">GTC OILFIELD PVT LTD</div>
              <div className="text-[11px] text-slate-500">Choose a module to continue</div>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {isAdmin && (
              <button
                className="group hidden sm:inline-flex items-center gap-1.5 rounded-full pl-3 pr-3.5 py-1.5 text-xs font-semibold text-white
                           bg-gradient-to-r from-blue-600 to-indigo-600 shadow-[0_6px_16px_-6px_rgba(37,99,235,0.55)]
                           hover:shadow-[0_8px_20px_-6px_rgba(37,99,235,0.7)] hover:brightness-105 transition-all duration-200"
                onClick={() => navigate('/admin')}
              >
                <ShieldCheck size={13} /> Admin Panel
              </button>
            )}

            <div className="hidden md:block text-right leading-tight">
              <div className="text-sm font-medium text-slate-800">{user?.name}</div>
              <div className="text-[11px] text-slate-500">{user?.role}</div>
            </div>

            <div className="h-9 w-9 rounded-full bg-gradient-to-br from-slate-700 to-slate-900 text-white text-xs font-semibold flex items-center justify-center shadow-sm ring-2 ring-white">
              {initials}
            </div>

            <button
              className="h-9 w-9 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
              onClick={signOut}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        <div className="text-center max-w-xl mx-auto mb-10 sm:mb-14 animate-fade-in">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100 px-3 py-1 text-[11px] font-semibold tracking-wide uppercase">
            <Sparkles size={12} /> Enterprise Portal
          </div>
          <h1 className="mt-4 text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
            Welcome back{user?.name ? `, ${user.name.split(' ')[0]}` : ''}
          </h1>
          <p className="mt-2 text-sm sm:text-[15px] text-slate-500">
            Select a workspace to continue. Each module opens with your account's existing permissions.
          </p>
        </div>

        {isAdmin && (
          <div className="mb-6 flex justify-end sm:hidden">
            <button
              className="inline-flex items-center gap-1.5 rounded-full pl-3 pr-3.5 py-1.5 text-xs font-semibold text-white
                         bg-gradient-to-r from-blue-600 to-indigo-600 shadow-[0_6px_16px_-6px_rgba(37,99,235,0.55)]"
              onClick={() => navigate('/admin')}
            >
              <ShieldCheck size={13} /> Admin Panel
            </button>
          </div>
        )}

        {activeCodes === null ? (
          <Spinner />
        ) : available.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-sm p-10 text-center text-slate-500 shadow-sm max-w-md mx-auto">
            No modules are assigned to your account yet. Contact an administrator.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6">
            {available.map((code, i) => {
              const Icon = MODULE_ICONS[code];
              const accent = MODULE_ACCENTS[code];
              return (
                <div
                  key={code}
                  className="group relative rounded-[20px] p-px animate-card-in"
                  style={{ animationDelay: `${i * 90}ms` }}
                >
                  {/* gradient border glow on hover */}
                  <div
                    className={`pointer-events-none absolute -inset-2 rounded-[24px] opacity-0 blur-xl transition-opacity duration-300 group-hover:opacity-100 ${accent.glow}`}
                  />

                  <div
                    className={`relative h-full flex flex-col rounded-[20px] border border-slate-200/80 bg-white/80 backdrop-blur-xl
                                p-6 shadow-[0_2px_10px_-4px_rgba(15,23,42,0.08)] ring-1 ring-transparent transition-all duration-300
                                group-hover:-translate-y-1.5 group-hover:shadow-[0_20px_40px_-12px_rgba(30,64,175,0.25)] ${accent.ring}`}
                  >
                    <div
                      className={`h-12 w-12 rounded-2xl bg-gradient-to-br ${accent.badge} flex items-center justify-center shadow-md
                                  transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3`}
                    >
                      <Icon size={22} className="text-white" strokeWidth={2} />
                    </div>

                    <div className="mt-4 flex-1">
                      <div className="font-semibold text-slate-900 text-[15px]">{MODULE_LABELS[code]}</div>
                      <div className="text-xs text-slate-500 mt-1.5 leading-relaxed">{MODULE_DESCRIPTIONS[code]}</div>
                    </div>

                    <button
                      className="group/btn mt-5 w-full inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5
                                 text-sm font-semibold text-white bg-gradient-to-r from-blue-600 to-indigo-600
                                 shadow-[0_8px_20px_-8px_rgba(37,99,235,0.6)]
                                 hover:shadow-[0_10px_24px_-6px_rgba(37,99,235,0.75)] hover:brightness-105
                                 active:brightness-95 transition-all duration-200"
                      onClick={() => navigate(MODULE_ROUTES[code])}
                    >
                      Open Module
                      <ArrowRight size={14} className="transition-transform duration-200 group-hover/btn:translate-x-0.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

/** Soft, light-theme background accents — blurred gradient orbs and a faint grid, echoing the login screen's depth without using a dark surface. */
function BackgroundOrbs() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.4]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #dbeafe 1px, transparent 1px), linear-gradient(to bottom, #dbeafe 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)',
        }}
      />
      <div className="absolute -top-32 -left-32 h-[420px] w-[420px] rounded-full bg-blue-300/25 blur-3xl animate-glow" />
      <div
        className="absolute top-1/4 -right-40 h-[460px] w-[460px] rounded-full bg-indigo-300/20 blur-3xl animate-glow"
        style={{ animationDelay: '1.5s' }}
      />
      <div
        className="absolute -bottom-40 left-1/4 h-[380px] w-[380px] rounded-full bg-sky-300/20 blur-3xl animate-glow"
        style={{ animationDelay: '3s' }}
      />
    </div>
  );
}
