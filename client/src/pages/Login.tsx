import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  AlertCircle, Eye, EyeOff, Loader2, Lock, LogIn, ShieldCheck, User,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import gtcLogo from '../assets/gtc-logo.png';

const REMEMBER_KEY = 'pms.rememberedUsername';

/**
 * Purely a visual redesign — signIn(), the /auth/login call it makes, error
 * handling and the post-login redirect are byte-for-byte the same as before.
 * "Remember me" is real (it persists/prefills the username in localStorage,
 * nothing more — the server never sees a "remembered" flag). "Forgot
 * password" has no backend flow in this app, so it opens an honest note
 * instead of pretending to submit a request.
 */
export default function Login() {
  const { user, loading, signIn } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showForgotNote, setShowForgotNote] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(REMEMBER_KEY);
    if (saved) { setUsername(saved); setRemember(true); }
  }, []);

  const parallax = useParallax();

  if (!loading && user) return <Navigate to="/select-module" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!username.trim()) { setError('Enter your username or email.'); return; }
    if (!password) { setError('Enter your password.'); return; }
    setBusy(true);
    try {
      await signIn(username.trim(), password);
      if (remember) localStorage.setItem(REMEMBER_KEY, username.trim());
      else localStorage.removeItem(REMEMBER_KEY);
      navigate('/select-module', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={parallax.ref}
      className="relative min-h-screen w-full overflow-hidden bg-gradient-to-br from-sky-50 via-white to-indigo-50 flex items-center justify-center p-4 sm:p-6 lg:p-10"
    >
      <BackgroundScene offset={parallax.offset} />

      <div className="relative z-10 w-full max-w-6xl grid lg:grid-cols-2 gap-10 items-center">
        <div
          className="hidden lg:flex flex-col items-center text-center gap-6 px-6"
          style={parallax.layerStyle(0.6)}
        >
          <LogoBadge size={150} />
          <div className="text-[11px] uppercase tracking-[0.25em] text-slate-500 -mt-2">
            Driving Energy. Delivering Excellence.
          </div>

          <RigIllustration />

          <div className="grid grid-cols-3 gap-3 w-full max-w-md mt-2">
            <FeaturePill icon={ShieldCheck} title="Secure Access" subtitle="Enterprise grade security" />
            <FeaturePill icon={LogIn} title="Real-time Insights" subtitle="Track operations live" />
            <FeaturePill icon={Lock} title="Reliable System" subtitle="Built for performance" />
          </div>
        </div>

        <div className="w-full max-w-md mx-auto" style={parallax.layerStyle(1)}>
          <div className="relative rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-2xl shadow-[0_20px_60px_-15px_rgba(56,120,255,0.25)] p-7 sm:p-9 animate-card-in">
            <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-sky-400/5 via-transparent to-violet-500/5" />
            <div className="pointer-events-none absolute -inset-px rounded-2xl border border-white/60" />

            <div className="relative">
              <div className="flex flex-col items-center text-center mb-6 lg:hidden">
                <LogoBadge size={80} />
              </div>

              <h1 className="text-2xl font-semibold text-slate-900 text-center">Welcome Back!</h1>
              <p className="text-sm text-slate-500 text-center mt-1">Sign in to continue to your workspace</p>

              <div className="hidden lg:flex flex-col items-center mt-5 mb-1">
                <LogoBadge size={68} />
              </div>

              <form onSubmit={onSubmit} className="mt-6 space-y-4">
                {error && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button type="button" className="text-red-400 hover:text-red-600" onClick={() => setError('')} aria-label="Dismiss">
                      &times;
                    </button>
                  </div>
                )}

                <GlassField icon={User}>
                  <input
                    className="peer w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 outline-none"
                    placeholder="Username / Email"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                    autoComplete="username"
                  />
                </GlassField>

                <GlassField icon={Lock}>
                  <input
                    className="peer w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 outline-none"
                    placeholder="Password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="text-slate-400 hover:text-sky-600 transition-colors shrink-0"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </GlassField>

                <div className="flex items-center justify-between text-xs pt-1">
                  <label className="flex items-center gap-2 text-slate-600 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300 bg-transparent accent-sky-500 cursor-pointer"
                    />
                    Remember me
                  </label>
                  <button
                    type="button"
                    className="text-sky-600 hover:text-sky-700 transition-colors font-medium"
                    onClick={() => setShowForgotNote((v) => !v)}
                  >
                    Forgot Password?
                  </button>
                </div>

                {showForgotNote && (
                  <div className="text-[11px] text-slate-600 bg-sky-50 border border-sky-100 rounded-lg px-3 py-2 animate-fade-in">
                    Password resets aren't self-service yet — ask your Admin to reset it from the account menu.
                  </div>
                )}

                <button
                  className="group relative w-full mt-2 overflow-hidden rounded-lg px-4 py-2.5 font-medium text-white
                             bg-gradient-to-r from-sky-500 via-blue-600 to-violet-600
                             shadow-[0_8px_24px_-8px_rgba(59,130,246,0.45)]
                             hover:shadow-[0_10px_30px_-6px_rgba(99,102,241,0.55)]
                             hover:brightness-110 active:brightness-95 transition-all duration-200
                             disabled:opacity-60 disabled:cursor-not-allowed
                             flex items-center justify-center gap-2"
                  disabled={busy}
                >
                  <span
                    className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                    style={{
                      backgroundImage: 'linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.35) 50%, transparent 70%)',
                      backgroundSize: '200% 100%',
                    }}
                  />
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
                  <span className="relative">{busy ? 'Signing in...' : 'Login'}</span>
                </button>
              </form>

              <div className="flex items-center gap-2 justify-center text-[11px] text-slate-400 mt-6 text-center">
                <ShieldCheck size={13} className="text-slate-400 shrink-0" />
                Every sign-in attempt is recorded with its time and source address.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- decorative pieces ---------------------------- */

function GlassField({ icon: Icon, children }: { icon: typeof User; children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5
                 focus-within:border-sky-400 focus-within:bg-white
                 focus-within:shadow-[0_0_0_3px_rgba(56,189,248,0.15)] transition-all"
    >
      <Icon size={16} className="text-slate-400 shrink-0" />
      {children}
    </div>
  );
}

function FeaturePill({ icon: Icon, title, subtitle }: { icon: typeof ShieldCheck; title: string; subtitle: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white/70 shadow-sm p-3 text-left">
      <Icon size={16} className="text-sky-600 mb-1.5" />
      <div className="text-[11px] font-semibold text-slate-700 leading-tight">{title}</div>
      <div className="text-[10px] text-slate-500 leading-snug mt-0.5">{subtitle}</div>
    </div>
  );
}

/**
 * The real GTC logo (client/src/assets/gtc-logo.png), background removed.
 * Its wordmark is dark text designed for a light surface, so it sits on a
 * small light "badge" plate rather than directly on the dark glass card —
 * the asset itself is untouched, only its presentation is adapted.
 */
function LogoBadge({ size = 64 }: { size?: number }) {
  return (
    <div
      className="inline-flex items-center justify-center rounded-2xl bg-slate-50/95 shadow-[0_0_28px_-6px_rgba(56,189,248,0.55)] ring-1 ring-white/40"
      style={{ padding: size * 0.12 }}
    >
      <img src={gtcLogo} alt="GTC Oilfield Services Ltd." style={{ width: size, height: 'auto' }} draggable={false} />
    </div>
  );
}

/** Wireframe derrick + pumpjack, drawn once with a stroke-dashoffset reveal. */
function RigIllustration() {
  return (
    <svg width="260" height="150" viewBox="0 0 260 150" fill="none" className="text-sky-600/70 mt-1">
      <g strokeWidth="1.4" stroke="currentColor" opacity="0.85">
        <path
          className="animate-draw"
          style={{ strokeDasharray: 600 }}
          d="M60 140 L85 40 L110 140 M70 110 L100 110 M75 85 L95 85 M80 60 L90 60 M85 40 L85 20"
        />
      </g>
      <g stroke="#6366f1" strokeWidth="1.2" opacity="0.6">
        <circle cx="180" cy="110" r="22" />
        <line x1="180" y1="88" x2="180" y2="70" />
        <line x1="150" y1="120" x2="210" y2="120" />
        <line x1="160" y1="132" x2="200" y2="132" />
        <line x1="165" y1="140" x2="195" y2="140" />
      </g>
      <circle cx="85" cy="18" r="2.4" fill="#f97316" className="animate-pulse" />
    </svg>
  );
}

function BackgroundScene({ offset }: { offset: { x: number; y: number } }) {
  const particles = useMemo(
    () => Array.from({ length: 16 }, (_, i) => ({
      id: i,
      left: Math.round((i * 37 + 11) % 100),
      top: Math.round((i * 53 + 7) % 100),
      size: 2 + (i % 3),
      delay: (i % 6) * 0.8,
      speed: i % 3 === 0 ? 'animate-float-slow' : i % 3 === 1 ? 'animate-float' : 'animate-float-slower',
    })),
    [],
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* grid */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #3b82f6 1px, transparent 1px), linear-gradient(to bottom, #3b82f6 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          transform: `translate3d(${offset.x * 8}px, ${offset.y * 8}px, 0)`,
        }}
      />

      {/* glow orbs */}
      <div
        className="absolute -top-24 -left-24 h-[420px] w-[420px] rounded-full bg-sky-300/40 blur-3xl animate-glow"
        style={{ transform: `translate3d(${offset.x * -18}px, ${offset.y * -18}px, 0)` }}
      />
      <div
        className="absolute top-1/3 -right-32 h-[460px] w-[460px] rounded-full bg-violet-300/35 blur-3xl animate-glow"
        style={{ animationDelay: '1.4s', transform: `translate3d(${offset.x * 14}px, ${offset.y * 14}px, 0)` }}
      />
      <div
        className="absolute -bottom-32 left-1/3 h-[380px] w-[380px] rounded-full bg-indigo-300/30 blur-3xl animate-glow"
        style={{ animationDelay: '2.8s', transform: `translate3d(${offset.x * -10}px, ${offset.y * 10}px, 0)` }}
      />

      {/* floating particles */}
      {particles.map((p) => (
        <span
          key={p.id}
          className={`absolute rounded-full bg-sky-500/60 ${p.speed}`}
          style={{
            left: `${p.left}%`, top: `${p.top}%`, width: p.size, height: p.size,
            animationDelay: `${p.delay}s`,
            boxShadow: '0 0 6px 1px rgba(14,165,233,0.35)',
          }}
        />
      ))}

      {/* two large translucent spheres for depth, echoing the reference image's corner orbs */}
      <div
        className="absolute -top-10 right-10 h-24 w-24 rounded-full bg-gradient-to-br from-indigo-300/50 to-transparent border border-white/60 animate-float-slow"
        style={{ transform: `translate3d(${offset.x * 20}px, ${offset.y * 20}px, 0)` }}
      />
      <div
        className="absolute bottom-16 left-8 h-16 w-16 rounded-full bg-gradient-to-br from-sky-300/50 to-transparent border border-white/60 animate-float"
        style={{ transform: `translate3d(${offset.x * -22}px, ${offset.y * -12}px, 0)` }}
      />
    </div>
  );
}

/** Tracks normalized mouse position within the page for a subtle 3D parallax effect. Purely decorative — no state it touches affects auth. */
function useParallax() {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onMove(e: MouseEvent) {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        const rect = el!.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        setOffset({ x, y });
        frame.current = null;
      });
    }
    function onLeave() { setOffset({ x: 0, y: 0 }); }
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return {
    ref,
    offset,
    layerStyle: (intensity: number) => ({
      transform: `translate3d(${offset.x * 10 * intensity}px, ${offset.y * 10 * intensity}px, 0)`,
      transition: 'transform 0.2s ease-out',
    }),
  };
}
