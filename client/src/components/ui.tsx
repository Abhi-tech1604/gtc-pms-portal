import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Info, Loader2, X } from 'lucide-react';

export function PageHeader({ title, subtitle, actions }: {
  title: string; subtitle?: ReactNode; actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <div className="text-sm text-slate-500 mt-0.5">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500 py-8 justify-center">
      <Loader2 size={16} className="animate-spin" />
      {label ?? 'Loading...'}
    </div>
  );
}

export function ErrorBox({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 mb-3">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <div className="flex-1 whitespace-pre-wrap">{message}</div>
      {onDismiss && (
        <button onClick={onDismiss} className="text-red-600 hover:text-red-800" aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function InfoBox({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 mb-3">
      <Info size={16} className="mt-0.5 shrink-0" />
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function Empty({ message }: { message: string }) {
  return <div className="text-sm text-slate-500 text-center py-10">{message}</div>;
}

/**
 * Every destructive or ambiguous action goes through this dialog, and the
 * caller must supply the specific values involved rather than a generic warning
 * (spec 11.3).
 */
export function ConfirmDialog({ open, title, body, confirmLabel, tone = 'primary', busy, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
          <AlertTriangle size={18} className={tone === 'danger' ? 'text-red-600' : 'text-amber-600'} />
          <h2 className="font-semibold text-slate-900">{title}</h2>
        </div>
        <div className="px-4 py-4 text-sm text-slate-700 space-y-2 max-h-[60vh] overflow-auto">{body}</div>
        <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Modal({ open, title, children, onClose, width = 'max-w-2xl' }: {
  open: boolean; title: string; children: ReactNode; onClose: () => void; width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-slate-900/50 p-4 overflow-auto">
      <div className={`bg-white rounded-lg shadow-xl w-full ${width} my-8`}>
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="px-4 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-slate-500 mt-1">{hint}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: {
  tabs: { key: T; label: string }[]; active: T; onChange: (key: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-slate-200 mb-4">
      {tabs.map((t) => (
        <button key={t.key} className={active === t.key ? 'tab-active' : 'tab-idle'} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Long operations show progress; the interface never appears frozen (11.3). */
export function useBusy(): [boolean, <T>(fn: () => Promise<T>) => Promise<T>] {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>): Promise<T> => {
    setBusy(true);
    try { return await fn(); } finally { setBusy(false); }
  };
  return [busy, run];
}
