import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface View {
  scale: number;
  x: number;
  y: number;
}
const MIN = 0.05;
const MAX = 8;

/**
 * Full-screen side-by-side viewer for comparing two screenshots of the same bug (run A vs run B). Both panes share
 * one view: zooming or panning either moves both, so the same spot stays lined up.
 */
export function SyncedViewer({ left, right, title, onClose }: { left: { src: string | null; label: string }; right: { src: string | null; label: string }; title: string; onClose: () => void }) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState<{ l: { w: number; h: number } | null; r: { w: number; h: number } | null }>({ l: null, r: null });
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const box = nat.l || nat.r ? { w: Math.max(nat.l?.w ?? 0, nat.r?.w ?? 0), h: Math.max(nat.l?.h ?? 0, nat.r?.h ?? 0) } : null;

  const fit = useCallback((): View => {
    const el = paneRef.current;
    if (!el || !box) return { scale: 1, x: 0, y: 0 };
    const pad = 16;
    const s = Math.min((el.clientWidth - pad * 2) / box.w, (el.clientHeight - pad * 2) / box.h, 1);
    return { scale: s, x: (el.clientWidth - box.w * s) / 2, y: pad };
  }, [box?.w, box?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = useCallback((next: number, px?: number, py?: number) => {
    setView((v) => {
      const el = paneRef.current;
      const s = Math.min(MAX, Math.max(MIN, next));
      const cx = px ?? (el ? el.clientWidth / 2 : 0);
      const cy = py ?? (el ? el.clientHeight / 2 : 0);
      return { scale: s, x: cx - ((cx - v.x) * s) / v.scale, y: cy - ((cy - v.y) * s) / v.scale };
    });
  }, []);

  useLayoutEffect(() => {
    if (box) setView(fit());
  }, [box?.w, box?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomAt(view.scale * 1.25);
      else if (e.key === '-') zoomAt(view.scale / 1.25);
      else if (e.key === '0') setView(fit());
      else if (e.key === '1') zoomAt(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [view.scale, zoomAt, fit, onClose]);

  // Non-passive wheel listeners (both panes) so the page doesn't scroll while zooming.
  const rightRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const els = [paneRef.current, rightRef.current].filter(Boolean) as HTMLDivElement[];
    const handlers = els.map((el) => {
      const h = (e: WheelEvent) => {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const factor = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0012)) || 1));
        setView((v) => {
          const s = Math.min(MAX, Math.max(MIN, v.scale * factor));
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          return { scale: s, x: px - ((px - v.x) * s) / v.scale, y: py - ((py - v.y) * s) / v.scale };
        });
      };
      el.addEventListener('wheel', h, { passive: false });
      return () => el.removeEventListener('wheel', h);
    });
    return () => handlers.forEach((off) => off());
  }, []);

  const pane = (side: 'l' | 'r', img: { src: string | null; label: string }) => (
    <div
      ref={side === 'l' ? paneRef : rightRef}
      className="iv-stage sv-pane"
      aria-label={img.label}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => setView(fit())}
    >
      <div className="sv-label mono small">{img.label}</div>
      {img.src ? (
        <img
          src={img.src}
          alt={img.label}
          draggable={false}
          onLoad={(e) => {
            const n = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight };
            setNat((o) => ({ ...o, [side]: n }));
          }}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, visibility: box ? 'visible' : 'hidden' }}
        />
      ) : (
        <div className="sv-missing small muted">No screenshot in this run</div>
      )}
    </div>
  );

  return (
    <div className="iv" role="dialog" aria-modal="true" aria-label={`Compare screenshots: ${title}`}>
      <div className="iv-bar">
        <span className="mono small iv-title">{title}</span>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn-ghost" onClick={() => zoomAt(view.scale / 1.25)} aria-label="Zoom out">
            −
          </button>
          <span className="mono small iv-pct">{Math.round(view.scale * 100)}%</span>
          <button className="btn-ghost" onClick={() => zoomAt(view.scale * 1.25)} aria-label="Zoom in">
            +
          </button>
          <button className="btn-ghost" onClick={() => setView(fit())}>
            Fit
          </button>
          <button className="btn-ghost" onClick={() => zoomAt(1)}>
            100%
          </button>
          <button className="btn-ghost on" onClick={onClose} aria-label="Close viewer">
            Close
          </button>
        </div>
      </div>
      <div className="sv-panes">
        {pane('l', left)}
        {pane('r', right)}
      </div>
      <div className="iv-help mono small">Zoom and pan are synced across both sides · scroll to zoom · drag to pan · double-click to fit · keys: + − 0 1 Esc</div>
    </div>
  );
}
