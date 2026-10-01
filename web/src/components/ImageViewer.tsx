import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ViewerImage {
  src: string;
  label: string;
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const MIN = 0.05;
const MAX = 8;

/**
 * Full-screen image viewer: wheel / pinch zoom around the cursor, drag to pan, +/−/Fit/100% buttons,
 * double-click to toggle Fit↔100%, keyboard (+ − 0 1 ← → Esc), and flipping between a set of images.
 */
export function ImageViewer({ images, index, onClose, onIndex }: { images: ViewerImage[]; index: number; onClose: () => void; onIndex: (i: number) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; scale: number } | null>(null);
  const img = images[index];

  const fit = useCallback((): View => {
    const el = stage.current;
    if (!el || !natural) return { scale: 1, x: 0, y: 0 };
    const pad = 24;
    const s = Math.min((el.clientWidth - pad * 2) / natural.w, (el.clientHeight - pad * 2) / natural.h, 1);
    return { scale: s, x: (el.clientWidth - natural.w * s) / 2, y: Math.max(pad, (el.clientHeight - natural.h * s) / 2) };
  }, [natural]);

  // Keep at least KEEP px of the image on screen so it can't be zoomed or dragged out of reach.
  const clamp = useCallback(
    (v: View): View => {
      const el = stage.current;
      if (!el || !natural) return v;
      const KEEP = 120;
      const w = natural.w * v.scale;
      const h = natural.h * v.scale;
      return { scale: v.scale, x: Math.min(el.clientWidth - Math.min(KEEP, w), Math.max(Math.min(KEEP, w) - w, v.x)), y: Math.min(el.clientHeight - Math.min(KEEP, h), Math.max(Math.min(KEEP, h) - h, v.y)) };
    },
    [natural],
  );

  // Zoom to `next` scale keeping the stage point (cx, cy) fixed under the cursor.
  const zoomAt = useCallback(
    (next: number, cx?: number, cy?: number) => {
      setView((v) => {
        const el = stage.current;
        const s = Math.min(MAX, Math.max(MIN, next));
        const px = cx ?? (el ? el.clientWidth / 2 : 0);
        const py = cy ?? (el ? el.clientHeight / 2 : 0);
        return clamp({ scale: s, x: px - ((px - v.x) * s) / v.scale, y: py - ((py - v.y) * s) / v.scale });
      });
    },
    [clamp],
  );

  useEffect(() => setNatural(null), [img?.src]);
  useLayoutEffect(() => {
    if (natural) setView(fit());
  }, [natural, fit]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomAt(view.scale * 1.25);
      else if (e.key === '-' || e.key === '_') zoomAt(view.scale / 1.25);
      else if (e.key === '0') setView(fit());
      else if (e.key === '1') zoomAt(1);
      else if (e.key === 'ArrowRight' && images.length > 1) onIndex((index + 1) % images.length);
      else if (e.key === 'ArrowLeft' && images.length > 1) onIndex((index - 1 + images.length) % images.length);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [view.scale, index, images.length, onClose, onIndex, zoomAt, fit]);

  // Non-passive wheel listener so the page doesn't scroll while zooming.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      // Gentle, capped steps: about 12% per mouse-wheel notch; trackpad pinch (ctrlKey) is finer-grained.
      const raw = Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0012));
      const factor = Math.min(1.25, Math.max(0.8, raw || 1));
      setView((v) => {
        const s = Math.min(MAX, Math.max(MIN, v.scale * factor));
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        return clamp({ scale: s, x: px - ((px - v.x) * s) / v.scale, y: py - ((py - v.y) * s) / v.scale });
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clamp]);

  if (!img) return null;
  const pct = Math.round(view.scale * 100);
  return (
    <div className="iv" role="dialog" aria-modal="true" aria-label={`Image viewer: ${img.label}`}>
      <div className="iv-bar">
        <span className="mono small iv-title">
          {img.label}
          {images.length > 1 ? ` · ${index + 1}/${images.length}` : ''}
          {natural ? ` · ${natural.w}×${natural.h}px` : ''}
        </span>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn-ghost" onClick={() => zoomAt(view.scale / 1.25)} aria-label="Zoom out">
            −
          </button>
          <span className="mono small iv-pct">{pct}%</span>
          <button className="btn-ghost" onClick={() => zoomAt(view.scale * 1.25)} aria-label="Zoom in">
            +
          </button>
          <button className="btn-ghost" onClick={() => setView(fit())}>
            Fit
          </button>
          <button className="btn-ghost" onClick={() => zoomAt(1)}>
            100%
          </button>
          <a className="btn-ghost" href={img.src} target="_blank" rel="noreferrer">
            Open
          </a>
          <button className="btn-ghost on" onClick={onClose} aria-label="Close viewer">
            Close
          </button>
        </div>
      </div>
      <div
        ref={stage}
        className="iv-stage"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
            drag.current = null;
          } else drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pinch.current && pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            const r = stage.current!.getBoundingClientRect();
            zoomAt(pinch.current.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.dist), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
          } else if (drag.current?.id === e.pointerId) {
            const d = drag.current;
            setView((v) => clamp({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          if (drag.current?.id === e.pointerId) drag.current = null;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          pinch.current = null;
          drag.current = null;
        }}
        onDoubleClick={(e) => {
          const r = stage.current!.getBoundingClientRect();
          const f = fit();
          if (Math.abs(view.scale - f.scale) < 0.01) zoomAt(1, e.clientX - r.left, e.clientY - r.top);
          else setView(f);
        }}
      >
        <img
          src={img.src}
          alt={img.label}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, visibility: natural ? 'visible' : 'hidden' }}
        />
        {images.length > 1 && (
          <>
            <button className="iv-nav prev" aria-label="Previous image" onClick={() => onIndex((index - 1 + images.length) % images.length)}>
              ‹
            </button>
            <button className="iv-nav next" aria-label="Next image" onClick={() => onIndex((index + 1) % images.length)}>
              ›
            </button>
          </>
        )}
      </div>
      <div className="iv-help mono small">Scroll or pinch to zoom · drag to pan · double-click: fit ↔ 100% · keys: + − 0 1 ← → Esc</div>
    </div>
  );
}
