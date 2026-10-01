import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * Hand-built HTML/SVG charts following the dataviz rules: thin marks, 2px surface gaps between fills,
 * 4px rounded data-ends anchored to the baseline, recessive grid, a hover tooltip on every mark,
 * text in text tokens (never the series colour), and a table view for every chart.
 */

export function ChartCard({ title, sub, children, table, action }: { title: string; sub?: ReactNode; children: ReactNode; table?: ReactNode; action?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="box chart-card">
      <div className="box-head">
        <div className="path">{title}</div>
        {action}
        {table && (
          <button className={`btn-ghost ${asTable ? 'on' : ''}`} onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>
            Table
          </button>
        )}
      </div>
      <div className="box-body">
        {sub && <p className="small muted" style={{ margin: '0 0 12px' }}>{sub}</p>}
        {asTable && table ? table : children}
      </div>
    </div>
  );
}

interface Tip {
  x: number;
  y: number;
  body: ReactNode;
}
function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.body}
    </div>
  );
}

/** Horizontal bars: magnitude by category. One series → one colour, no legend. */
export function HBars({ rows, color = 'var(--data)', empty = 'Nothing to show.', unit = '' }: { rows: { key: string; label?: ReactNode; count: number; href?: string; color?: string }[]; color?: string; empty?: string; unit?: string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length || rows.every((r) => !r.count)) return <p className="muted small">{empty}</p>;
  return (
    <div className="hbars" onMouseLeave={() => setTip(null)}>
      {rows.map((r) => {
        const label = r.label ?? r.key;
        const bar = (
          <div
            className="hbar-row"
            onMouseMove={(e) => {
              const box = (e.currentTarget.closest('.hbars') as HTMLElement).getBoundingClientRect();
              setTip({ x: e.clientX - box.left + 12, y: e.clientY - box.top - 10, body: <><b>{r.key}</b><br />{r.count}{unit}</> });
            }}
          >
            <span className="hbar-label">{label}</span>
            <span className="hbar-track">
              {r.count > 0 && <span className="hbar-fill" style={{ width: `max(3px, ${(r.count / max) * 100}%)`, background: r.color ?? color }} />}
            </span>
            <span className="hbar-value mono">{r.count}</span>
          </div>
        );
        return r.href ? (
          <Link key={r.key} to={r.href} className="hbar-link">
            {bar}
          </Link>
        ) : (
          <div key={r.key}>{bar}</div>
        );
      })}
      <Tooltip tip={tip} />
    </div>
  );
}

/** Smallest 1/2/2.5/5 × 10^n at or above v (for non-count axes such as dollars). */
function niceCeil(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

/** Stacked columns over time (e.g. active findings per run by severity). Legend always shown for ≥2 series. */
export function StackedColumns({ data, series, xLabel, href, height = 200, highlight = null, valueFormat }: { data: (Record<string, number | string | boolean | null | undefined> & { id: string })[]; series: StackSeries[]; xLabel: (d: Record<string, unknown>) => string; href?: (d: Record<string, unknown>) => string; height?: number; highlight?: string | null; valueFormat?: (v: number) => string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const totals = data.map((d) => series.reduce((a, s) => a + (Number(d[s.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const niceMax = valueFormat ? niceCeil(max) : max <= 5 ? 5 : Math.ceil(max / 5) * 5;
  const ticks = [0, niceMax / 2, niceMax];
  const fmt = valueFormat ?? ((v: number) => String(v));
  if (!data.length) return <p className="muted small">No runs yet.</p>;
  return (
    <div className="cols-wrap">
      <div className="viz-legend" role="list">
        {series.map((s) => (
          <span key={s.key} role="listitem" className="row small" style={{ gap: 6 }}>
            <i className="stat-mark" style={{ background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
      <div className="cols" style={{ height }} onMouseLeave={() => (setTip(null), setHover(null))}>
        <div className="cols-grid" aria-hidden>
          {ticks.map((t) => (
            <div key={t} className="cols-gridline" style={{ bottom: `${(t / niceMax) * 100}%` }}>
              <span className="mono">{fmt(t)}</span>
            </div>
          ))}
        </div>
        <div className="cols-plot">
          {data.map((d, i) => {
            const col = (
              <div
                className={`col ${hover === d.id ? 'on' : ''} ${highlight ? (highlight === d.id ? 'selected' : 'dim') : ''}`}
                aria-label={`${xLabel(d)}: ${valueFormat ? fmt(totals[i]) : `${totals[i]} findings`}`}
                onMouseMove={(e) => {
                  setHover(d.id);
                  const box = (e.currentTarget.closest('.cols') as HTMLElement).getBoundingClientRect();
                  setTip({
                    x: Math.min(e.clientX - box.left + 12, box.width - 180),
                    y: 8,
                    body: (
                      <>
                        <b>{xLabel(d)}</b>
                        <br />
                        {valueFormat ? `${fmt(totals[i])} total` : `${totals[i]} active`}
                        {series.map((s) =>
                          Number(d[s.key]) ? (
                            <div key={s.key} className="row" style={{ gap: 6 }}>
                              <i className="stat-mark" style={{ background: s.color }} /> {s.label}: {fmt(Number(d[s.key]))}
                            </div>
                          ) : null,
                        )}
                      </>
                    ),
                  });
                }}
              >
                <div className="col-stack" style={{ height: `${(totals[i] / niceMax) * 100}%` }}>
                  {series.map((s) => {
                    const v = Number(d[s.key]) || 0;
                    return v ? <div key={s.key} className="col-seg" style={{ flexGrow: v, background: s.color }} /> : null;
                  })}
                </div>
              </div>
            );
            return href ? (
              <Link key={d.id} to={href(d)} className="col-link">
                {col}
              </Link>
            ) : (
              <div key={d.id} className="col-link">
                {col}
              </div>
            );
          })}
        </div>
        <Tooltip tip={tip} />
      </div>
      <div className="cols-x mono">
        <span>{xLabel(data[0])}</span>
        {data.length > 1 && <span>{xLabel(data[data.length - 1])}</span>}
      </div>
    </div>
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="scroll-x">
      <table className="t">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface LinePoint {
  x: number;
  y: number;
  label?: string;
}

/** Single-series step line with crosshair tooltip, vertical markers (e.g. session starts) and a stop marker. */
export function LineChart({
  points,
  xMax,
  yLabel,
  xFormat,
  markers = [],
  stop,
  height = 220,
}: {
  points: LinePoint[];
  xMax: number;
  yLabel: string;
  xFormat: (x: number) => string;
  markers?: { x: number; label: string }[];
  stop?: { x: number; label: string } | null;
  height?: number;
}) {
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [points.length]);
  if (!points.length) return <p className="muted small">No findings recorded yet.</p>;
  const padL = 34,
    padB = 22,
    padT = 10,
    padR = 10;
  const yMax = Math.max(1, ...points.map((p) => p.y));
  const xm = Math.max(1, xMax, ...points.map((p) => p.x));
  const sx = (x: number) => padL + (x / xm) * (w - padL - padR);
  const sy = (y: number) => padT + (1 - y / yMax) * (height - padT - padB);
  // Step path: the count rises at each new finding.
  let d = `M ${sx(0)} ${sy(0)}`;
  let prevY = 0;
  for (const p of points) {
    d += ` L ${sx(p.x)} ${sy(prevY)} L ${sx(p.x)} ${sy(p.y)}`;
    prevY = p.y;
  }
  d += ` L ${sx(xm)} ${sy(prevY)}`;
  const ticks = [0, Math.round(yMax / 2), yMax];
  const nearest = hover === null ? null : points.reduce((a, p) => (Math.abs(sx(p.x) - hover) < Math.abs(sx(a.x) - hover) ? p : a), points[0]);
  const valueAt = (px: number) => {
    const x = ((px - padL) / (w - padL - padR)) * xm;
    return { x, y: [...points].reverse().find((p) => p.x <= x)?.y ?? 0 };
  };
  const at = hover === null ? null : valueAt(hover);
  return (
    <div ref={ref} className="line-wrap" style={{ position: 'relative' }}>
      <svg width={w} height={height} role="img" aria-label={`${yLabel} over time`} onMouseMove={(e) => setHover(e.nativeEvent.offsetX)} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={w - padR} y1={sy(t)} y2={sy(t)} className="grid-line" />
            <text x={padL - 6} y={sy(t) + 4} textAnchor="end" className="axis-text">
              {t}
            </text>
          </g>
        ))}
        {markers.map((m, i) => (
          <g key={i}>
            <line x1={sx(m.x)} x2={sx(m.x)} y1={padT} y2={height - padB} className="marker-line" />
          </g>
        ))}
        {stop && (
          <g>
            <line x1={sx(stop.x)} x2={sx(stop.x)} y1={padT} y2={height - padB} className="stop-line" />
            <text x={Math.min(sx(stop.x) - 4, w - padR - 4)} y={padT + 10} textAnchor="end" className="axis-text">
              {stop.label}
            </text>
          </g>
        )}
        <path d={d} className="line-path" fill="none" />
        {points.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={nearest === p ? 5 : 3} className="line-dot" />
        ))}
        <text x={padL} y={height - 4} className="axis-text">
          {xFormat(0)}
        </text>
        <text x={w - padR} y={height - 4} textAnchor="end" className="axis-text">
          {xFormat(xm)}
        </text>
        {hover !== null && hover > padL && <line x1={hover} x2={hover} y1={padT} y2={height - padB} className="crosshair" />}
      </svg>
      {hover !== null && at && hover > padL && (
        <div className="viz-tip" style={{ left: Math.min(hover + 12, w - 220), top: 8 }}>
          <b>{xFormat(at.x)}</b>
          <br />
          {at.y} {yLabel}
          {nearest?.label && (
            <>
              <br />
              <span className="small">latest: {nearest.label.slice(0, 60)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- horizontal stacked bar (one row) ----------------
export function StackBar({ parts, format }: { parts: { key: string; label: string; value: number; color: string }[]; format: (v: number) => string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <p className="muted small">Nothing recorded.</p>;
  return (
    <div className="stackbar-wrap" onMouseLeave={() => setTip(null)}>
      <div className="viz-legend" role="list">
        {parts.map((p) => (
          <span key={p.key} role="listitem" className="row small" style={{ gap: 6 }}>
            <i className="stat-mark" style={{ background: p.color }} /> {p.label} <b className="mono">{format(p.value)}</b>
          </span>
        ))}
      </div>
      <div className="stackbar">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <div
              key={p.key}
              className="stackbar-seg"
              style={{ flexGrow: p.value, background: p.color }}
              onMouseMove={(e) => {
                const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                setTip({
                  x: e.clientX - box.left + 10,
                  y: -46,
                  body: (
                    <>
                      <b>{p.label}</b>
                      <br />
                      {format(p.value)} · {Math.round((p.value / total) * 100)}%
                    </>
                  ),
                });
              }}
            />
          ))}
        <Tooltip tip={tip} />
      </div>
    </div>
  );
}

// ---------------- heatmap (coverage) ----------------
export function Heatmap({ rows, columns, cell, legend }: { rows: string[]; columns: { id: string; label: string; kind: string }[]; cell: (row: string, col: string) => { tested: boolean; bugs: number }; legend?: boolean }) {
  if (!rows.length || !columns.length) return <p className="muted small">No coverage recorded.</p>;
  const level = (n: number) => (n >= 4 ? 3 : n >= 2 ? 2 : 1);
  return (
    <div>
      {legend !== false && (
        <div className="viz-legend">
          <span className="row small" style={{ gap: 6 }}>
            <i className="stat-mark heat-untested" /> not tested
          </span>
          <span className="row small" style={{ gap: 6 }}>
            <i
              className="stat-mark"
              style={{
                background: 'var(--panel-2)',
                boxShadow: 'inset 0 0 0 1px var(--line)',
              }}
            />{' '}
            tested, no bugs
          </span>
          {[1, 2, 3].map((l) => (
            <span key={l} className="row small" style={{ gap: 6 }}>
              <i className="stat-mark" style={{ background: `var(--heat-${l})` }} /> {l === 1 ? '1 bug' : l === 2 ? '2–3 bugs' : '4+ bugs'}
            </span>
          ))}
        </div>
      )}
      <div className="scroll-x">
        <table className="heatmap">
          <thead>
            <tr>
              <th />
              {columns.map((c) => (
                <th key={c.id} title={c.label}>
                  <span>{c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r}>
                <th className="mono small">{r}</th>
                {columns.map((c) => {
                  const v = cell(r, c.id);
                  const l = level(v.bugs);
                  return (
                    <td
                      key={c.id}
                      title={`${r} · ${c.label}: ${v.tested ? `${v.bugs} active bug${v.bugs === 1 ? '' : 's'}` : 'not tested'}`}
                      className={v.tested ? '' : 'heat-untested'}
                      style={
                        v.bugs
                          ? {
                              background: `var(--heat-${l})`,
                              color: `var(--heat-text-${l})`,
                            }
                          : v.tested
                            ? { background: 'var(--panel-2)' }
                            : undefined
                      }
                    >
                      {v.bugs || ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Two-to-four step lines on one axis (e.g. discovery curves of two runs): legend, end labels, crosshair tooltip. */
export function MultiLineChart({ series, yLabel, xFormat, height = 240 }: { series: { key: string; label: string; color: string; points: LinePoint[]; stop?: number | null }[]; yLabel: string; xFormat: (x: number) => string; height?: number }) {
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const all = series.flatMap((s) => s.points);
  const padL = 34,
    padB = 22,
    padT = 10,
    padR = 64;
  const yMax = Math.max(1, ...all.map((p) => p.y));
  const xm = Math.max(1, ...all.map((p) => p.x), ...series.map((s) => s.stop ?? 0));
  const sx = (x: number) => padL + (x / xm) * (w - padL - padR);
  const sy = (y: number) => padT + (1 - y / yMax) * (height - padT - padB);
  const end = (s: (typeof series)[number]) => Math.max(s.stop ?? 0, s.points[s.points.length - 1]?.x ?? 0);
  const pathOf = (s: (typeof series)[number]) => {
    let d = `M ${sx(0)} ${sy(0)}`;
    let prev = 0;
    for (const p of s.points) {
      d += ` L ${sx(p.x)} ${sy(prev)} L ${sx(p.x)} ${sy(p.y)}`;
      prev = p.y;
    }
    return d + ` L ${sx(end(s))} ${sy(prev)}`;
  };
  const valueAt = (s: (typeof series)[number], x: number) => (x > end(s) ? null : ([...s.points].reverse().find((p) => p.x <= x)?.y ?? 0));
  const hx = hover === null ? null : ((hover - padL) / (w - padL - padR)) * xm;
  const ticks = [0, Math.round(yMax / 2), yMax];
  // End labels: nudge apart when two lines end at nearly the same height.
  const labels = series.map((s) => ({ s, y: sy(s.points[s.points.length - 1]?.y ?? 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  if (!all.length) return <p className="muted small">No findings recorded in either run.</p>;
  return (
    <div className="cols-wrap">
      <div className="viz-legend" role="list">
        {series.map((s) => (
          <span key={s.key} role="listitem" className="row small" style={{ gap: 6 }}>
            <i className="stat-mark" style={{ background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
      <div ref={ref} className="line-wrap" style={{ position: 'relative' }}>
        <svg width={w} height={height} role="img" aria-label={`${yLabel} over time for ${series.map((s) => s.label).join(' and ')}`} onMouseMove={(e) => setHover(e.nativeEvent.offsetX)} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={sy(t)} y2={sy(t)} className="grid-line" />
              <text x={padL - 6} y={sy(t) + 4} textAnchor="end" className="axis-text">
                {t}
              </text>
            </g>
          ))}
          {series.map((s) => (
            <path key={s.key} d={pathOf(s)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
          ))}
          {labels.map(({ s, y }) => (
            <text key={s.key} x={Math.min(sx(end(s)) + 6, w - padR + 6)} y={y + 4} className="axis-text">
              {s.label.length > 9 ? s.label.slice(0, 8) + '…' : s.label}
            </text>
          ))}
          <text x={padL} y={height - 4} className="axis-text">
            {xFormat(0)}
          </text>
          <text x={w - padR} y={height - 4} textAnchor="end" className="axis-text">
            {xFormat(xm)}
          </text>
          {hover !== null && hover > padL && hover < w - padR && <line x1={hover} x2={hover} y1={padT} y2={height - padB} className="crosshair" />}
        </svg>
        {hx !== null && hover !== null && hover > padL && hover < w - padR && (
          <div className="viz-tip" style={{ left: Math.min(hover + 12, w - 200), top: 8 }}>
            <b>{xFormat(hx)}</b>
            {series.map((s) => (
              <div key={s.key} className="row" style={{ gap: 6 }}>
                <i className="stat-mark" style={{ background: s.color }} /> {s.label}: {valueAt(s, hx) ?? 'ended'}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
