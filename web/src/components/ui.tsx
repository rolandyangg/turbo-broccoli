import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { copy } from '../lib/format.ts';

// ---------- icons ----------
export const FileIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
    <path d="M4 1.5h5.5L13 5v9.5H4z" />
    <path d="M9.5 1.5V5H13" />
  </svg>
);
export const Arrow = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden style={{ verticalAlign: -1 }}>
    <path d="M2 8h11M9 4l4 4-4 4" />
  </svg>
);
export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <path d="M16 2 29 9.5v13L16 30 3 22.5v-13Z" style={{ fill: 'var(--ink)' }} />
    <path d="M16 9l7 4v6l-7 4-7-4v-6Z" fill="#28E99F" />
    <path d="M16 9v14M9 13l14 6" style={{ stroke: 'var(--ink)' }} strokeWidth="1.4" />
  </svg>
);

type Theme = 'dark' | 'light' | 'system';
/** Cycles dark → light → system; persisted per browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) || 'dark');
  const next: Record<Theme, Theme> = { dark: 'light', light: 'system', system: 'dark' };
  return (
    <button
      className="btn-ghost theme-toggle"
      title={`Theme: ${theme} (click for ${next[theme]})`}
      aria-label={`Theme: ${theme}. Switch to ${next[theme]}`}
      onClick={() => {
        const t = next[theme];
        document.documentElement.dataset.theme = t;
        try {
          localStorage.setItem('bugbash-theme', t);
        } catch {}
        setTheme(t);
      }}
    >
      {theme === 'dark' ? '◐' : theme === 'light' ? '○' : '◑'}
      <span className="theme-label"> {theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System'}</span>
    </button>
  );
}
export const BugGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
    <path d="M8 1.5 13.5 4.7v6.6L8 14.5 2.5 11.3V4.7Z" fill="#3D3B4F" />
    <path d="M8 5l3 1.8v3.4L8 12 5 10.2V6.8Z" fill="#28E99F" />
  </svg>
);
export const Check = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="m3 8.5 3 3 7-7" />
  </svg>
);
export const Cross = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);

/** Hexagon "bolt" drawn on section corners (Greptile motif). */
export const Bolt = ({ pos }: { pos: 'tl' | 'tr' | 'bl' | 'br' }) => (
  <svg className={`bolt ${pos}`} viewBox="0 0 12 12" aria-hidden>
    <path d="M6 .8 10.6 3.4v5.2L6 11.2 1.4 8.6V3.4Z" fill="currentColor" />
    <circle cx="6" cy="6" r="1.6" fill="#eee" />
  </svg>
);

// ---------- boxes ----------
export function Box({ head, chip, foot, onFoot, footHref, children, className = '', selected, bodyClass = '' }: { head?: ReactNode; chip?: ReactNode; foot?: ReactNode; onFoot?: () => void; footHref?: string; children?: ReactNode; className?: string; selected?: boolean; bodyClass?: string }) {
  return (
    <div className={`box ${selected ? 'selected' : ''} ${className}`}>
      {(head || chip) && (
        <div className="box-head">
          <div className="path">{head}</div>
          {chip}
        </div>
      )}
      {children !== undefined && <div className={`box-body ${bodyClass}`}>{children}</div>}
      {foot &&
        (footHref ? (
          <a className="box-foot" href={footHref}>
            {foot}
          </a>
        ) : (
          <button className="box-foot" onClick={onFoot}>
            {foot}
          </button>
        ))}
    </div>
  );
}

export const Chip = ({ children, tone = '', title }: { children: ReactNode; tone?: string; title?: string }) => (
  <span className={`chip ${tone}`} title={title}>
    {children}
  </span>
);
export const SevChip = ({ sev }: { sev: string }) => <Chip tone={`dot sev-${sev}`}>{sev}</Chip>;
export function StatusChip({ status }: { status: string }) {
  const tone = status === 'fixing' ? 'green' : status === 'fixed' ? 'mint' : status === 'new' || status === 'confirmed' ? 'ink' : 'outline';
  return <Chip tone={tone}>{status.replace('_', ' ')}</Chip>;
}

/** Big section in Greptile's "NVIDIA" pattern: title panel, ruler row, content; bolts on corners. */
export function Section({ kicker, title, meta, actions, children, id }: { kicker?: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" id={id}>
      <div className="section-head">
        <Bolt pos="tl" />
        <Bolt pos="tr" />
        {kicker && <div className="label kicker">{kicker}</div>}
        <h2 className="display h2">{title}</h2>
        {meta && <div className="meta">{meta}</div>}
        {actions && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
            {actions}
          </div>
        )}
      </div>
      <div className="ruler" />
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Chamfer({ children, tone = '', small, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'green' | 'light' | 'danger' | ''; small?: boolean }) {
  return (
    <button className={`chamfer ${tone} ${small ? 'small' : ''}`} {...rest}>
      {children}
    </button>
  );
}

/** Big number + label. `color` becomes a small marker beside the label (numbers stay in text ink). */
export const Stat = ({ n, label, color, sub }: { n: ReactNode; label: string; color?: string; sub?: ReactNode }) => (
  <div className="stat">
    <b>{n}</b>
    <span className="label row" style={{ gap: 6 }}>
      {color && <i className="stat-mark" style={{ background: color }} />}
      {label}
    </span>
    {sub && <div className="small muted" style={{ marginTop: 4 }}>{sub}</div>}
  </div>
);

export function ConfidenceBar({ value, w = 90 }: { value: number; w?: number }) {
  return (
    <span className="row" style={{ gap: 8 }} title={`confidence ${Math.round(value * 100)}%`}>
      <span className={`conf-bar ${value >= 0.8 ? 'hi' : ''}`} style={{ width: w }}>
        <i style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="mono small">{Math.round(value * 100)}%</span>
    </span>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'on' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn-ghost"
      onClick={() => {
        copy(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function Dialog({ open, onClose, title, children, footer, wide, dismissible = true }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; dismissible?: boolean }) {
  useEffect(() => {
    if (!open || !dismissible) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose, dismissible]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => dismissible && e.target === e.currentTarget && onClose()}>
      <div className="dialog box" style={wide ? { width: 'min(1180px, 100%)' } : undefined} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="box-head">
          <div className="path">{title}</div>
          <button className="btn-link" disabled={!dismissible} onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="box-body stack" style={{ ['--gap' as string]: '14px' }}>
          {children}
        </div>
        {footer && (
          <div className="row" style={{ justifyContent: 'flex-end', padding: '12px 16px', borderTop: '1px dashed var(--line)', background: 'var(--panel)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function JsonView({ value, max = 520 }: { value: unknown; max?: number }) {
  return (
    <pre className="code" style={{ maxHeight: max }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return (
    <div className="empty row" style={{ justifyContent: 'center' }}>
      <span className="spinner" /> <span className="label">{what}…</span>
    </div>
  );
}

export function ErrorBox({ error }: { error: string }) {
  return (
    <div className="empty" style={{ color: 'var(--err)' }}>
      <div className="label" style={{ color: 'var(--err)' }}>Error</div>
      <p>{error}</p>
    </div>
  );
}

// ---------- toasts ----------
type Toast = { id: number; text: string; err?: boolean };
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, err?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite">
        {toasts.map((t, i) => (
          <div key={t.id} className={`toast ${t.err ? 'err' : ''}`} style={{ bottom: 20 + i * 60 }}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
