import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { Chip, ErrorBox, Loading, Stat } from './ui.tsx';
import { ChartCard, DataTable, HBars, Heatmap, LineChart, StackBar, StackedColumns, type StackSeries } from './Charts.tsx';

type Tokens = {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  thinking: number;
};
interface Phase {
  phase: string;
  cost_usd: number;
  tokens: Tokens;
  ms: number;
  api_ms: number;
  agents: number;
}
interface Explorer {
  id: string;
  persona: string | null;
  browser: string;
  device: string | null;
  device_kind: string;
  goal: string;
  status: string;
  model: string | null;
  ms: number;
  cost_usd: number;
  tokens: Tokens;
  tool_calls: number;
  tool_errors: number;
  blocked: number;
  raw: number;
  survived: number;
  flaky: number;
  low_confidence: number;
  false_positive: number;
  unique_new: number;
  first_finding_ms: number | null;
  bugs_per_10_calls: number | null;
  hypotheses: { confirmed: number; refuted: number; inconclusive: number };
  observes: number;
  new_states: number;
  recoveries: number;
  error: string | null;
}
interface Breakdown {
  key: string;
  sessions: number;
  raw: number;
  survived: number;
  cost_usd: number;
  precision: number | null;
}
interface RunStats {
  run: {
    run: string;
    name: string | null;
    target: string;
    started_at: string;
    ended_at: string | null;
    stop_reason: string | null;
  };
  kpis: {
    cost_usd: number;
    tokens: number;
    tokens_detail: Tokens;
    wall_ms: number | null;
    agent_ms: number;
    sessions: number;
    real_bugs: number;
    cost_per_real_bug: number | null;
    precision: number | null;
    tool_error_rate: number | null;
  };
  phases: Phase[];
  explorers: Explorer[];
  lead: { cost_usd: number; turns: number; decisions: number } | null;
  by: { persona: Breakdown[]; browser: Breakdown[]; device_kind: Breakdown[] };
  discovery: {
    points: { t_ms: number; unique: number; session: string; title: string }[];
    sessions: {
      id: string;
      start_ms: number;
      end_ms: number | null;
      persona: string | null;
    }[];
    stop_ms: number | null;
    stop_reason: string | null;
  };
  coverage: {
    pages: string[];
    columns: { id: string; label: string; kind: string }[];
    cells: Record<string, Record<string, { tested: boolean; bugs: number }>>;
  };
  strategies: {
    id: string;
    pages: number;
    hypotheses: number;
    raw: number;
    survived: number;
  }[];
  tools: {
    name: string;
    calls: number;
    errors: number;
    blocked: number;
    p50_ms: number | null;
    p95_ms: number | null;
  }[];
  tools_timed: boolean;
  triage: {
    triaged: boolean;
    ms: number | null;
    cost_usd: number;
    raw: number;
    clusters: number;
    duplicate_rate: number | null;
    verifiable_pct: number | null;
    rate_dist: Record<string, number>;
    minimization_avg: number | null;
    reviewer: {
      defect: number;
      not_defect: number;
      unavailable: number;
      skipped: number;
    };
    videos: number;
    rerecorded: number | null;
    grouping: string | null;
    statuses: Record<string, number>;
  };
  reliability: {
    failed_sessions: number;
    limit_stops: number;
    recoveries: number;
    tool_errors: number;
    guardrail_blocks: number;
    persona_refusals: number;
    selection_refusals: number;
    hypothesis_checkins?: number;
    budget_exhausted: number;
    reviewer_unavailable: number;
    tool_logging: boolean;
  };
  fixes: {
    job: string;
    findings: string[];
    state: string;
    attempts: number;
    verified: boolean | null;
    regressions: number;
    ms: number;
    cost_usd: number;
    branch: string | null;
    pr_url: string | null;
    error: string | null;
  }[];
}
interface Accuracy {
  labels: number;
  precision_by_type: {
    type: string;
    confirmed: number;
    false_positive: number;
    precision: number | null;
  }[];
  calibration: { bin: string; count: number; precision: number | null }[] | null;
  bench: {
    run: string;
    recall: number;
    precision: number | null;
    recall_by_kind: Record<string, string>;
    sessions: number;
    version: string | null;
  }[];
}
type AgentsResponse =
  | { scope: 'run'; stats: RunStats; accuracy: Accuracy }
  | {
      scope: 'all';
      runs: {
        ws: string;
        run: string;
        name: string | null;
        target: string;
        started_at: string;
        triaged: boolean;
        cost_usd: number;
        tokens: number;
        phases: Record<string, number>;
        sessions: number;
        raw: number;
        real_bugs: number;
        precision: number | null;
        cost_per_real_bug: number | null;
        wall_ms: number | null;
        tool_error_rate: number | null;
        failed_sessions: number;
        reviewer_unavailable: number;
      }[];
      totals: {
        cost_usd: number;
        tokens: number;
        sessions: number;
        raw: number;
        real_bugs: number;
        runs: number;
      };
      accuracy: Accuracy | null;
    };

const PHASES: StackSeries[] = [
  { key: 'lead', label: 'Lead', color: 'var(--phase-lead)' },
  { key: 'explore', label: 'Explorers', color: 'var(--phase-explore)' },
  { key: 'triage', label: 'Triage', color: 'var(--phase-triage)' },
  { key: 'fix', label: 'Fix', color: 'var(--phase-fix)' },
];

export const usd = (n: number | null | undefined) => (n == null ? '—' : n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`);
export const compact = (n: number | null | undefined) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
export const dur = (ms: number | null | undefined) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const pctS = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`);

export function AgentsView({ scope }: { scope: { ws: string; run: string } | null }) {
  const q = scope ? `/agents?ws=${scope.ws}&run=${encodeURIComponent(scope.run)}` : '/agents';
  const { data, error } = useApi<AgentsResponse>(q, { pollMs: 10000 });
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what="Loading agent metrics" />;
  return data.scope === 'run' ? <RunAgents s={data.stats} acc={data.accuracy} /> : <AllAgents d={data} />;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="kpi-note" style={{ margin: '6px 0 0' }}>
      {children}
    </p>
  );
}

// ---------------- single run ----------------
function RunAgents({ s, acc }: { s: RunStats; acc: Accuracy }) {
  const k = s.kpis;
  return (
    <div className="stack" style={{ ['--gap' as string]: '20px', marginTop: 20 }}>
      <div className="stats">
        <Stat n={usd(k.cost_usd)} label="API-equivalent cost" sub="covered by your subscription" />
        <Stat n={compact(k.tokens)} label="Tokens" sub={`${compact(k.tokens_detail.cache_read)} cache reads`} />
        <Stat n={dur(k.agent_ms)} label="Agent time" sub={`wall clock ${dur(k.wall_ms)}`} />
        <Stat n={k.sessions} label="Explorer sessions" />
        <Stat n={k.real_bugs} label="Real bugs" sub="survived triage" />
        <Stat n={usd(k.cost_per_real_bug)} label="Cost per real bug" />
        <Stat n={pctS(k.precision)} label="Precision" sub="raw findings that survived" />
        <Stat n={pctS(k.tool_error_rate)} label="Tool error rate" />
      </div>

      <div className="dash-grid">
        <div className="span-2">
          <ChartCard
            title="Cost & effort by phase"
            sub="API-equivalent dollars; tokens include cached input."
            table={
              <DataTable
                head={['Phase', 'Agents', 'Cost', 'Input', 'Cache read', 'Cache write', 'Output', 'Thinking', 'Agent time']}
                rows={s.phases.map((p) => [
                  PHASES.find((x) => x.key === p.phase)?.label ?? p.phase,
                  p.agents,
                  usd(p.cost_usd),
                  compact(p.tokens.input),
                  compact(p.tokens.cache_read),
                  compact(p.tokens.cache_write),
                  compact(p.tokens.output),
                  compact(p.tokens.thinking),
                  dur(p.ms),
                ])}
              />
            }
          >
            <StackBar
              parts={PHASES.map((ph) => ({
                key: ph.key,
                label: ph.label,
                value: s.phases.find((p) => p.phase === ph.key)?.cost_usd ?? 0,
                color: ph.color,
              }))}
              format={usd}
            />
            <div className="grid-4" style={{ marginTop: 14 }}>
              {s.phases.map((p) => (
                <div key={p.phase} className="small">
                  <div className="label">{PHASES.find((x) => x.key === p.phase)?.label}</div>
                  <b className="mono">{usd(p.cost_usd)}</b> · {compact(tokenSum(p.tokens))} tok · {dur(p.ms)}
                </div>
              ))}
            </div>
            {s.triage.triaged && s.phases.find((p) => p.phase === 'triage')?.agents === 0 && <Note>Triage cost isn't available for this run (recorded from now on).</Note>}
          </ChartCard>
        </div>
        <ChartCard title="Reliability">
          <dl className="kv">
            <dt>Failed sessions</dt>
            <dd>{s.reliability.failed_sessions}</dd>
            <dt>Usage-limit stops</dt>
            <dd>{s.reliability.limit_stops}</dd>
            <dt>Browser recoveries</dt>
            <dd>{s.reliability.recoveries}</dd>
            <dt>Tool errors</dt>
            <dd>{s.reliability.tool_errors}</dd>
            <dt>Guardrail blocks</dt>
            <dd>{s.reliability.guardrail_blocks}</dd>
            <dt>Persona refusals</dt>
            <dd>{s.reliability.persona_refusals}</dd>
            <dt>Selection refusals</dt>
            <dd>{s.reliability.selection_refusals}</dd>
            <dt>Hypothesis check-ins forced</dt>
            <dd>{s.reliability.hypothesis_checkins ?? 0}</dd>
            <dt>Budget exhausted</dt>
            <dd>{s.reliability.budget_exhausted} sessions</dd>
            <dt>Reviewer unavailable</dt>
            <dd style={s.reliability.reviewer_unavailable ? { color: 'var(--err)', fontWeight: 700 } : undefined}>{s.reliability.reviewer_unavailable}</dd>
          </dl>
          {!s.reliability.tool_logging && <Note>Tool timing isn't available for this run (recorded from now on).</Note>}
        </ChartCard>
      </div>

      <Leaderboard rows={s.explorers} />

      <div className="dash-grid">
        {(
          [
            ['persona', 'By persona'],
            ['browser', 'By browser'],
            ['device_kind', 'By device kind'],
          ] as const
        ).map(([key, title]) => (
          <ChartCard
            key={key}
            title={title}
            sub="Bugs that survived triage (precision in brackets)."
            table={<DataTable head={['Group', 'Sessions', 'Raw', 'Survived', 'Precision', 'Cost']} rows={s.by[key].map((r) => [r.key, r.sessions, r.raw, r.survived, pctS(r.precision), usd(r.cost_usd)])} />}
          >
            <HBars
              rows={s.by[key].map((r) => ({
                key: r.key,
                label: `${r.key} (${pctS(r.precision)})`,
                count: r.survived,
              }))}
              unit=" bugs"
            />
          </ChartCard>
        ))}
      </div>

      <ChartCard
        title="Discovery curve: unique bugs over time"
        sub={`Dotted lines mark explorer session starts. ${s.discovery.stop_reason ? `Stopped: ${s.discovery.stop_reason.slice(0, 160)}` : ''}`}
        table={<DataTable head={['Time', 'Unique bugs', 'Session', 'Finding']} rows={s.discovery.points.map((p) => [dur(p.t_ms), p.unique, p.session, p.title])} />}
      >
        <LineChart
          points={s.discovery.points.map((p) => ({
            x: p.t_ms,
            y: p.unique,
            label: `${p.session}: ${p.title}`,
          }))}
          xMax={Math.max(s.discovery.stop_ms ?? 0, ...s.discovery.points.map((p) => p.t_ms))}
          yLabel="unique bugs"
          xFormat={(x) => dur(x)}
          markers={s.discovery.sessions.map((x) => ({
            x: x.start_ms,
            label: x.id,
          }))}
          stop={s.discovery.stop_ms ? { x: s.discovery.stop_ms, label: 'stopped' } : null}
        />
        <Note>A curve still climbing when the run stopped means more sessions would likely find more bugs.</Note>
      </ChartCard>

      <ChartCard
        title="Coverage: pages × devices and sizes"
        sub="Numbers are active bugs found there. Hatched = never tested."
        table={<DataTable head={['Page', ...s.coverage.columns.map((c) => c.label)]} rows={s.coverage.pages.map((p) => [p, ...s.coverage.columns.map((c) => (s.coverage.cells[p]?.[c.id]?.tested ? s.coverage.cells[p][c.id].bugs : '—'))])} />}
      >
        <Heatmap rows={s.coverage.pages} columns={s.coverage.columns} cell={(r, c) => s.coverage.cells[r]?.[c] ?? { tested: false, bugs: 0 }} />
      </ChartCard>

      <div className="dash-grid">
        <ChartCard
          title="Strategies"
          sub="Pages tried on, hypotheses, raw → surviving findings."
          table={<DataTable head={['Strategy', 'Pages', 'Hypotheses', 'Raw', 'Survived']} rows={s.strategies.map((x) => [x.id, x.pages, x.hypotheses, x.raw, x.survived])} />}
        >
          <HBars rows={s.strategies.slice(0, 10).map((x) => ({ key: x.id, label: x.id, count: x.survived }))} unit=" surviving bugs" empty="No strategy data." />
        </ChartCard>
        <div className="span-2">
          <ChartCard title="Tool usage" sub={s.tools_timed ? 'Calls, errors, refusals and latency per browser tool.' : 'Calls per tool (latency is recorded from new runs on).'}>
            <DataTable
              head={['Tool', 'Calls', 'Errors', 'Refused', 'p50', 'p95']}
              rows={s.tools.map((t) => [<span className="mono small">{t.name}</span>, t.calls, t.errors || '', t.blocked || '', t.p50_ms == null ? '—' : `${t.p50_ms}ms`, t.p95_ms == null ? '—' : `${t.p95_ms}ms`])}
            />
          </ChartCard>
        </div>
      </div>

      <div className="dash-grid">
        <div className="span-2">
          <ChartCard title="Triage quality" table={<DataTable head={['Reproduction', 'Findings']} rows={Object.entries(s.triage.rate_dist).map(([k, v]) => [k, v])} />}>
            {!s.triage.triaged ? (
              <p className="muted">Not triaged yet.</p>
            ) : (
              <>
                <div className="grid-4">
                  <Mini n={`${s.triage.raw} → ${s.triage.clusters}`} l="raw → unique" />
                  <Mini n={pctS(s.triage.duplicate_rate)} l="duplicates" />
                  <Mini n={pctS(s.triage.verifiable_pct)} l="auto-verifiable" />
                  <Mini n={s.triage.minimization_avg == null ? '—' : `${Math.round((1 - s.triage.minimization_avg) * 100)}%`} l="steps removed by minimizing" />
                  <Mini n={`${s.triage.reviewer.defect}/${s.triage.reviewer.defect + s.triage.reviewer.not_defect}`} l="reviewer agreed" />
                  <Mini n={s.triage.reviewer.unavailable} l="reviewer unavailable" warn={s.triage.reviewer.unavailable > 0} />
                  <Mini n={s.triage.videos} l={`videos${s.triage.rerecorded ? ` (${s.triage.rerecorded} re-recorded)` : ''}`} />
                  <Mini n={s.triage.grouping ?? '—'} l="root-cause grouping" />
                </div>
                <div className="label" style={{ margin: '14px 0 6px' }}>
                  Reproduction rate
                </div>
                <HBars
                  rows={Object.entries(s.triage.rate_dist).map(([k, v]) => ({
                    key: k,
                    label: k === 'n/a' ? 'not auto-verifiable' : `reproduced ${k}`,
                    count: v,
                  }))}
                  unit=" findings"
                />
              </>
            )}
          </ChartCard>
        </div>
        <ChartCard title="Fix agent">
          {s.fixes.length ? (
            <DataTable
              head={['Job', 'Findings', 'Result', 'Attempts', 'Cost']}
              rows={s.fixes.map((f) => [
                <Link to={`/jobs/${f.job}`} className="mono small">
                  {f.job.slice(-6)}
                </Link>,
                f.findings.join(', '),
                f.state === 'succeeded' ? (f.verified ? 'verified ✓' : 'unverified') : f.state,
                f.attempts,
                usd(f.cost_usd),
              ])}
            />
          ) : (
            <p className="muted small">No fixes started for this run.</p>
          )}
        </ChartCard>
      </div>

      <AccuracySection acc={acc} />
    </div>
  );
}

const tokenSum = (t: Tokens) => t.input + t.cache_read + t.cache_write + t.output;

function Mini({ n, l, warn }: { n: React.ReactNode; l: string; warn?: boolean }) {
  return (
    <div>
      <b className="mono" style={{ fontSize: 20, color: warn ? 'var(--err)' : undefined }}>
        {n}
      </b>
      <div className="small muted">{l}</div>
    </div>
  );
}

type SortKey = keyof Pick<Explorer, 'id' | 'persona' | 'browser' | 'cost_usd' | 'tool_calls' | 'raw' | 'survived' | 'unique_new' | 'first_finding_ms' | 'bugs_per_10_calls' | 'ms'>;
function Leaderboard({ rows }: { rows: Explorer[] }) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({
    k: 'survived',
    dir: -1,
  });
  const sorted = useMemo(() => [...rows].sort((a, b) => ((a[sort.k] ?? -1) > (b[sort.k] ?? -1) ? 1 : (a[sort.k] ?? -1) < (b[sort.k] ?? -1) ? -1 : 0) * sort.dir), [rows, sort]);
  const H = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th>
      <button className="th-sort" onClick={() => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : -1 }))} aria-sort={sort.k === k ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
        {children}
        {sort.k === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
  return (
    <div className="box">
      <div className="box-head">
        <div className="path">Explorer leaderboard</div>
        <Chip>{rows.length} sessions</Chip>
      </div>
      <div className="scroll-x">
        <table className="t">
          <thead>
            <tr>
              <H k="id">Session</H>
              <H k="persona">Persona</H>
              <H k="browser">Browser / device</H>
              <H k="cost_usd">Cost</H>
              <H k="tool_calls">Tool calls</H>
              <H k="raw">Raw</H>
              <H k="survived">Survived</H>
              <H k="unique_new">Unique new</H>
              <H k="bugs_per_10_calls">Bugs / 10 calls</H>
              <H k="first_finding_ms">First bug</H>
              <th>Hypotheses</th>
              <th>States</th>
              <H k="ms">Time</H>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => (
              <tr key={e.id}>
                <td className="mono small" title={e.goal}>
                  {e.id}
                </td>
                <td>{e.persona ?? '—'}</td>
                <td className="small">
                  {e.browser}
                  {e.device ? ` · ${e.device}` : ''}
                </td>
                <td className="mono small">{usd(e.cost_usd)}</td>
                <td>
                  {e.tool_calls}
                  {e.tool_errors ? (
                    <span className="small" style={{ color: 'var(--err)' }}>
                      {' '}
                      ({e.tool_errors} err)
                    </span>
                  ) : null}
                  {e.blocked ? <span className="small muted"> ({e.blocked} refused)</span> : null}
                </td>
                <td>{e.raw}</td>
                <td>
                  <b>{e.survived}</b>
                  {e.flaky + e.low_confidence + e.false_positive ? <span className="small muted"> (−{e.flaky + e.low_confidence + e.false_positive})</span> : null}
                </td>
                <td>{e.unique_new}</td>
                <td>{e.bugs_per_10_calls ?? '—'}</td>
                <td className="small">{dur(e.first_finding_ms)}</td>
                <td className="small">
                  {e.hypotheses.confirmed}✓ {e.hypotheses.refuted}✗ {e.hypotheses.inconclusive}?
                </td>
                <td className="small">
                  {e.new_states}/{e.observes}
                </td>
                <td className="small">{dur(e.ms)}</td>
                <td>{e.status === 'failed' ? <Chip tone="sev-critical dot">failed</Chip> : <Chip tone="outline">{e.status}</Chip>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AccuracySection({ acc }: { acc: Accuracy | null }) {
  if (!acc) return null;
  return (
    <div className="dash-grid">
      <ChartCard title="Precision by bug type" sub={`From your ${acc.labels} confirm / false-positive labels (and benchmark labels).`}>
        {acc.precision_by_type.length ? (
          <DataTable head={['Type', 'Confirmed', 'False positive', 'Precision']} rows={acc.precision_by_type.map((r) => [r.type, r.confirmed, r.false_positive, pctS(r.precision)])} />
        ) : (
          <p className="muted small">No labels yet. Confirm or dismiss bugs to build this.</p>
        )}
      </ChartCard>
      <ChartCard title="Confidence calibration" sub="Share of findings in each raw-confidence bin that were real.">
        {acc.calibration ? <DataTable head={['Raw confidence', 'Labeled', 'Precision']} rows={acc.calibration.map((r) => [r.bin, r.count, pctS(r.precision)])} /> : <p className="muted small">Not calibrated yet (`bugbash calibrate`).</p>}
      </ChartCard>
      <ChartCard title="Benchmark (seeded fixture)" sub="Recall of the 11 seeded bugs per benchmark run.">
        {acc.bench.length ? (
          <DataTable
            head={['Run', 'Recall', 'Static / interaction / temporal', 'Precision vs manifest']}
            rows={acc.bench.map((b) => [
              <span className="mono small" style={{ whiteSpace: 'nowrap' }}>
                {b.run
                  .slice(0, 16)
                  .replace('T', ' ')
                  .replace(/-(\d\d)$/, ':$1')}
              </span>,
              pctS(b.recall),
              Object.values(b.recall_by_kind ?? {}).join(' · '),
              pctS(b.precision),
            ])}
          />
        ) : (
          <p className="muted small">No benchmark runs yet (`bugbash bench`).</p>
        )}
      </ChartCard>
    </div>
  );
}

// ---------------- all runs ----------------
function AllAgents({ d }: { d: Extract<AgentsResponse, { scope: 'all' }> }) {
  const t = d.totals;
  return (
    <div className="stack" style={{ ['--gap' as string]: '20px', marginTop: 20 }}>
      <div className="stats">
        <Stat n={usd(t.cost_usd)} label="API-equivalent cost" sub={`${t.runs} runs`} />
        <Stat n={compact(t.tokens)} label="Tokens" />
        <Stat n={t.sessions} label="Explorer sessions" />
        <Stat n={t.raw} label="Raw findings" />
        <Stat n={t.real_bugs} label="Real bugs" sub="current statuses, all runs" />
        <Stat n={usd(t.real_bugs ? t.cost_usd / t.real_bugs : null)} label="Cost per real bug" />
      </div>
      <ChartCard
        title="Cost per run, by phase"
        sub="Pick a run in the filter above for its full agent breakdown."
        table={<DataTable head={['Run', 'Lead', 'Explorers', 'Triage', 'Fix', 'Total']} rows={d.runs.map((r) => [r.name ?? r.run, usd(r.phases.lead), usd(r.phases.explore), usd(r.phases.triage), usd(r.phases.fix), usd(r.cost_usd)])} />}
      >
        <StackedColumns
          data={d.runs.map((r) => ({
            id: `${r.ws}/${r.run}`,
            ws: r.ws,
            run: r.run,
            at: r.started_at,
            name: r.name,
            target: r.target,
            lead: r.phases.lead ?? 0,
            explore: r.phases.explore ?? 0,
            triage: r.phases.triage ?? 0,
            fix: r.phases.fix ?? 0,
          }))}
          series={PHASES}
          xLabel={(x) => `${x.name ?? new Date(String(x.at)).toLocaleString()}`}
          href={(x) => `/?run=${x.ws}/${x.run}&view=agents`}
          valueFormat={usd}
        />
      </ChartCard>
      <div className="box">
        <div className="box-head">
          <div className="path">Runs</div>
        </div>
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Run</th>
                <th>Cost</th>
                <th>Sessions</th>
                <th>Raw → real</th>
                <th>Precision</th>
                <th>Cost / bug</th>
                <th>Wall time</th>
                <th>Tool errors</th>
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {[...d.runs].reverse().map((r) => (
                <tr key={`${r.ws}/${r.run}`}>
                  <td>
                    <Link to={`/?run=${r.ws}/${r.run}&view=agents`}>{r.name ?? r.run}</Link>
                    <div className="small muted">{ago(r.started_at)}</div>
                  </td>
                  <td className="mono small">{usd(r.cost_usd)}</td>
                  <td>{r.sessions}</td>
                  <td>
                    {r.raw} → {r.triaged ? r.real_bugs : <span className="muted">untriaged</span>}
                  </td>
                  <td>{pctS(r.precision)}</td>
                  <td className="mono small">{usd(r.cost_per_real_bug)}</td>
                  <td className="small">{dur(r.wall_ms)}</td>
                  <td className="small">{pctS(r.tool_error_rate)}</td>
                  <td className="small">
                    {r.failed_sessions ? <Chip tone="sev-critical dot">{r.failed_sessions} failed</Chip> : null} {r.reviewer_unavailable ? <Chip tone="sev-major dot">reviewer unavailable ×{r.reviewer_unavailable}</Chip> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <AccuracySection acc={d.accuracy} />
    </div>
  );
}
