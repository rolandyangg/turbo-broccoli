import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { fileUrl, useApi } from '../lib/api.ts';
import type { RunSummary } from '../lib/types.ts';
import { targetName } from '../lib/format.ts';
import { Chip, ErrorBox, Loading, SevChip, Stat, Tabs } from '../components/ui.tsx';
import { ChartCard, DataTable, MultiLineChart } from '../components/Charts.tsx';
import { SyncedViewer } from '../components/SyncedViewer.tsx';
import { ImageViewer } from '../components/ImageViewer.tsx';
import { runLabel } from './Dashboard.tsx';
import { compact, dur, usd } from '../components/AgentsView.tsx';

type DiffKind = 'regressed' | 'new' | 'still-open' | 'fixed' | 'not-found' | 'not-tested';
interface Brief {
  id: string;
  title: string;
  type: string;
  page: string;
  severity: string;
  status: string;
  functional: boolean;
  shot: string | null;
  widths: number[];
  browsers: string[];
}
interface Entry {
  kind: DiffKind;
  fingerprint: string;
  group: { id: string; summary: string; side: 'a' | 'b' } | null;
  a: Brief | null;
  b: Brief | null;
  severity_change: { from: string; to: string; direction: 'worse' | 'better' } | null;
}
interface Metrics {
  cost_usd: number;
  tokens: number;
  sessions: number;
  wall_ms: number | null;
  raw: number;
  real_bugs: number;
  precision: number | null;
  cost_per_real_bug: number | null;
  tool_error_rate: number | null;
  pages: number;
  tested_cells: number;
  total_cells: number;
}
interface Meta {
  ws: string;
  run: string;
  name: string | null;
  target: string;
  started_at: string;
}
interface CompareData {
  a: Meta;
  b: Meta;
  same_target: boolean;
  counts: Record<DiffKind, number>;
  entries: Entry[];
  metrics: { a: Metrics; b: Metrics };
  discovery: { a: { points: { x: number; y: number; label?: string }[]; stop_ms: number | null }; b: { points: { x: number; y: number; label?: string }[]; stop_ms: number | null } };
}

const KINDS: { id: DiffKind; label: string; help: string }[] = [
  { id: 'regressed', label: 'Regressed', help: 'Fixed before (or marked regressed), back in B.' },
  { id: 'new', label: 'New in B', help: 'Not in A.' },
  { id: 'still-open', label: 'Still open', help: 'In both runs. Severity changes are marked.' },
  { id: 'fixed', label: 'Fixed', help: 'Marked fixed in A or B, and not open in B.' },
  { id: 'not-found', label: 'Not found in B', help: 'B tested the page but did not report it. It may be fixed, or B missed it.' },
  { id: 'not-tested', label: 'Not re-tested', help: 'B never visited the page.' },
];

/** Compare two triaged runs: bug diff, side-by-side evidence (synced zoom), and agent metrics. */
export function Compare() {
  const [params, setParams] = useSearchParams();
  const { data: runs, error: runsErr } = useApi<RunSummary[]>('/runs');
  const triaged = useMemo(() => (runs ?? []).filter((r) => r.triaged), [runs]);
  const bSel = params.get('b') ?? (triaged[0] ? `${triaged[0].ws}/${triaged[0].run}` : '');
  // Default A: the previous triaged run of B's target.
  const aSel =
    params.get('a') ??
    (() => {
      const b = triaged.find((r) => `${r.ws}/${r.run}` === bSel);
      const prev = triaged.filter((r) => b && r.target_key === b.target_key && r.started_at < b.started_at).sort((x, y) => y.started_at.localeCompare(x.started_at))[0];
      return prev ? `${prev.ws}/${prev.run}` : '';
    })();
  const set = (k: 'a' | 'b', v: string) => setParams({ a: k === 'a' ? v : aSel, b: k === 'b' ? v : bSel });
  const ready = aSel && bSel && aSel !== bSel;
  const { data, error } = useApi<CompareData>(ready ? `/compare?a=${encodeURIComponent(aSel)}&b=${encodeURIComponent(bSel)}` : null);

  return (
    <>
      <div className="run-head">
        <div className="label">
          <Link to="/runs">Runs</Link> / Compare
        </div>
        <h1 className="page-title">Compare runs</h1>
      </div>
      {runsErr && <ErrorBox error={runsErr} />}
      <div className="compare-pick">
        <RunPicker label="A (before)" color="var(--cmp-a)" runs={triaged} value={aSel} onChange={(v) => set('a', v)} />
        <button className="btn-ghost" onClick={() => setParams({ a: bSel, b: aSel })} aria-label="Swap A and B" disabled={!aSel || !bSel}>
          ⇄ Swap
        </button>
        <RunPicker label="B (after)" color="var(--cmp-b)" runs={triaged} value={bSel} onChange={(v) => set('b', v)} />
      </div>
      {!ready && runs && <div className="empty" style={{ marginTop: 20 }}>{triaged.length < 2 ? 'You need two triaged runs to compare.' : aSel === bSel ? 'Pick two different runs.' : 'Pick a run for A and B.'}</div>}
      {ready && error && <ErrorBox error={error} />}
      {ready && !data && !error && <Loading what="Comparing" />}
      {ready && data && <CompareBody d={data} />}
    </>
  );
}

function RunPicker({ label, color, runs, value, onChange }: { label: string; color: string; runs: RunSummary[]; value: string; onChange: (v: string) => void }) {
  const byTarget = new Map<string, RunSummary[]>();
  for (const r of runs) byTarget.set(r.target_key, [...(byTarget.get(r.target_key) ?? []), r]);
  return (
    <label className="field" style={{ flex: '1 1 260px', minWidth: 0 }}>
      <span className="label row" style={{ gap: 6 }}>
        <i className="stat-mark" style={{ background: color }} /> {label}
      </span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick a triaged run…</option>
        {[...byTarget.entries()].map(([k, rs]) => (
          <optgroup key={k} label={targetName(rs[0].target)}>
            {rs.map((r) => (
              <option key={`${r.ws}/${r.run}`} value={`${r.ws}/${r.run}`}>
                {runLabel(r)} · {r.counts.active} active
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function CompareBody({ d }: { d: CompareData }) {
  const [functional, setFunctional] = useState(false);
  const entries = d.entries.filter((e) => functional || !(e.b ?? e.a)!.functional);
  const count = (k: DiffKind) => entries.filter((e) => e.kind === k).length;
  const first = KINDS.find((k) => count(k.id))?.id ?? 'new';
  const [tab, setTab] = useState<DiffKind | null>(null);
  const cur = tab ?? first;
  const [viewer, setViewer] = useState<Entry | null>(null);
  const aName = d.a.name ?? runLabel(d.a);
  const bName = d.b.name ?? runLabel(d.b);
  const rows = entries.filter((e) => e.kind === cur);
  const groups = new Map<string, Entry[]>();
  for (const e of rows) {
    const k = e.group ? `${e.group.side}:${e.group.id}` : 'none';
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const m = d.metrics;
  const change = (a: number | null, b: number | null, fmt: (n: number) => string, higherIsBetter: boolean | null) => {
    if (a == null || b == null) return '—';
    if (Math.abs(b - a) < 1e-9) return 'same';
    const up = b > a;
    const word = higherIsBetter == null ? '' : up === higherIsBetter ? ' (better)' : ' (worse)';
    return `${up ? '▲' : '▼'} ${fmt(Math.abs(b - a))}${word}`;
  };
  const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

  return (
    <div className="stack" style={{ ['--gap' as string]: '22px', marginTop: 18 }}>
      {!d.same_target && (
        <div className="empty" style={{ color: 'var(--warn)' }}>
          These runs are of different targets ({targetName(d.a.target)} vs {targetName(d.b.target)}), so almost nothing will match.
        </div>
      )}
      <div className="stats">
        {KINDS.map((k) => (
          <Stat key={k.id} n={count(k.id)} label={k.label} color={k.id === 'regressed' && count(k.id) ? 'var(--err)' : undefined} />
        ))}
      </div>

      <section>
        <div className="spread" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
          <Tabs<DiffKind> tabs={KINDS.map((k) => ({ id: k.id, label: `${k.label} (${count(k.id)})` }))} value={cur} onChange={setTab} />
          <label className="check small">
            <input type="checkbox" checked={functional} onChange={(e) => setFunctional(e.target.checked)} /> Include functional bugs
          </label>
        </div>
        <p className="small muted" style={{ margin: '10px 0 14px' }}>
          {KINDS.find((k) => k.id === cur)?.help}
        </p>
        {!rows.length && <div className="empty">Nothing here.</div>}
        <div className="stack" style={{ ['--gap' as string]: '16px' }}>
          {[...groups.entries()].map(([k, es]) => (
            <div key={k} className="box">
              <div className="box-head">
                <div className="path">{es[0].group ? `${es[0].group.id} · ${es[0].group.summary}` : 'Ungrouped'}</div>
                <Chip>{es.length}</Chip>
              </div>
              <div className="cmp-rows">
                {es.map((e) => (
                  <DiffRow key={e.fingerprint} e={e} d={d} onOpen={() => setViewer(e)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="dash-grid">
        <div className="span-2">
          <ChartCard
            title="Discovery: unique bugs over time"
            sub="A curve still climbing at its end means more sessions would likely have found more."
            table={<DataTable head={['Run', 'Bugs at end', 'Run time']} rows={[[aName, d.discovery.a.points.at(-1)?.y ?? 0, dur(d.discovery.a.stop_ms)], [bName, d.discovery.b.points.at(-1)?.y ?? 0, dur(d.discovery.b.stop_ms)]]} />}
          >
            <MultiLineChart
              yLabel="unique bugs"
              xFormat={(x) => dur(x)}
              series={[
                { key: 'a', label: `A: ${aName}`, color: 'var(--cmp-a)', points: d.discovery.a.points, stop: d.discovery.a.stop_ms },
                { key: 'b', label: `B: ${bName}`, color: 'var(--cmp-b)', points: d.discovery.b.points, stop: d.discovery.b.stop_ms },
              ]}
            />
          </ChartCard>
        </div>
        <ChartCard title="Agent metrics">
          <DataTable
            head={['Metric', 'A', 'B', 'Change']}
            rows={[
              ['Cost (API-equivalent)', usd(m.a.cost_usd), usd(m.b.cost_usd), change(m.a.cost_usd, m.b.cost_usd, usd, false)],
              ['Tokens', compact(m.a.tokens), compact(m.b.tokens), change(m.a.tokens, m.b.tokens, compact, null)],
              ['Explorer sessions', m.a.sessions, m.b.sessions, change(m.a.sessions, m.b.sessions, String, null)],
              ['Wall time', dur(m.a.wall_ms), dur(m.b.wall_ms), change(m.a.wall_ms, m.b.wall_ms, (n) => dur(n), false)],
              ['Raw findings', m.a.raw, m.b.raw, change(m.a.raw, m.b.raw, String, null)],
              ['Real bugs', m.a.real_bugs, m.b.real_bugs, change(m.a.real_bugs, m.b.real_bugs, String, null)],
              ['Precision', pct(m.a.precision), pct(m.b.precision), change(m.a.precision, m.b.precision, (n) => `${Math.round(n * 100)} pts`, true)],
              ['Cost per real bug', usd(m.a.cost_per_real_bug), usd(m.b.cost_per_real_bug), change(m.a.cost_per_real_bug, m.b.cost_per_real_bug, usd, false)],
              ['Tool error rate', pct(m.a.tool_error_rate), pct(m.b.tool_error_rate), change(m.a.tool_error_rate, m.b.tool_error_rate, (n) => `${Math.round(n * 100)} pts`, false)],
              ['Pages covered', m.a.pages, m.b.pages, change(m.a.pages, m.b.pages, String, true)],
              ['Page × size cells tested', `${m.a.tested_cells}/${m.a.total_cells}`, `${m.b.tested_cells}/${m.b.total_cells}`, change(m.a.tested_cells, m.b.tested_cells, String, true)],
            ]}
          />
        </ChartCard>
      </div>

      {viewer &&
        (viewer.a && viewer.b ? (
          <SyncedViewer
            title={`${viewer.b.id}: ${viewer.b.title}`}
            left={{ src: viewer.a.shot ? fileUrl(d.a.ws, d.a.run, viewer.a.shot) : null, label: `A · ${viewer.a.id} · ${aName}` }}
            right={{ src: viewer.b.shot ? fileUrl(d.b.ws, d.b.run, viewer.b.shot) : null, label: `B · ${viewer.b.id} · ${bName}` }}
            onClose={() => setViewer(null)}
          />
        ) : (
          <ImageViewer
            images={[viewer.a ? { src: fileUrl(d.a.ws, d.a.run, viewer.a.shot), label: `A · ${viewer.a.id} · ${aName}` } : { src: fileUrl(d.b.ws, d.b.run, viewer.b!.shot), label: `B · ${viewer.b!.id} · ${bName}` }]}
            index={0}
            onIndex={() => {}}
            onClose={() => setViewer(null)}
          />
        ))}
    </div>
  );
}

function DiffRow({ e, d, onOpen }: { e: Entry; d: CompareData; onOpen: () => void }) {
  const f = (e.b ?? e.a)!;
  const link = (side: 'a' | 'b') => {
    const b = side === 'a' ? e.a : e.b;
    const m = side === 'a' ? d.a : d.b;
    return b ? (
      <Link to={`/runs/${m.ws}/${encodeURIComponent(m.run)}/bugs/${b.id}`} className="mono small">
        {side.toUpperCase()} {b.id}
      </Link>
    ) : null;
  };
  const thumb = (side: 'a' | 'b') => {
    const b = side === 'a' ? e.a : e.b;
    const m = side === 'a' ? d.a : d.b;
    if (!b) return <div className="cmp-thumb empty-thumb small muted">not in {side.toUpperCase()}</div>;
    return b.shot ? (
      <button className="cmp-thumb" onClick={onOpen} aria-label={`Open ${side.toUpperCase()} screenshot of ${b.id}${e.a && e.b ? ' side by side' : ''}`}>
        <img src={fileUrl(m.ws, m.run, b.shot)} alt="" loading="lazy" />
        <span className={`cmp-side ${side}`}>{side.toUpperCase()}</span>
      </button>
    ) : (
      <div className="cmp-thumb empty-thumb small muted">no screenshot</div>
    );
  };
  return (
    <div className="cmp-row">
      <div className="cmp-info">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <SevChip sev={f.severity} />
          {e.severity_change && (
            <Chip tone="outline">
              was {e.severity_change.from} ({e.severity_change.direction})
            </Chip>
          )}
          {f.functional && <Chip tone="outline">functional</Chip>}
          {link('a')}
          {link('b')}
        </div>
        <div className="cmp-title">{f.title}</div>
        <div className="small muted">
          {f.type} · {f.page}
          {f.widths.length ? ` · ${f.widths[0]}${f.widths.length > 1 ? `–${f.widths[f.widths.length - 1]}` : ''}px` : ''} · {f.browsers.join(', ')}
        </div>
      </div>
      <div className="cmp-thumbs">
        {thumb('a')}
        {thumb('b')}
      </div>
    </div>
  );
}
