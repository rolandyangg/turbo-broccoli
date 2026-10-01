import { useState, type ReactNode } from 'react';
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

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

/** Stacked columns over time (e.g. active findings per run by severity). Legend always shown for ≥2 series. */
export function StackedColumns({ data, series, xLabel, href, height = 200, highlight = null }: { data: (Record<string, number | string | boolean | null | undefined> & { id: string })[]; series: StackSeries[]; xLabel: (d: Record<string, unknown>) => string; href?: (d: Record<string, unknown>) => string; height?: number; highlight?: string | null }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const totals = data.map((d) => series.reduce((a, s) => a + (Number(d[s.key]) || 0), 0));
  const max = Math.max(1, ...totals);
  const niceMax = max <= 5 ? 5 : Math.ceil(max / 5) * 5;
  const ticks = [0, niceMax / 2, niceMax];
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
              <span className="mono">{t}</span>
            </div>
          ))}
        </div>
        <div className="cols-plot">
          {data.map((d, i) => {
            const col = (
              <div
                className={`col ${hover === d.id ? 'on' : ''} ${highlight ? (highlight === d.id ? 'selected' : 'dim') : ''}`}
                aria-label={`${xLabel(d)}: ${totals[i]} findings`}
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
                        {totals[i]} active
                        {series.map((s) =>
                          Number(d[s.key]) ? (
                            <div key={s.key} className="row" style={{ gap: 6 }}>
                              <i className="stat-mark" style={{ background: s.color }} /> {s.label}: {Number(d[s.key])}
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
