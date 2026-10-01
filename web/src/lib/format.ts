import type { Finding } from './types.ts';

export const SEV_ORDER = { critical: 0, major: 1, minor: 2, cosmetic: 3 } as const;
export const ACTIVE = ['new', 'confirmed', 'fixing'];
/** Mirrors categoryOf() in the agent schema: behaviour bugs are kept apart from layout bugs. */
export const categoryOf = (f: { type: string; category?: string | null }) => f.category ?? (f.type === 'broken-state' || f.type === 'console-error' ? 'ux-functional' : 'layout');

export function widthRange(f: Pick<Finding, 'viewports'>) {
  const ws = [...new Set(f.viewports.map((v) => v.width))].sort((a, b) => a - b);
  if (!ws.length) return '';
  return ws.length === 1 ? `${ws[0]}px` : `${ws[0]}–${ws[ws.length - 1]}px`;
}

export function ago(iso: string | null | undefined) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dateTime(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

export function duration(a: string | null | undefined, b: string | null | undefined) {
  if (!a) return '';
  const ms = (b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime();
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

export function variantEntries(v: Record<string, unknown>) {
  const defaults: Record<string, unknown> = { colorScheme: 'light', fontScale: 1, zoom: 1, dpr: 1, reducedMotion: false, network: 'online' };
  return Object.entries(v).filter(([k, val]) => !(k in defaults && defaults[k] === val) && !(Array.isArray(val) && !val.length));
}

export function targetName(t: string) {
  try {
    if (/^https?:/.test(t)) return new URL(t).host;
  } catch {}
  return t.replace(/\/+$/, '').split('/').slice(-2).join('/');
}

export function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

export function mmss(ms: number) {
  const s = Math.max(0, ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}
