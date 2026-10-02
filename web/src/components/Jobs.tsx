import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { dismissJobs, jobsAwaitingReview, useJobReviews } from '../lib/jobReview.ts';
import { api, useApi } from '../lib/api.ts';
import type { BranchInfo, JobEvent, JobView, RunSummary } from '../lib/types.ts';
import { ago, duration, dateTime, targetName } from '../lib/format.ts';
import { Box, Chamfer, Chip, Check, Cross, CopyButton, Dialog, useToast } from './ui.tsx';
import { FixRunDialog } from './Actions.tsx';

const FIX_STAGE_LABEL: Record<string, string> = {
  queued: 'Queued',
  start: 'Starting',
  resolve: 'Resolve scope',
  worktree: 'Create branch & worktree',
  server: 'Start app from branch',
  baseline: 'Confirm bug on branch',
  'verify:continue': 'Check the branch as it stands',
  investigate: 'Investigate the report',
  connect: 'Sign in to GitHub',
  'also-fixed': 'Check sibling findings',
  evidence: 'Capture after screenshots',
  commit: 'Commit',
  push: 'Push branch',
  pr: 'Open pull request',
  record: 'Record fix status',
  cleanup: 'Clean up worktree',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  explore: 'Explore',
  'session-start': 'Explorer sessions',
  'session-end': 'Explorer sessions',
  triage: 'Triage',
  serve: 'Start the app',
  launch: 'Open browser window',
  step: 'Replay steps',
  ready: 'Ready: window is yours',
  closed: 'Window closed',
};

function stageLabel(s: string) {
  const m = s.match(/^(attempt|verify):(\d+)$/);
  if (m) return m[1] === 'attempt' ? `Fix agent · attempt ${m[2]}` : `Verify · attempt ${m[2]}`;
  return FIX_STAGE_LABEL[s] ?? s;
}

interface StageRow {
  stage: string;
  events: JobEvent[];
  agent: JobEvent[];
  level: 'done' | 'active' | 'error' | 'warn';
  startedAt: string;
}

/** Groups the event log into ordered stages with a state each. */
function toStages(events: JobEvent[], status: JobView | null): StageRow[] {
  const rows: StageRow[] = [];
  for (const e of events) {
    // Session start/end lines belong to one "Explorer sessions" stage.
    const key = e.stage === 'session-end' ? 'session-start' : e.stage;
    let r = rows.find((x) => x.stage === key);
    if (!r) {
      r = { stage: key, events: [], agent: [], level: 'done', startedAt: e.t };
      rows.push(r);
    }
    if (e.level === 'agent') r.agent.push(e);
    else r.events.push(e);
  }
  const running = status?.state === 'running' && status.alive;
  rows.forEach((r, i) => {
    const errs = r.events.some((e) => e.level === 'error');
    const warns = r.events.some((e) => e.level === 'warn');
    r.level = errs ? 'error' : i === rows.length - 1 && running ? 'active' : warns ? 'warn' : 'done';
  });
  return rows;
}

export function JobTimeline({ events, status }: { events: JobEvent[]; status: JobView | null }) {
  const rows = useMemo(() => toStages(events, status), [events, status]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!rows.length)
    return (
      <div className="row muted">
        <span className="spinner" /> Waiting for the job to start…
      </div>
    );
  return (
    <ol className="timeline">
      {rows.map((r) => (
        <li key={r.stage} className={`tl-${r.level}`}>
          <span className="tl-icon">{r.level === 'active' ? <span className="spinner" /> : r.level === 'error' ? <Cross /> : r.level === 'warn' ? '!' : <Check />}</span>
          <div className="tl-body">
            <div className="spread">
              <strong className="h3" style={{ fontSize: 15 }}>
                {stageLabel(r.stage)}
              </strong>
              <span className="mono small muted">{new Date(r.startedAt).toLocaleTimeString()}</span>
            </div>
            {r.events.map((e, i) => (
              <div key={i} className={`tl-msg ${e.level}`}>
                {e.msg}
                <EventData e={e} />
              </div>
            ))}
            {r.agent.length > 0 && (
              <div className="tl-agent">
                <button className="btn-link" onClick={() => setOpen((o) => ({ ...o, [r.stage]: !o[r.stage] }))}>
                  {open[r.stage] ? 'Hide' : 'Show'} agent activity ({r.agent.length})
                </button>
                <ul>
                  {(open[r.stage] ? r.agent : r.agent.slice(-4)).map((e, i) => (
                    <li key={i} className={e.data?.tool ? 'tool' : 'text'}>
                      {e.data?.tool ? <span className="chip">{String(e.data.tool)}</span> : null} <span>{e.msg.replace(new RegExp(`^${String(e.data?.tool ?? '')}\\s*`), '')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Structured payloads worth showing inline (verify matrices, diff stats, PR links). */
function EventData({ e }: { e: JobEvent }) {
  const d = e.data ?? {};
  if (Array.isArray(d.after))
    return (
      <div className="row" style={{ marginTop: 6, gap: 6 }}>
        {(d.after as { id: string; present: boolean | null; checks: { browser: string; width: number; present: boolean | null }[] }[]).flatMap((a) =>
          a.checks.length
            ? a.checks.map((c, i) => (
                <Chip key={a.id + i} tone={c.present ? 'sev-critical dot' : 'mint'}>
                  {a.id} {c.browser} {c.width}px {c.present ? 'still broken' : 'fixed'}
                </Chip>
              ))
            : [
                <Chip key={a.id} tone="outline">
                  {a.id} visual check
                </Chip>,
              ],
        )}
        {Array.isArray(d.regressions) && (d.regressions as string[]).length > 0 && <Chip tone="sev-major dot">{(d.regressions as string[]).length} regression(s)</Chip>}
      </div>
    );
  if (d.result && typeof d.result === 'object') {
    const r = d.result as { checks?: { browser: string; width: number; present: boolean | null }[] };
    return (
      <div className="row" style={{ marginTop: 6, gap: 6 }}>
        {(r.checks ?? []).map((c, i) => (
          <Chip key={i} tone={c.present ? 'ink' : 'outline'}>
            {c.browser} {c.width}px {c.present ? 'present' : 'absent'}
          </Chip>
        ))}
      </div>
    );
  }
  if (typeof d.pr_url === 'string')
    return (
      <div style={{ marginTop: 4 }}>
        <a href={d.pr_url} target="_blank" rel="noreferrer" className="mono">
          {d.pr_url}
        </a>
      </div>
    );
  if (typeof d.summary === 'string' && d.summary)
    return (
      <details style={{ marginTop: 4 }}>
        <summary className="btn-link">Agent summary</summary>
        <div className="md-text">{d.summary}</div>
      </details>
    );
  return null;
}

export function JobStateChip({ job }: { job: Pick<JobView, 'state' | 'alive'> }) {
  if (job.state === 'running' && job.alive) return <Chip tone="green live">running</Chip>;
  if (job.state === 'succeeded') return <Chip tone="mint">succeeded</Chip>;
  if (job.state === 'cancelled') return <Chip tone="outline">cancelled</Chip>;
  return <Chip tone="sev-critical dot">failed</Chip>;
}

export function JobRow({ job }: { job: JobView }) {
  return (
    <tr>
      <td>
        <Link to={`/jobs/${job.id}`} className="mono">
          {job.id}
        </Link>
      </td>
      <td>
        <Chip tone="outline">{job.kind}</Chip>
      </td>
      <td>
        <JobStateChip job={job} />
      </td>
      <td className="mono small">{job.finding_ids.join(', ') || (job.options?.target as string) || '—'}</td>
      <td className="mono small">
        {job.branch ?? '—'}
        {job.pr_url && (
          <>
            {' · '}
            <a href={job.pr_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              PR ↗
            </a>
          </>
        )}
      </td>
      <td className="small muted">{stageLabel(job.stage)}</td>
      <td className="small muted">
        {ago(job.started_at)} · {duration(job.started_at, job.ended_at)}
      </td>
    </tr>
  );
}

export function JobsTable({ jobs }: { jobs: JobView[] }) {
  if (!jobs.length) return <div className="empty muted">No jobs yet.</div>;
  return (
    <div className="scroll-x">
      <table className="t">
        <thead>
          <tr>
            <th>Job</th>
            <th>Kind</th>
            <th>State</th>
            <th>Scope</th>
            <th>Branch</th>
            <th>Stage</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CancelButton({ job, onDone }: { job: JobView; onDone?: () => void }) {
  const toast = useToast();
  if (!(job.state === 'running' && job.alive)) return null;
  return (
    <button
      className="btn-ghost"
      onClick={async () => {
        try {
          await api(`/jobs/${job.id}/cancel`, { method: 'POST' });
          toast('Cancelling job…');
          onDone?.();
        } catch (e) {
          toast((e as Error).message, true);
        }
      }}
    >
      Cancel job
    </button>
  );
}

// ---------- branch ----------
export function BranchPanel({ ws, run, branch, base, live, publish, children }: { ws: string; run: string; branch: string; base?: string | null; live?: boolean; publish?: { ids: string[] }; children?: ReactNode }) {
  const [publishing, setPublishing] = useState(false);
  const q = `/branches?ws=${ws}&run=${encodeURIComponent(run)}&branch=${encodeURIComponent(branch)}${base ? `&base=${encodeURIComponent(base)}` : ''}`;
  const { data, error } = useApi<BranchInfo>(q, { pollMs: live ? 4000 : 60_000 });
  const [showDiff, setShowDiff] = useState(false);
  let prStatus: { label: string; tone: string } | null = null;
  if (data?.pr) {
    if (data.pr.state === 'MERGED') prStatus = { label: 'Merged', tone: 'mint' };
    else if (data.pr.state === 'CLOSED') prStatus = { label: 'Closed', tone: 'outline' };
    else if (data.pr.isDraft) prStatus = { label: 'Draft', tone: 'ink' };
    else prStatus = { label: 'Open', tone: 'green' };
  }
  return (
    <Box
      head={
        <>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden style={{ verticalAlign: -2, marginRight: 6 }}>
            <circle cx="4" cy="3.5" r="1.8" />
            <circle cx="4" cy="12.5" r="1.8" />
            <circle cx="12" cy="6" r="1.8" />
            <path d="M4 5.3v5.4M12 7.8c0 2.5-3 2.5-6.3 3.6" />
          </svg>
          {branch}
        </>
      }
      chip={prStatus ? <Chip tone={prStatus.tone}>{prStatus.label}</Chip> : data?.exists ? <Chip tone="ink">local branch</Chip> : <Chip tone="outline">{error ? 'error' : data ? 'not created yet' : '…'}</Chip>}
    >
      {publishing && publish && (
        <FixRunDialog ws={ws} run={run} ids={publish.ids} mode="continue" branch={branch} defaults={{ pr: true, draft: true, base: data?.base ?? base ?? null }} title={`Open a pull request for ${branch}`} submitLabel="Open pull request" onClose={() => setPublishing(false)} />
      )}
      {error && <p className="small" style={{ color: 'var(--err)' }}>{error}</p>}
      {data && !data.exists && <p className="muted small">The branch doesn't exist yet. It's created when the fix job reaches “Create branch &amp; worktree”.</p>}
      {children}
      {data?.exists && (
        <div className="stack" style={{ ['--gap' as string]: '14px' }}>
          <dl className="kv">
            <dt>Base</dt>
            <dd className="mono">
              {data.base} {data.ahead != null && <span className="muted">· {data.ahead} ahead, {data.behind} behind</span>}
            </dd>
            <dt>Head</dt>
            <dd className="mono">{data.head?.slice(0, 12)}</dd>
            <dt>Worktree</dt>
            <dd className="mono small">{data.worktree ?? <span className="muted">removed (branch kept)</span>}</dd>
            <dt>Repo</dt>
            <dd className="mono small">{data.git_root}</dd>
          </dl>
          {data.pr && (
            <div className="box flat" style={{ padding: 12 }}>
              <div className="spread">
                <a href={data.pr.url} target="_blank" rel="noreferrer" className="h3" style={{ fontSize: 15 }}>
                  #{data.pr.number} {data.pr.title}
                </a>
                <span className="row">
                  {data.pr.reviewDecision && <Chip>{data.pr.reviewDecision.replace('_', ' ')}</Chip>}
                  <Chip tone="outline">{data.pr.state}</Chip>
                </span>
              </div>
              {data.pr.checks.length > 0 && (
                <div className="row" style={{ marginTop: 8, gap: 6 }}>
                  {data.pr.checks.map((c, i) => (
                    <Chip key={i} tone={/SUCCESS|COMPLETED/.test(c.state) ? 'mint' : /FAIL|ERROR/.test(c.state) ? 'sev-critical dot' : 'outline'}>
                      {c.name}: {c.state.toLowerCase()}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          )}
          {!data.pr && (
            <div className="stack" style={{ ['--gap' as string]: '8px' }}>
              {publish && !live && data.commits.length > 0 && (
                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <Chamfer small tone="green" onClick={() => setPublishing(true)}>
                    Open pull request…
                  </Chamfer>
                  <span className="small muted">Happy with the diff? This re-checks the bug on the branch, then pushes it and opens a draft PR.</span>
                </div>
              )}
              <div className="row small muted">
                {publish && !live ? 'Or by hand:' : 'No PR yet. To open one manually:'} <code>gh pr create --head {branch} --base {data.base} --draft</code>
                <CopyButton text={`gh pr create --head ${branch} --base ${data.base} --draft --fill`} />
              </div>
            </div>
          )}
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Commits</div>
            {data.commits.length ? (
              <ul className="commits">
                {data.commits.map((c) => (
                  <li key={c.sha}>
                    <code>{c.sha.slice(0, 8)}</code> {c.subject} <span className="muted small">· {c.author} · {dateTime(c.date)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">No commits on the branch yet.</p>
            )}
          </div>
          {data.files.length > 0 && (
            <div>
              <div className="spread" style={{ marginBottom: 6 }}>
                <span className="label">Changed files</span>
                <button className="btn-link" onClick={() => setShowDiff(true)}>
                  View diff
                </button>
              </div>
              <ul className="files">
                {data.files.map((f) => (
                  <li key={f.file}>
                    <code>{f.file}</code>
                    <span className="mono small">
                      <span style={{ color: 'var(--ok)' }}>+{f.added}</span> <span style={{ color: 'var(--err)' }}>−{f.removed}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <Dialog open={showDiff} onClose={() => setShowDiff(false)} title={`${branch} vs ${data.base}`} wide>
                <pre className="mono small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {data.diff_stat}
                </pre>
                <DiffView patch={data.patch} truncated={data.patch_truncated} />
              </Dialog>
            </div>
          )}
        </div>
      )}
    </Box>
  );
}

export function DiffView({ patch, truncated }: { patch: string; truncated?: boolean }) {
  const files = useMemo(() => {
    const out: { name: string; lines: string[] }[] = [];
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git ')) out.push({ name: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), lines: [] });
      else if (out.length && !/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) out[out.length - 1].lines.push(line);
    }
    return out;
  }, [patch]);
  return (
    <div className="diff">
      {files.map((f) => (
        <div key={f.name} className="diff-file">
          <div className="diff-name mono">{f.name}</div>
          <pre>
            {f.lines.map((l, i) => (
              <div key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
                {l || ' '}
              </div>
            ))}
          </pre>
        </div>
      ))}
      {truncated && <p className="muted small">Diff truncated.</p>}
    </div>
  );
}


/** Clickable live-work cards on the dashboard. */
export function ActivityBoard({ jobs, runs = [] }: { jobs: JobView[]; runs?: RunSummary[] }) {
  const reviewed = useJobReviews();
  const awaitingReview = jobsAwaitingReview(jobs, reviewed);
  const activeJobs = jobs.filter((j) => j.state === 'running' && j.alive);
  const activeRuns = runs.filter((r) => r.live);
  const visibleJobs = [...activeJobs, ...awaitingReview];
  return (
    <div className="activity-board">
      <section aria-label="Active runs and jobs" className="box">
        <div className="box-head"><h2 className="h3">Active runs &amp; jobs</h2><Chip tone={activeJobs.length || activeRuns.length ? 'green live' : 'outline'}>{activeJobs.length + activeRuns.length} live</Chip>{awaitingReview.length > 0 && <>
          <Chip tone="outline">{awaitingReview.length} need review</Chip>
          <button type="button" className="btn-ghost" onClick={() => dismissJobs(awaitingReview)}>Dismiss all</button>
        </>}</div>
        <div className="box-body">
          <p className="small muted">Follow progress live. Finished jobs stay here until you view their results or dismiss them.</p>
          {visibleJobs.length || activeRuns.length ? <div className="activity-cards">
            {activeRuns.map((r) => <Link className="activity-card" key={`${r.ws}/${r.run}`} to={`/runs/${r.ws}/${encodeURIComponent(r.run)}`}>
              <span className="spread"><Chip tone="green live">Run · live</Chip><span aria-hidden>↗</span></span>
              <strong>{r.name || targetName(r.target)}</strong>
              <span className="small muted">{r.sessions} sessions · {r.raw_findings} findings</span>
              <span className="mono small muted">Started {ago(r.started_at)}</span>
            </Link>)}
            {visibleJobs.map((j) => <div className="activity-card-wrap" key={j.id}>
            <Link className={`activity-card${j.state !== 'running' ? ' activity-card-review' : ''}`} to={`/jobs/${encodeURIComponent(j.id)}`}>
              <span className="spread"><Chip tone="outline">{j.kind}</Chip>{j.state === 'running' ? <JobStateChip job={j} /> : <Chip tone="outline">{completionLabel(j)} · Needs review</Chip>}</span>
              <strong>{jobScope(j)}</strong>
              <span className="small activity-summary">{j.state === 'running' ? stageLabel(j.stage) : j.error || j.summary || stageLabel(j.stage)}</span>
              <span className="mono small muted">{j.state === 'running' ? `Started ${ago(j.started_at)} · View live →` : `Finished ${ago(j.ended_at ?? j.updated_at)} · Review results →`}</span>
            </Link>
            {j.state !== 'running' && <button type="button" className="activity-dismiss" aria-label={`Dismiss ${j.kind} job ${j.id}`} title="Dismiss from review" onClick={() => dismissJobs([j])}>×</button>}
            </div>)}
          </div> : <p className="small muted">No active work or jobs awaiting review.</p>}
        </div>
      </section>
    </div>
  );
}

function jobScope(job: JobView) {
  return job.finding_ids.join(', ') || job.scope || targetName(String(job.options?.target ?? '')) || job.run?.run || job.id;
}

function completionLabel(job: JobView) {
  if (job.state === 'succeeded') return 'Finished';
  if (job.state === 'failed') return 'Failed';
  return 'Cancelled';
}
