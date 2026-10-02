import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, useApi } from '../lib/api.ts';
import type { CampaignJob, Finding, JobView, RunDetail } from '../lib/types.ts';
import { ACTIVE, SEV_ORDER, ago, categoryOf, dateTime, duration, targetName } from '../lib/format.ts';
import { Chamfer, Chip, ErrorBox, Loading, Section, Stat, Tabs, useToast } from '../components/ui.tsx';
import { BugCard } from '../components/BugCard.tsx';
import type { BugPr } from '../lib/bugFixStatus.ts';
import { FixDialog } from '../components/Actions.tsx';
import { JobsTable } from '../components/Jobs.tsx';
import { DashboardView } from './Dashboard.tsx';
import { RunName } from '../components/RunName.tsx';
import { DeleteRun } from '../components/DeleteRun.tsx';
import { RetroButton } from './Improvements.tsx';
import { PrList } from '../components/PrList.tsx';
import { WF_LABEL, isArchived, updateWorkflow, wfStateOf, type WfState } from '../components/Workflow.tsx';

const DISMISSED = ['false_positive', 'suppressed'];

type Tab = 'overview' | 'bugs' | 'fixed' | 'prs' | 'archived' | 'campaign' | 'coverage' | 'hypotheses' | 'intel' | 'jobs';

export function Run() {
  const { ws = '', run = '' } = useParams();
  const { data, error, reload } = useApi<RunDetail>(`/runs/${ws}/${encodeURIComponent(run)}`, { pollMs: 6000 });
  const { data: prData } = useApi<{ prs: BugPr[] }>(`/prs?ws=${encodeURIComponent(ws)}&run=${encodeURIComponent(run)}`, { pollMs: 60_000 });
  const [tab, setTab] = useState<Tab>('overview');
  const [f, setF] = useState({ status: 'active', cat: 'layout', sev: '', type: '', browser: '', persona: '', minConf: 0, q: '' });
  const [sel, setSel] = useState<string[]>([]);
  const [wf, setWf] = useState<'all' | WfState>('all');
  const [fix, setFix] = useState<{ ids: string[]; title: string } | null>(null);
  const toast = useToast();
  const nav = useNavigate();

  const all = useMemo(() => data?.findings?.groups.flatMap((g) => g.findings) ?? [], [data]);
  // Bugs the person can sort: not archived and not dismissed by triage or labels.
  const sortable = (x: Finding) => !isArchived(x) && !DISMISSED.includes(x.status);
  const statusOk = (x: Finding) => (f.status === 'active' ? ACTIVE.includes(x.status) : !f.status || x.status === f.status);
  const base = (x: Finding) =>
    (!f.cat || categoryOf(x) === f.cat) &&
    (!f.sev || x.severity === f.sev) &&
    (!f.type || x.type === f.type) &&
    (!f.browser || x.browsers.includes(f.browser as never)) &&
    (!f.persona || x.found_by.persona === f.persona) &&
    x.confidence >= f.minConf &&
    (!f.q || `${x.id} ${x.title} ${x.page} ${x.element.selector} ${x.description}`.toLowerCase().includes(f.q.toLowerCase()));
  // Archived tab: only archived bugs. Bugs tab: a sort pill (to do / in progress / done / unsorted) takes over from
  // the status filter; "All" keeps the status filter.
  const match = (x: Finding) => base(x) && (tab === 'archived' ? isArchived(x) : !isArchived(x) && (wf === 'all' ? statusOk(x) : sortable(x) && wfStateOf(x) === wf));

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what="Loading run" />;
  const s = data.summary;
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter(Boolean) as string[])].sort();
  const active = all.filter((x) => ACTIVE.includes(x.status) && categoryOf(x) === 'layout' && !isArchived(x));
  const functional = all.filter((x) => ACTIVE.includes(x.status) && categoryOf(x) === 'ux-functional' && !isArchived(x)).length;
  const archivedCount = all.filter(isArchived).length;
  const fixedCount = all.filter(isFixedOrFixing).length;
  const prCount = new Set(all.map((x) => x.fix?.pr_url).filter(Boolean)).size;
  const wfCount = (st: WfState) => all.filter((x) => base(x) && sortable(x) && wfStateOf(x) === st).length;
  const bulk = async (patch: Parameters<typeof updateWorkflow>[3], msg: string) => {
    try {
      await updateWorkflow(ws, run, sel, patch);
      toast(msg);
      setSel([]);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const groups = (data.findings?.groups ?? []).map((g) => ({ ...g, shown: g.findings.filter(match) })).filter((g) => g.shown.length);
  const campaign = data.campaign;
  const liveJobs = data.jobs.filter((j) => j.state === 'running' && j.alive);

  return (
    <>
      <div className="run-head">
        <div className="label">
          <Link to="/runs">Runs</Link> / {targetName(s.target)}{data.run.name ? ` / ${data.run.name}` : ''}
        </div>
        <div className="spread" style={{ alignItems: 'flex-end' }}>
          <div>
            <RunName as="h1" className="display h1 run-title" ws={ws} run={run} name={data.run.name} fallback={targetName(s.target)} onSaved={() => void reload()} />
            <p className="mono small muted" style={{ margin: '8px 0 0' }}>
              {data.run.name ? `${targetName(s.target)} · ` : ''}
              {data.run.run_id} · {data.run.base_url} · {dateTime(data.run.started_at)}
              {data.run.head_commit ? ` · ${data.run.head_commit.slice(0, 10)}` : ''} · {data.run.stages?.explore?.note ?? ''}
            </p>
          </div>
          <div className="row">
            {s.live && <Chip tone="green live">live</Chip>}
            {liveJobs.map((j) => (
              <Link key={j.id} to={`/jobs/${j.id}`}>
                <Chip tone="green live">
                  {j.kind} {j.finding_ids.join(', ')}
                </Chip>
              </Link>
            ))}
            <button
              className="btn-ghost"
              onClick={async () => {
                try {
                  const job = await api<JobView>(`/runs/${ws}/${encodeURIComponent(run)}/triage`, { json: {} });
                  toast('Re-triage started');
                  nav(`/jobs/${job.id}`);
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              {s.triaged ? 'Re-triage' : 'Triage now'}
            </button>
            <RetroButton ws={ws} run={run} triaged={s.triaged} />
            <DeleteRun ws={ws} run={run} name={data.run.name} live={s.live} onDeleted={() => nav('/runs')} />
            {s.triaged && (
              <Link className="btn-ghost" to={`/compare?b=${ws}/${encodeURIComponent(run)}`}>
                Compare…
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="stats" style={{ marginTop: 22 }}>
        <Stat n={active.length} label="Active findings" sub={functional ? `+${functional} functional (filtered out)` : undefined} />
        <Stat n={active.filter((x) => x.severity === 'critical').length} label="Critical" color="var(--sev-critical)" />
        <Stat n={active.filter((x) => x.severity === 'major').length} label="Major" color="var(--sev-major)" />
        <Stat n={active.filter((x) => x.severity === 'minor').length} label="Minor" color="var(--sev-minor)" />
        <Stat n={data.findings?.groups.length ?? 0} label="Root causes" />
        <Stat n={all.filter((x) => x.video).length} label="With video" />
        <Stat n={all.filter((x) => x.status === 'fixing' || x.status === 'fixed').length} label="Fixing / fixed" color="var(--green-ink)" />
        <Stat n={campaign?.jobs.length ?? s.sessions} label="Explorer sessions" />
      </div>

      <div style={{ marginTop: 22 }}>
        <Tabs<Tab>
          value={tab}
          onChange={(t) => (setTab(t), setSel([]))}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'bugs', label: `Bugs (${all.length - archivedCount})` },
            { id: 'fixed', label: `Fixed (${fixedCount})` },
            { id: 'prs', label: `PRs${prCount ? ` (${prCount})` : ''}` },
            { id: 'archived', label: `Archived (${archivedCount})` },
            { id: 'campaign', label: 'Campaign' },
            { id: 'coverage', label: 'Coverage' },
            { id: 'hypotheses', label: `Hypotheses (${data.hypotheses.length})` },
            { id: 'intel', label: 'Code intel' },
            { id: 'jobs', label: `Jobs (${data.jobs.length})` },
          ]}
        />
      </div>

      {(tab === 'bugs' || tab === 'archived') && (
        <>
          {data.findings && tab === 'bugs' && (
            <div className="wf-pills" role="group" aria-label="Sort by your progress">
              {(['all', 'unsorted', 'todo', 'in_progress', 'done'] as const).map((k) => (
                <button key={k} className={`wf-pill ${wf === k ? 'on' : ''}`} aria-pressed={wf === k} onClick={() => (setWf(k), setSel([]))}>
                  {k === 'all' ? 'All' : WF_LABEL[k]}
                  {k !== 'all' && <b>{wfCount(k)}</b>}
                </button>
              ))}
            </div>
          )}
          {tab === 'archived' && (
            <p className="small muted" style={{ margin: '16px 0 0' }}>
              Archived bugs are kept with the run but left out of the active lists and counts. Unarchive one to put it back.
            </p>
          )}
          {!data.findings && (
            <div className="empty" style={{ marginTop: 20 }}>
              <p>
                This run hasn't been triaged yet. {data.raw_findings.length} raw findings recorded by explorers.
              </p>
              <RawFindings rows={data.raw_findings} />
            </div>
          )}
          {data.findings && (
            <div className="filters">
              {tab === 'bugs' && wf === 'all' && (
                <select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status">
                  <option value="active">Active</option>
                  <option value="">All statuses</option>
                  {uniq(all.map((x) => x.status)).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              )}
              <select className="select" value={f.cat} onChange={(e) => setF({ ...f, cat: e.target.value })} aria-label="Category">
                <option value="layout">Layout bugs</option>
                <option value="ux-functional">Functional bugs ({functional})</option>
                <option value="">All categories</option>
              </select>
              <select className="select" value={f.sev} onChange={(e) => setF({ ...f, sev: e.target.value })} aria-label="Severity">
                <option value="">All severities</option>
                {Object.keys(SEV_ORDER).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} aria-label="Type">
                <option value="">All types</option>
                {uniq(all.map((x) => x.type)).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <select className="select" value={f.browser} onChange={(e) => setF({ ...f, browser: e.target.value })} aria-label="Browser">
                <option value="">All browsers</option>
                {uniq(all.flatMap((x) => x.browsers)).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <select className="select" value={f.persona} onChange={(e) => setF({ ...f, persona: e.target.value })} aria-label="Persona">
                <option value="">All personas</option>
                {uniq(all.map((x) => x.found_by.persona)).map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <label className="row label" style={{ gap: 6 }}>
                min conf
                <input className="input" type="number" min={0} max={1} step={0.05} value={f.minConf} onChange={(e) => setF({ ...f, minConf: Number(e.target.value) })} style={{ width: 70 }} />
              </label>
              <input className="input" placeholder="Search id, title, selector…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} style={{ flex: '1 1 200px' }} />
            </div>
          )}
          {data.findings && !groups.length && (
            <div className="empty" style={{ marginTop: 20 }}>
              {tab === 'archived' && !archivedCount ? 'Nothing archived yet. Use Archive on a bug (or select several) to move it here.' : 'No findings match these filters.'}
            </div>
          )}
          {groups.map((g) => {
            const worst = [...g.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])[0]?.severity;
            return (
              <Section
                key={g.id}
                id={g.id}
                kicker={
                  <>
                    {g.id} · {g.findings.length} finding{g.findings.length > 1 ? 's' : ''} · worst: {worst}
                  </>
                }
                title={g.component ? g.component.replace(/^[.#]/, '') : g.findings[0].type}
                meta={
                  <>
                    <span style={{ maxWidth: 860, fontSize: 16 }}>{g.summary}</span>
                    {g.files.length > 0 && (
                      <span className="row" style={{ justifyContent: 'center' }}>
                        {g.files.map((file) => (
                          <code key={file} className="chip">
                            {file}
                          </code>
                        ))}
                      </span>
                    )}
                    {g.fix_plan && (
                      <span className="small muted" style={{ maxWidth: 860 }}>
                        <b className="label">Fix plan</b> {g.fix_plan}
                      </span>
                    )}
                  </>
                }
                actions={
                  tab === 'bugs' && g.findings.length > 1 && s.repo_path ? (
                    <Chamfer small tone="green" onClick={() => setFix({ ids: [g.id], title: g.summary })}>
                      Fix whole group
                    </Chamfer>
                  ) : undefined
                }
              >
                <div className="grid-2">
                  {g.shown.map((x) => (
                    <BugCard key={x.id} f={x} ws={ws} run={run} prs={prData?.prs} selected={sel.includes(x.id)} onSelect={(on) => setSel((cur) => (on ? [...cur, x.id] : cur.filter((y) => y !== x.id)))} onWorkflow={reload} />
                  ))}
                </div>
              </Section>
            );
          })}
        </>
      )}

      {tab === 'overview' && <DashboardView scope={{ ws, run }} />}
      {tab === 'fixed' && <FixedTab all={all} ws={ws} run={run} />}
      {tab === 'prs' && <PrList scope={{ ws, run }} />}
      {tab === 'campaign' && <CampaignTab data={data} />}
      {tab === 'coverage' && <CoverageTab data={data} />}
      {tab === 'hypotheses' && <HypothesesTab data={data} />}
      {tab === 'intel' && <IntelTab data={data} />}
      {tab === 'jobs' && (
        <div style={{ marginTop: 20 }}>
          <JobsTable jobs={data.jobs} />
        </div>
      )}

      {sel.length > 0 && (
        <div className="sel-bar">
          <span className="mono small">{sel.length} selected</span>
          {tab === 'bugs' && (
            <div className="wf-seg" role="group" aria-label="Move selected bugs">
              {(['todo', 'in_progress', 'done'] as const).map((st) => (
                <button key={st} className="wf-btn" onClick={() => bulk({ state: st }, `${sel.length} → ${WF_LABEL[st]}`)}>
                  {WF_LABEL[st]}
                </button>
              ))}
              <button className="wf-btn" onClick={() => bulk({ state: null }, `${sel.length} unsorted`)}>
                Unsorted
              </button>
            </div>
          )}
          <button className="btn-link" style={{ color: 'var(--on-ink)' }} onClick={() => bulk({ archived: tab !== 'archived' }, tab === 'archived' ? `${sel.length} restored from the archive` : `${sel.length} archived`)}>
            {tab === 'archived' ? 'Unarchive' : 'Archive'}
          </button>
          <button className="btn-link" style={{ color: 'var(--on-ink)' }} onClick={() => setSel([])}>
            Clear
          </button>
          {tab === 'bugs' && s.repo_path && (
            <Chamfer small tone="green" onClick={() => setFix({ ids: sel, title: `${sel.length} finding${sel.length > 1 ? 's' : ''} on one branch` })}>
              Fix selected ({sel.length})
            </Chamfer>
          )}
        </div>
      )}
      {fix && (
        <FixDialog
          open
          onClose={() => setFix(null)}
          ws={ws}
          run={run}
          ids={fix.ids}
          title={fix.title}
          onStarted={(job) => {
            setSel([]);
            void reload();
            nav(`/jobs/${job.id}`);
          }}
        />
      )}
    </>
  );
}

function RawFindings({ rows }: { rows: RunDetail['raw_findings'] }) {
  if (!rows.length) return null;
  return (
    <div className="scroll-x" style={{ textAlign: 'left', marginTop: 12 }}>
      <table className="t">
        <thead>
          <tr>
            <th>Session</th>
            <th>Type</th>
            <th>Page</th>
            <th>Title</th>
            <th>Browser</th>
            <th>Conf</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="mono small">{r.session}</td>
              <td>{r.type}</td>
              <td className="mono small">{r.page}</td>
              <td>{r.title}</td>
              <td>{r.browser}</td>
              <td className="mono small">{Math.round(r.confidence * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Bugs with a fix: committed on a branch (with or without a PR) or done. Archived bugs stay in the archive. */
const isFixedOrFixing = (x: Finding) => !isArchived(x) && (x.status === 'fixed' || (x.status === 'fixing' && !!x.fix));

function FixedTab({ all, ws, run }: { all: Finding[]; ws: string; run: string }) {
  const fixed = all.filter(isFixedOrFixing);
  const sections: { id: string; title: string; help: string; rows: Finding[] }[] = [
    { id: 'pr', title: 'PR open', help: 'The fix is on a branch with a pull request.', rows: fixed.filter((x) => x.status === 'fixing' && x.fix?.pr_url) },
    { id: 'branch', title: 'Fixed on a branch', help: 'Committed on a fix branch, no pull request yet. Open the bug to review the diff and open a PR.', rows: fixed.filter((x) => x.status === 'fixing' && !x.fix?.pr_url) },
    { id: 'done', title: 'Fixed', help: 'Done: marked fixed by you or by a finished fix.', rows: fixed.filter((x) => x.status === 'fixed') },
  ];
  if (!fixed.length)
    return (
      <div className="empty" style={{ marginTop: 20 }}>
        Nothing fixed in this run yet. Fix a bug from its page (or select several on the Bugs tab), or mark one Done.
      </div>
    );
  const sev = (x: Finding) => SEV_ORDER[x.severity];
  return (
    <div className="stack" style={{ ['--gap' as string]: '22px', marginTop: 20 }}>
      {sections
        .filter((sec) => sec.rows.length)
        .map((sec) => (
          <section key={sec.id} className="box" aria-labelledby={`fx-${sec.id}`}>
            <div className="box-head">
              <div className="path" id={`fx-${sec.id}`}>
                {sec.title} ({sec.rows.length})
              </div>
            </div>
            <p className="small muted fixed-help">{sec.help}</p>
            <ul className="fixed-list">
              {[...sec.rows]
                .sort((a, b) => sev(a) - sev(b) || String(b.fix?.at ?? b.workflow?.updated_at ?? '').localeCompare(String(a.fix?.at ?? a.workflow?.updated_at ?? '')))
                .map((x) => (
                  <li key={x.id}>
                    <div className="fixed-main">
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <Link to={`/runs/${ws}/${encodeURIComponent(run)}/bugs/${x.id}`} className="mono small">
                          {x.id}
                        </Link>
                        <Chip tone={`dot sev-${x.severity}`}>{x.severity}</Chip>
                        {x.fix ? x.fix.blocked ? <Chip tone="sev-critical dot">blocked: not published</Chip> : x.fix.verified && x.fix.verification && !x.fix.flags?.length ? <Chip tone="mint">verified</Chip> : <Chip tone="sev-major dot">not fully verified</Chip> : <Chip tone="outline">marked done</Chip>}
                        {x.fix?.fixed_by && /side effect/.test(x.fix.fixed_by) && <Chip tone="outline">fixed by {x.fix.fixed_by.replace(/ \(side effect\)/, '')}</Chip>}
                      </div>
                      <Link to={`/runs/${ws}/${encodeURIComponent(run)}/bugs/${x.id}`} className="fixed-title">
                        {x.title}
                      </Link>
                      {x.fix?.flags?.length ? <div className="small" style={{ color: 'var(--warn)' }}>⚠ {x.fix.flags[0].replace(/^BB-\d+: /, '')}{x.fix.flags.length > 1 ? ` (+${x.fix.flags.length - 1} more)` : ''}</div> : x.fix && !x.fix.verification ? <div className="small" style={{ color: 'var(--warn)' }}>⚠ Checked before the stricter verification: retry verification on the bug page</div> : null}
                      <div className="small muted">
                        {x.type} · {x.page}
                        {x.fix?.branch && (
                          <>
                            {' · '}
                            <span className="mono">{x.fix.branch}</span>
                          </>
                        )}
                        {(x.fix?.at ?? x.workflow?.updated_at) && ` · ${ago(x.fix?.at ?? x.workflow?.updated_at)}`}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      {x.fix?.pr_url && (
                        <a className="btn-ghost" href={x.fix.pr_url} target="_blank" rel="noreferrer">
                          PR ↗
                        </a>
                      )}
                      <Link className="btn-ghost" to={`/runs/${ws}/${encodeURIComponent(run)}/bugs/${x.id}`}>
                        {sec.id === 'branch' ? 'Review & open PR' : 'View'}
                      </Link>
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

function CampaignTab({ data }: { data: RunDetail }) {
  const decisions = data.campaign?.decisions?.length ? data.campaign.decisions : data.run.lead_decisions ?? [];
  const jobs: CampaignJob[] = data.campaign?.jobs ?? (data.run.jobs as Record<string, any>[]).map(fromRunJob);
  return (
    <div className="stack" style={{ ['--gap' as string]: '22px', marginTop: 22 }}>
      <div className="box">
        <div className="box-head">
          <div className="path">Stop reason</div>
          {data.campaign && <Chip tone={data.campaign.phase === 'running' ? 'green live' : ''}>{data.campaign.phase}</Chip>}
        </div>
        <div className="box-body">{data.run.stop_reason ?? data.campaign?.stop_reason ?? <span className="muted">Still running…</span>}</div>
      </div>
      <div className="box">
        <div className="box-head">
          <div className="path">Lead agent decisions</div>
          <Chip>{decisions.length}</Chip>
        </div>
        <div className="box-body">
          {decisions.length ? (
            <ol className="decisions">
              {decisions.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ol>
          ) : (
            <p className="muted">No lead decisions (fixed plan or not started).</p>
          )}
        </div>
      </div>
      <div className="box">
        <div className="box-head">
          <div className="path">Explorer sessions</div>
          <Chip>{jobs?.length ?? 0}</Chip>
        </div>
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Session</th>
                <th>Status</th>
                <th>Browser</th>
                <th>Persona</th>
                <th>Goal</th>
                <th>New / total</th>
                <th>Tool calls</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {(jobs ?? []).map((j) => (
                <tr key={j.id}>
                  <td className="mono small">{j.id}</td>
                  <td>{j.status === 'running' ? <Chip tone="green live">running</Chip> : <Chip tone={j.status === 'failed' ? 'sev-critical dot' : 'outline'}>{j.status}</Chip>}</td>
                  <td>{j.browser}</td>
                  <td>{j.persona ?? '—'}</td>
                  <td style={{ minWidth: 280 }}>
                    {j.goal}
                    {j.summary && (
                      <details>
                        <summary className="btn-link">Session summary</summary>
                        <p className="small md-text">{j.summary}</p>
                      </details>
                    )}
                  </td>
                  <td className="mono small">
                    {j.new_findings ?? '—'} / {j.total_findings ?? '—'}
                  </td>
                  <td className="mono small">{j.tool_calls ?? '—'}</td>
                  <td className="small muted">{duration(j.started_at, j.ended_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data.notes && (
        <div className="box">
          <div className="box-head">
            <div className="path">Shared explorer notes</div>
          </div>
          <div className="box-body">
            <pre className="md-text" style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-body)', fontSize: 14 }}>
              {data.notes}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function CoverageTab({ data }: { data: RunDetail }) {
  return (
    <div className="box" style={{ marginTop: 22 }}>
      <div className="box-head">
        <div className="path">Coverage by page (across all explorer sessions)</div>
      </div>
      <div className="scroll-x">
        <table className="t">
          <thead>
            <tr>
              <th>Page</th>
              <th>States</th>
              <th>Elements tried / seen</th>
              <th>Widths tested</th>
              <th>Browsers</th>
              <th>Variants</th>
              <th>Strategies not tried</th>
            </tr>
          </thead>
          <tbody>
            {data.coverage.map((c) => (
              <tr key={c.page}>
                <td className="mono">{c.page}</td>
                <td>{c.states}</td>
                <td>
                  {c.interactives_tried} / {c.interactives_seen}
                </td>
                <td className="mono small">{c.widths_tested.join(', ')}</td>
                <td>{c.browsers_tested.join(', ')}</td>
                <td className="small">{c.variants_tested.join(', ') || '—'}</td>
                <td className="small muted" style={{ minWidth: 240 }}>
                  {c.strategies_untried.join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HypothesesTab({ data }: { data: RunDetail }) {
  const [o, setO] = useState('');
  const rows = data.hypotheses.filter((h) => !o || h.outcome === o);
  return (
    <div style={{ marginTop: 22 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        {['', 'confirmed', 'refuted', 'inconclusive'].map((x) => (
          <button key={x} className={`btn-ghost ${o === x ? 'on' : ''}`} onClick={() => setO(x)}>
            {x || 'all'} ({x ? data.hypotheses.filter((h) => h.outcome === x).length : data.hypotheses.length})
          </button>
        ))}
      </div>
      <div className="grid-auto">
        {rows.map((h, i) => (
          <div key={i} className="box">
            <div className="box-head">
              <div className="path">
                {h.page} · {h.session}
              </div>
              <Chip tone={h.outcome === 'confirmed' ? 'green' : h.outcome === 'refuted' ? 'outline' : ''}>{h.outcome}</Chip>
            </div>
            <div className="box-body">
              <p style={{ margin: 0 }}>{h.hypothesis}</p>
              {h.note && <p className="small muted" style={{ margin: '8px 0 0' }}>{h.note}</p>}
              {h.strategy && (
                <p className="mono small" style={{ margin: '8px 0 0' }}>
                  {h.strategy}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
      {!rows.length && <div className="empty">No hypotheses logged.</div>}
    </div>
  );
}

function IntelTab({ data }: { data: RunDetail }) {
  const ci = data.code_intel;
  if (!ci) return <div className="empty" style={{ marginTop: 22 }}>Black-box run: no source code was analysed.</div>;
  return (
    <div className="stack" style={{ ['--gap' as string]: '22px', marginTop: 22 }}>
      <div className="grid-2">
        <div className="box">
          <div className="box-head">
            <div className="path">Breakpoints & routes</div>
            <Chip>{ci.framework ?? 'static'}</Chip>
          </div>
          <div className="box-body">
            <dl className="kv">
              <dt>Breakpoints</dt>
              <dd className="mono">{ci.breakpoints.join(', ') || '—'}px</dd>
              <dt>Routes</dt>
              <dd className="mono">{ci.routes.join(', ') || '—'}</dd>
              <dt>Components</dt>
              <dd>{ci.components.map((c) => `${c.name}×${c.usages}`).join(', ') || '—'}</dd>
              <dt>Changed</dt>
              <dd className="mono small">{ci.changedFiles.join(', ') || '—'}</dd>
            </dl>
          </div>
        </div>
        <div className="box">
          <div className="box-head">
            <div className="path">Hypothesis seeds given to the agents</div>
            <Chip>{ci.hypotheses.length}</Chip>
          </div>
          <div className="box-body">
            <ol className="decisions">
              {ci.hypotheses.map((h, i) => (
                <li key={i}>{h.text}</li>
              ))}
            </ol>
          </div>
        </div>
      </div>
      <div className="box">
        <div className="box-head">
          <div className="path">Risky CSS rules</div>
          <Chip>{ci.risky.length}</Chip>
        </div>
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>File</th>
                <th>Selector</th>
                <th>Issue</th>
                <th>Declaration</th>
                <th>Media</th>
              </tr>
            </thead>
            <tbody>
              {ci.risky.map((r, i) => (
                <tr key={i}>
                  <td className="mono small">
                    {r.file}
                    {r.line ? `:${r.line}` : ''}
                  </td>
                  <td className="mono small">{r.selector}</td>
                  <td>{r.issue}</td>
                  <td className="mono small">{r.decl}</td>
                  <td className="mono small muted">{r.media ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** run.json stores the campaign's in-memory job objects; map them to the campaign.json shape. */
function fromRunJob(j: Record<string, any>): CampaignJob {
  return {
    id: j.id,
    kind: j.kind,
    goal: j.goal,
    persona: j.persona ?? null,
    browser: j.browser,
    pages: j.pages ?? [],
    status: j.status,
    started_at: j.startedAt ? new Date(j.startedAt).toISOString() : null,
    ended_at: j.endedAt ? new Date(j.endedAt).toISOString() : null,
    new_findings: j.newFindings ?? null,
    total_findings: j.totalFindings ?? null,
    tool_calls: j.result?.toolCalls ?? null,
    summary: j.result?.summary ?? null,
    error: j.result?.error ?? null,
  };
}
