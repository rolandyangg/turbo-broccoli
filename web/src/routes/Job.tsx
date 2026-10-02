import { ReproCapture } from '../components/ReproCapture.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, useApi, useJobStream } from '../lib/api.ts';
import type { JobView, RunDetail, TranscriptItem } from '../lib/types.ts';
import { ago, dateTime, duration, targetName } from '../lib/format.ts';
import { Box, Chamfer, Chip, Dialog, ErrorBox, JsonView, Loading, Arrow, useToast } from '../components/ui.tsx';
import { BranchPanel, CancelButton, JobStateChip, JobTimeline, JobsTable } from '../components/Jobs.tsx';
import { FixRunDialog, type FixRunDefaults } from '../components/Actions.tsx';
import { AgentChat } from '../components/AgentChat.tsx';

export function Job() {
  const { id = '' } = useParams();
  const [conversationTurn, setConversationTurn] = useState(0);
  return <JobDetails key={`${id}:${conversationTurn}`} id={id} onFollowup={() => setConversationTurn((turn) => turn + 1)} />;
}

function JobDetails({ id, onFollowup }: { id: string; onFollowup: (job: JobView) => void }) {
  const { data: initial, error, reload } = useApi<JobView & { branch_exists?: boolean | null }>(`/jobs/${id}`);
  const { status, events, ended } = useJobStream(id);
  const job = status ? { ...initial, ...status, branch_exists: initial?.branch_exists ?? null } : initial;
  useEffect(() => {
    if (ended) document.title = `Job ${job?.state ?? 'done'} · TurboBrocolli`;
    if (ended) void reload(); // pick up the final PR link and whether the branch is still there
  }, [ended, job?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorBox error={error} />;
  if (!job) return <Loading what="Loading job" />;
  const runLink = job.run ? `/runs/${job.run.ws}/${encodeURIComponent(job.run.run)}` : null;
  const target = (job.options?.target as string | undefined) ?? null;
  return (
    <>
      <div className="run-head">
        <div className="label">
          <Link to="/jobs">Jobs</Link> / {job.id}
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <Chip tone="outline">{job.kind}</Chip>
          <JobStateChip job={job} />
          {job.pr_url && (
            <a href={job.pr_url} target="_blank" rel="noreferrer">
              <Chip tone="green">PR</Chip>
            </a>
          )}
        </div>
        <h1 className="display" style={{ fontSize: 'clamp(28px, 4vw, 54px)', marginTop: 12 }}>
          {job.kind === 'fix' ? `Fixing ${job.finding_ids.join(', ')}` : job.kind === 'explore' ? `Bug bash: ${targetName(target ?? '')}` : job.kind === 'reproduce' ? `Reproducing ${job.finding_ids.join(', ')}` : job.kind === 'retro' ? 'Retrospective' : job.kind === 'improve' ? `Implementing ${job.scope ?? 'improvement'}` : job.kind === 'connect' ? 'Connecting GitHub' : job.kind === 'investigate' ? `Investigating ${job.scope ?? 'a report'}` : 'Triage'}
        </h1>
        <p className="mono small muted" style={{ margin: '8px 0 0' }}>
          started {dateTime(job.started_at)} ({ago(job.started_at)}) · {duration(job.started_at, job.ended_at)}
          {job.ended_at ? '' : ' so far'}
        </p>
        {job.kind === 'fix' && <FixOutcome job={job} />}
        {(job.kind === 'retro' || job.kind === 'improve') && (
          <p style={{ margin: '8px 0 0' }}>
            <Link to={job.kind === 'retro' ? '/improvements' : '/improvements?tab=backlog'}>Open Improvements →</Link>
          </p>
        )}
      </div>
      <div className="bug-grid">
        <div className="stack" style={{ ['--gap' as string]: '20px', minWidth: 0 }}>
          <Box head="Progress" chip={<CancelButton job={job} />}>
            {job.error && job.state !== 'running' && (
              <div className="small" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap', marginBottom: 12 }}>
                {job.error}
              </div>
            )}
            <JobTimeline events={events} status={job} />
            <ReproCapture key={job.id} job={job} />
          </Box>
          <AgentChat job={job} events={events} onFollowup={onFollowup} />
          {job.kind === 'explore' && job.run && <LiveSessions ws={job.run.ws} run={job.run.run} live={job.state === 'running'} />}
          {job.log_tail && (
            <details className="box">
              <summary className="box-head" style={{ cursor: 'pointer' }}>
                <span className="path">Process log (tail)</span>
              </summary>
              <pre className="code" style={{ maxHeight: 420 }}>
                {job.log_tail}
              </pre>
            </details>
          )}
        </div>
        <aside className="stack" style={{ ['--gap' as string]: '18px' }}>
          {job.alive && job.kind !== 'connect' && <ModelPicker jobId={job.id} />}
          <Box head="Job">
            <dl className="kv">
              <dt>Kind</dt>
              <dd>{job.kind}</dd>
              <dt>Stage</dt>
              <dd>{job.stage}</dd>
              {job.finding_ids.length > 0 && (
                <>
                  <dt>Findings</dt>
                  <dd>
                    {job.run
                      ? job.finding_ids.map((f) => (
                          <Link key={f} className="mono" style={{ marginRight: 8 }} to={/^RC-/.test(f) ? `${runLink}#${f}` : `${runLink}/bugs/${f}`}>
                            {f}
                          </Link>
                        ))
                      : job.finding_ids.join(', ')}
                  </dd>
                </>
              )}
              {job.also_fixed.length > 0 && (
                <>
                  <dt>Also fixed</dt>
                  <dd className="mono">{job.also_fixed.join(', ')}</dd>
                </>
              )}
              {job.verified != null && (
                <>
                  <dt>Verified</dt>
                  <dd>{job.verified ? 'yes: repro checks pass, no regressions' : 'no'}</dd>
                </>
              )}
              <dt>Options</dt>
              <dd className="mono small">{JSON.stringify(job.options)}</dd>
              <dt>PID</dt>
              <dd className="mono small">
                {job.pid} {job.alive ? '(alive)' : ''}
              </dd>
            </dl>
          </Box>
          {runLink && (
            <Box
              head="Run"
              foot={
                <>
                  Open run <Arrow />
                </>
              }
              footHref={runLink}
            >
              <span className="mono small">{job.run?.run}</span>
            </Box>
          )}
          {job.branch && job.run && <BranchPanel ws={job.run.ws} run={job.run.run} branch={job.branch} base={job.base} live={job.state === 'running'} />}
          <details className="box">
            <summary className="box-head" style={{ cursor: 'pointer' }}>
              <span className="path">Raw status.json</span>
            </summary>
            <JsonView value={job} max={360} />
          </details>
        </aside>
      </div>
    </>
  );
}

/** Explorer sessions from campaign.json, each with its most recent agent actions. */
function LiveSessions({ ws, run, live }: { ws: string; run: string; live: boolean }) {
  const { data } = useApi<RunDetail>(`/runs/${ws}/${encodeURIComponent(run)}`, { pollMs: live ? 4000 : undefined });
  const jobs = data?.campaign?.jobs ?? [];
  if (!jobs.length) return null;
  return (
    <Box head="Explorer sessions" chip={(() => {
        const n = jobs.filter((j) => j.status === 'running').length;
        return <Chip tone={n ? 'green live' : 'outline'}>{n ? `${n} running` : `${jobs.length} done`}</Chip>;
      })()}>
      <div className="stack" style={{ ['--gap' as string]: '14px' }}>
        {data?.campaign?.decisions?.length ? (
          <details>
            <summary className="btn-link">Lead decisions ({data.campaign.decisions.length})</summary>
            <ol className="decisions">
              {data.campaign.decisions.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ol>
          </details>
        ) : null}
        {jobs.map((j) => (
          <div key={j.id} className="box flat" style={{ padding: 12 }}>
            <div className="spread">
              <span className="mono small">
                <b>{j.id}</b> · {j.browser}
                {j.persona ? ` · ${j.persona}` : ''}
              </span>
              <span className="row">
                {j.new_findings != null && <Chip tone="mint">{j.new_findings} new</Chip>}
                {j.status === 'running' ? <Chip tone="green live">running</Chip> : <Chip tone="outline">{j.status}</Chip>}
              </span>
            </div>
            <p className="small" style={{ margin: '6px 0' }}>
              {j.goal}
            </p>
            {j.status === 'running' && <SessionTail ws={ws} run={run} session={j.id} />}
            {j.status !== 'running' && j.summary && (
              <details>
                <summary className="btn-link">Session summary</summary>
                <p className="small md-text">{j.summary}</p>
              </details>
            )}
          </div>
        ))}
      </div>
    </Box>
  );
}

function SessionTail({ ws, run, session }: { ws: string; run: string; session: string }) {
  const { data } = useApi<{ items: TranscriptItem[]; total: number }>(`/runs/${ws}/${encodeURIComponent(run)}/sessions/${session}/tail?n=8`, { pollMs: 3000 });
  if (!data?.items.length) return <p className="small muted">Starting…</p>;
  return (
    <ul className="tl-agent" style={{ listStyle: 'none', margin: 0 }}>
      <li className="label">{data.total} actions so far</li>
      {data.items.map((it, i) => (
        <li key={i} className={it.kind === 'tool' ? 'tool' : 'text'} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
          {it.kind === 'tool' ? (
            <>
              <span className="chip">{it.name}</span> <code style={{ overflowWrap: 'anywhere' }}>{JSON.stringify(it.input).slice(0, 140)}</code>
            </>
          ) : (
            <em>{it.text}</em>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Jobs() {
  const { data, error } = useApi<JobView[]>('/jobs', { pollMs: 4000 });
  if (error) return <ErrorBox error={error} />;
  return (
    <>
      <div className="run-head">
        <h1 className="display h1" style={{ fontSize: 'clamp(34px, 5.5vw, 72px)' }}>
          Jobs
        </h1>
        <p className="muted">Fix, explore and triage jobs from the web app and the CLI. Jobs keep running if you close this page.</p>
      </div>
      <div style={{ marginTop: 20 }}>{data ? <JobsTable jobs={data} /> : <Loading what="Loading jobs" />}</div>
    </>
  );
}

/**
 * After a fix job: the pull request (when there is one), and what to do next. Continue picks the branch up where it
 * stopped (re-verifies, more attempts only if needed, then commits and publishes); Retry starts over on a new branch.
 */
function FixOutcome({ job }: { job: JobView & { branch_exists?: boolean | null } }) {
  const [mode, setMode] = useState<'continue' | 'retry' | 'verify' | 'publish-anyway' | null>(null);
  const running = job.state === 'running' && job.alive;
  const notPublished = !!job.error && /Not published/.test(job.error);
  const blocked = !!job.error && /Blocked: not fully verified/.test(job.error);
  const flags = ((job.options as { flags?: string[] } | undefined)?.flags ?? []).filter(Boolean);
  if (running) return null;
  const canContinue = !!job.branch && job.branch_exists === true && job.run;
  const showNext = job.run && (job.state !== 'succeeded' || notPublished || job.verified === false || !job.pr_url);
  return (
    <div className="stack" style={{ ['--gap' as string]: '10px', marginTop: 14 }}>
      {job.pr_url && (
        <a className="pr-link box" href={job.pr_url} target="_blank" rel="noreferrer">
          <span className="label">Pull request</span>
          <span className="mono">{job.pr_url.replace(/^https:\/\/github\.com\//, '')}</span>
          <span className="small">Open on GitHub ↗</span>
        </a>
      )}
      {(blocked || flags.length > 0) && (
        <div className="fix-flags" role="status">
          <b className="small">{blocked ? "Publishing was blocked: the fix isn't fully verified, so nothing was pushed." : 'Verification flags:'}</b>
          {flags.length > 0 && (
            <ul>
              {flags.map((x, i) => (
                <li key={i} className="small">
                  {x}
                </li>
              ))}
            </ul>
          )}
          <p className="small muted" style={{ margin: '6px 0 0' }}>Compare the before/after on the bug page, then send the agent instructions, retry verification, or publish anyway.</p>
        </div>
      )}
      {showNext && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {canContinue && (
            <Chamfer small tone="green" onClick={() => setMode('continue')}>
              {notPublished && !blocked ? 'Continue: push and open the PR' : 'Continue on this branch'}
            </Chamfer>
          )}
          {canContinue && (blocked || job.verified === false) && (
            <button className="btn-ghost" onClick={() => setMode('verify')}>
              Retry verification
            </button>
          )}
          {canContinue && blocked && (
            <Chamfer small tone="danger" onClick={() => setMode('publish-anyway')}>
              Publish anyway…
            </Chamfer>
          )}
          <button className="btn-ghost" onClick={() => setMode('retry')}>
            Retry from scratch
          </button>
          {job.branch && job.branch_exists === false && <span className="small muted">Branch {job.branch} is gone, so only a retry is possible.</span>}
        </div>
      )}
      {mode && job.run && (
        <FixRunDialog
          ws={job.run.ws}
          run={job.run.run}
          ids={job.scope && /^RC-\d+$/i.test(job.scope) ? [job.scope] : job.finding_ids}
          mode={mode}
          branch={job.branch}
          defaults={(job.options ?? {}) as FixRunDefaults}
          onClose={() => setMode(null)}
        />
      )}
    </div>
  );
}
