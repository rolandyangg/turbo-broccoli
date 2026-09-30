import { useState } from 'react';
import { Link } from 'react-router';
import { fileUrl, useApi } from '../lib/api.ts';
import type { JobView, RunSummary } from '../lib/types.ts';
import { ago, pct, targetName } from '../lib/format.ts';
import { Arrow, Chamfer, Chip, ErrorBox, Loading, SevChip, Stat, StatusChip } from '../components/ui.tsx';
import { ChartCard, DataTable, HBars, StackedColumns, type StackSeries } from '../components/Charts.tsx';
import { JobStateChip } from '../components/Jobs.tsx';
import { LauncherDialog } from '../components/Actions.tsx';

interface Dashboard {
  kpis: { active: number; critical: number; major: number; fixing: number; fixed: number; false_positive: number; targets: number; runs: number; running_jobs: number; with_video: number };
  severity: { key: string; count: number }[];
  pipeline: { key: string; count: number }[];
  by_type: { key: string; count: number }[];
  by_page: { key: string; count: number }[];
  by_browser: { key: string; count: number }[];
  trend: { run: string; ws: string; target: string; at: string; active: number; critical: number; major: number; minor: number; cosmetic: number; triaged: boolean }[];
  attention: { id: string; ws: string; run: string; target: string; title: string; severity: string; status: string; type: string; page: string; confidence: number; thumb: string | null; widths: number[]; browsers: string[] }[];
  targets: { target: string; latest: RunSummary; runs: number; active: number; critical: number; major: number }[];
  jobs: JobView[];
}

const SEVERITY: StackSeries[] = [
  { key: 'critical', label: 'Critical', color: 'var(--sev-critical)' },
  { key: 'major', label: 'Major', color: 'var(--sev-major)' },
  { key: 'minor', label: 'Minor', color: 'var(--sev-minor)' },
  { key: 'cosmetic', label: 'Cosmetic', color: 'var(--sev-cosmetic)' },
];

const PIPELINE_LABEL: Record<string, string> = { new: 'New', confirmed: 'Confirmed', fixing: 'Being fixed', fixed: 'Fixed', low_confidence: 'Low confidence', flaky: 'Flaky', false_positive: 'False positive', suppressed: 'Suppressed' };

export function Dashboard() {
  const { data, error } = useApi<Dashboard>('/dashboard', { pollMs: 8000 });
  const [launch, setLaunch] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what="Loading dashboard" />;
  const k = data.kpis;
  const runHref = (d: { ws: string; run: string }) => `/runs/${d.ws}/${encodeURIComponent(d.run)}`;
  const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (!k.runs)
    return (
      <div className="empty" style={{ marginTop: 40 }}>
        <h1 className="page-title">No runs yet</h1>
        <p>
          Start a bug bash here or from the CLI (<code>./bin/bugbash.js explore &lt;target&gt; --then-triage</code>). Runs from every workspace show up automatically.
        </p>
        <Chamfer onClick={() => setLaunch(true)}>New bug bash</Chamfer>
        <LauncherDialog open={launch} onClose={() => setLaunch(false)} />
      </div>
    );

  return (
    <>
      <div className="run-head spread" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="label">Overview · latest triaged run of each target</div>
          <h1 className="page-title">Dashboard</h1>
        </div>
        <div className="row">
          {k.running_jobs > 0 && (
            <Link to="/jobs">
              <Chip tone="green live">{k.running_jobs} running</Chip>
            </Link>
          )}
        </div>
      </div>

      <div className="stats" style={{ marginTop: 20 }}>
        <Stat n={k.active} label="Active bugs" sub={`${k.with_video} with video`} />
        <Stat n={k.critical} label="Critical" color="var(--sev-critical)" />
        <Stat n={k.major} label="Major" color="var(--sev-major)" />
        <Stat n={k.fixing} label="Being fixed" color="var(--green)" />
        <Stat n={k.fixed} label="Fixed" />
        <Stat n={k.false_positive} label="Dismissed" sub="false positive / suppressed" />
        <Stat n={k.targets} label="Targets" />
        <Stat n={k.runs} label="Runs" />
      </div>

      <div className="dash-grid" style={{ marginTop: 20 }}>
        <div className="span-2">
          <ChartCard
            title="Active bugs per run, by severity"
            sub="Each column is one run (oldest → newest). Click a column to open the run."
            table={
              <DataTable
                head={['Run', 'Target', 'Critical', 'Major', 'Minor', 'Cosmetic', 'Active']}
                rows={data.trend.map((t) => [
                  <Link to={runHref(t)} className="mono small">
                    {t.run}
                  </Link>,
                  targetName(t.target),
                  t.critical,
                  t.major,
                  t.minor,
                  t.cosmetic,
                  t.active,
                ])}
              />
            }
          >
            <StackedColumns data={data.trend.map((t) => ({ ...t, id: `${t.ws}/${t.run}` }))} series={SEVERITY} xLabel={(d) => `${shortDate(String(d.at))} · ${targetName(String(d.target))}`} href={(d) => runHref(d as { ws: string; run: string })} />
          </ChartCard>
        </div>
        <ChartCard title="Severity of active bugs" table={<DataTable head={['Severity', 'Bugs']} rows={data.severity.map((s) => [s.key, s.count])} />}>
          <HBars rows={data.severity.map((s) => ({ key: s.key, label: <span className="row" style={{ gap: 6 }}><i className="stat-mark" style={{ background: `var(--sev-${s.key})` }} />{s.key}</span>, count: s.count, color: `var(--sev-${s.key})` }))} unit=" bugs" />
          <hr className="divider" />
          <div className="label" style={{ marginBottom: 8 }}>Pipeline</div>
          <div className="pipeline">
            {data.pipeline
              .filter((p) => p.count || ['new', 'fixing', 'fixed'].includes(p.key))
              .map((p) => (
                <div key={p.key} className="pipe-step">
                  <b className="mono">{p.count}</b>
                  <span className="small">{PIPELINE_LABEL[p.key] ?? p.key}</span>
                </div>
              ))}
          </div>
        </ChartCard>

        <div className="span-2 box">
          <div className="box-head">
            <div className="path">Needs attention: most severe open bugs</div>
            <Chip>{data.attention.length}</Chip>
          </div>
          {data.attention.length ? (
            <ul className="attention">
              {data.attention.map((a) => (
                <li key={`${a.ws}/${a.run}/${a.id}`}>
                  <Link to={`${runHref(a)}/bugs/${a.id}`}>
                    <span className="att-thumb">{a.thumb ? <img loading="lazy" src={fileUrl(a.ws, a.run, a.thumb)} alt="" /> : null}</span>
                    <span className="att-body">
                      <span className="row" style={{ gap: 6 }}>
                        <span className="mono small">{a.id}</span>
                        <SevChip sev={a.severity} />
                        <StatusChip status={a.status} />
                        <Chip>{a.type}</Chip>
                      </span>
                      <span className="att-title">{a.title}</span>
                      <span className="mono small muted">
                        {targetName(a.target)} {a.page} · {a.browsers.join(', ')} · {a.widths.length > 1 ? `${a.widths[0]}–${a.widths[a.widths.length - 1]}px` : `${a.widths[0] ?? ''}px`} · {pct(a.confidence)}
                      </span>
                    </span>
                    <span className="att-go">
                      <Arrow />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="box-body muted">No open bugs. 🎉</div>
          )}
        </div>

        <div className="box">
          <div className="box-head">
            <div className="path">Recent jobs</div>
            <Link to="/jobs" className="btn-link">
              All
            </Link>
          </div>
          {data.jobs.length ? (
            <ul className="job-list">
              {data.jobs.map((j) => (
                <li key={j.id}>
                  <Link to={`/jobs/${j.id}`}>
                    <span className="row" style={{ gap: 6 }}>
                      <Chip tone="outline">{j.kind}</Chip>
                      <JobStateChip job={j} />
                      <span className="mono small">{j.finding_ids.join(', ') || targetName(String(j.options?.target ?? ''))}</span>
                    </span>
                    <span className="small muted">
                      {j.branch ? <code>{j.branch.replace(/^bugbash\//, '')}</code> : j.stage} · {ago(j.started_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="box-body muted small">No jobs yet. Start a fix from any bug.</div>
          )}
        </div>

        <ChartCard title="Bug types" table={<DataTable head={['Type', 'Bugs']} rows={data.by_type.map((r) => [r.key, r.count])} />}>
          <HBars rows={data.by_type} unit=" bugs" />
        </ChartCard>
        <ChartCard title="Pages with the most bugs" table={<DataTable head={['Page', 'Bugs']} rows={data.by_page.map((r) => [r.key, r.count])} />}>
          <HBars rows={data.by_page} unit=" bugs" />
        </ChartCard>
        <ChartCard title="Browsers affected" sub="A bug can affect several browsers." table={<DataTable head={['Browser', 'Bugs']} rows={data.by_browser.map((r) => [r.key, r.count])} />}>
          <HBars rows={data.by_browser} unit=" bugs" />
        </ChartCard>
      </div>

      <div className="spread" style={{ marginTop: 32 }}>
        <h2 className="h3" style={{ fontSize: 22 }}>
          Targets
        </h2>
        <Link to="/runs" className="btn-link">
          All runs
        </Link>
      </div>
      <div className="grid-auto" style={{ marginTop: 12 }}>
        {data.targets.map((t) => (
          <div key={t.target} className="box">
            <div className="box-head">
              <div className="path">{targetName(t.target)}</div>
              {t.latest.live ? <Chip tone="green live">live</Chip> : <Chip>{t.runs} run{t.runs > 1 ? 's' : ''}</Chip>}
            </div>
            <div className="box-body">
              <div className="run-stats">
                <div>
                  <b>{t.active}</b>
                  <span className="label">active</span>
                </div>
                <div>
                  <b>{t.critical}</b>
                  <span className="label row" style={{ gap: 6 }}>
                    <i className="stat-mark" style={{ background: 'var(--sev-critical)' }} />
                    critical
                  </span>
                </div>
                <div>
                  <b>{t.major}</b>
                  <span className="label row" style={{ gap: 6 }}>
                    <i className="stat-mark" style={{ background: 'var(--sev-major)' }} />
                    major
                  </span>
                </div>
              </div>
              <p className="small muted" style={{ margin: '10px 0 0' }}>
                Latest run {ago(t.latest.started_at)} · {t.latest.counts.groups} root causes · {t.latest.sessions} sessions
              </p>
            </div>
            <Link className="box-foot" to={runHref(t.latest)}>
              Open latest run <Arrow />
            </Link>
          </div>
        ))}
      </div>
      <LauncherDialog open={launch} onClose={() => setLaunch(false)} />
    </>
  );
}
