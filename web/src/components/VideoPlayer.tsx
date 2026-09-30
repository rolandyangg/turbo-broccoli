import { useEffect, useMemo, useRef, useState } from 'react';
import { mmss } from '../lib/format.ts';

export interface Chapter {
  t_ms: number;
  step_index: number | null;
  label: string;
  kind: 'step' | 'bug' | 'load';
}

/**
 * Video with an annotated timeline: one tick per reproduction step, a red BUG marker, the current step
 * shown beside the player, jump-to-bug, speed and frame stepping. `seek` lets siblings (step list) drive it.
 */
export function VideoPlayer({ src, poster, chapters: given, bugAtMs, seek, onChapter }: { src: string; poster?: string; chapters: Chapter[]; bugAtMs: number | null; seek?: { t_ms: number; n: number } | null; onChapter?: (c: Chapter | null) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [dur, setDur] = useState(0);
  const [t, setT] = useState(0);
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const chapters = useMemo<Chapter[]>(() => {
    const cs = [...given];
    if (bugAtMs != null && !cs.some((c) => c.kind === 'bug')) cs.push({ t_ms: bugAtMs, step_index: null, label: 'BUG', kind: 'bug' });
    return cs.sort((a, b) => a.t_ms - b.t_ms);
  }, [given, bugAtMs]);
  const bug = chapters.find((c) => c.kind === 'bug') ?? null;
  const current = [...chapters].reverse().find((c) => c.t_ms <= t * 1000 + 30) ?? null;

  useEffect(() => onChapter?.(current), [current?.t_ms]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (seek && ref.current) {
      ref.current.currentTime = seek.t_ms / 1000;
      void ref.current.play().catch(() => {});
    }
  }, [seek?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);

  const go = (ms: number, play = false) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(dur || ms / 1000, ms / 1000));
    if (play) void v.play().catch(() => {});
  };
  const step = (dir: 1 | -1) => {
    const v = ref.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, v.currentTime + dir / 25);
  };
  const pctOf = (ms: number) => `${dur ? Math.min(100, (ms / 1000 / dur) * 100) : 0}%`;

  return (
    <div className="vp">
      <div className="vp-stage">
        <video
          ref={ref}
          src={src}
          poster={poster}
          controls
          preload="metadata"
          onLoadedMetadata={(e) => {
            setDur(e.currentTarget.duration || 0);
            if (bug) e.currentTarget.currentTime = Math.max(0, bug.t_ms / 1000 - 2.5);
          }}
          onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
        {current && (
          <div className={`vp-now ${current.kind === 'bug' ? 'bug' : ''}`} aria-live="polite">
            <span className="label">{current.kind === 'bug' ? 'Bug moment' : current.kind === 'load' ? 'Load' : `Step ${(current.step_index ?? 0) + 1}`}</span>
            {current.kind === 'bug' ? current.label.replace(/^BUG:\s*/, '') : current.label.replace(/^Step \d+:\s*/, '')}
          </div>
        )}
      </div>
      <div
        className="vp-track"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          go(((e.clientX - r.left) / r.width) * dur * 1000);
        }}
        role="slider"
        aria-label="Video timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(t)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') go(t * 1000 + 1000);
          if (e.key === 'ArrowLeft') go(t * 1000 - 1000);
        }}
      >
        <div className="vp-progress" style={{ width: pctOf(t * 1000) }} />
        {chapters.map((c, i) => (
          <button
            key={i}
            className={`vp-mark ${c.kind}`}
            style={{ left: pctOf(c.t_ms) }}
            title={`${mmss(c.t_ms)} · ${c.label}`}
            onClick={(e) => {
              e.stopPropagation();
              go(c.t_ms, true);
            }}
          >
            {c.kind === 'bug' ? <span>BUG</span> : c.kind === 'step' ? <span>{(c.step_index ?? 0) + 1}</span> : null}
          </button>
        ))}
      </div>
      <div className="spread vp-controls">
        <div className="row" style={{ gap: 6 }}>
          <button className="btn-ghost" onClick={() => (playing ? ref.current?.pause() : void ref.current?.play())}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button className="btn-ghost" onClick={() => step(-1)} title="Previous frame">
            ◀︎ frame
          </button>
          <button className="btn-ghost" onClick={() => step(1)} title="Next frame">
            frame ▶︎
          </button>
          {bug && (
            <button className="btn-ghost on" onClick={() => go(Math.max(0, bug.t_ms - 1500), true)}>
              Jump to bug
            </button>
          )}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className="mono small muted">
            {mmss(t * 1000)} / {mmss(dur * 1000)}
          </span>
          {[0.25, 0.5, 1, 2].map((r) => (
            <button key={r} className={`btn-ghost ${rate === r ? 'on' : ''}`} onClick={() => setRate(r)}>
              {r}×
            </button>
          ))}
        </div>
      </div>
      {chapters.length > 0 && (
        <ol className="vp-chapters">
          {chapters.map((c, i) => (
            <li key={i} className={`${current === c ? 'on' : ''} ${c.kind}`}>
              <button onClick={() => go(c.t_ms, true)}>
                <span className="mono small">{mmss(c.t_ms)}</span>
                <span>{c.label}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
