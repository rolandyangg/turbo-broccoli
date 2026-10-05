import { isFixJob } from '../../../src/jobs/kinds.ts';
import { AttachSession } from '../components/AttachSession.tsx';
import { MarkdownDescription } from '../components/MarkdownPreview.tsx';
import { BugPullRequest } from '../components/PrList.tsx';
import { ReproCapture } from '../components/ReproCapture.tsx';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { fileUrl, useApi, useJobStream } from '../lib/api.ts';
import type { BugDetail, Finding, TranscriptItem } from '../lib/types.ts';
import { ago, pct, variantEntries, widthRange } from '../lib/format.ts';
import { Box, Chamfer, Chip, ConfidenceBar, CopyButton, ErrorBox, JsonView, Loading, SevChip, StatusChip, Tabs, FileIcon, Arrow } from '../components/ui.tsx';
import { ImageViewer, type ViewerImage } from '../components/ImageViewer.tsx';
import { VideoPlayer, type Chapter } from '../components/VideoPlayer.tsx';
import { FixDialog, LabelControls, ReproduceDialog } from '../components/Actions.tsx';
import { WorkflowControls } from '../components/Workflow.tsx';
import { FixVerification } from '../components/FixVerification.tsx';
import { ReportProblem } from '../components/ReportProblem.tsx';
import { BranchPanel, CancelButton, JobStateChip, JobTimeline } from '../components/Jobs.tsx';

// Temporarily hide duplicate PR details in the sidebar; flip to restore them.
const SHOW_SIDEBAR_PR_DETAILS = false;

type Media = 'annotated' | 'crop' | 'full' | 'explorer' | 'video' | 'filmstrip' | 'after';

export function Bug() {
  const { ws = '', run = '', id = '' } = useParams();
  const base = `/runs/${ws}/${encodeURIComponent(run)}/bugs/${id}`;
  const { data, error, reload } = useApi<BugDetail>(base, { pollMs: 5000 });
  const [fixScope, setFixScope] = useState<{ ids: string[]; title: string } | null>(null);
  const [seek, setSeek] = useState<{ t_ms: number; n: number } | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [reproOpen, setReproOpen] = useState(false);
  const [reproJob, setReproJob] = useState<string | null>(null);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what={`Loading ${id}`} />;
  const f = data.finding;
  const chapters = (f.video?.chapters ?? []) as Chapter[];
  const defaultMedia: Media = f.video?.mp4 || f.video?.webm ? 'video' : 'annotated';
  const m = media ?? defaultMedia;
  const canFix = !!data.run.repo_path;
  const fixJobs = data.jobs.filter((j) => isFixJob(j));
  const latestJob = fixJobs[0] ?? null;
  const existingPrUrl = f.fix?.pr_url ?? fixJobs.find((j) => j.pr_url)?.pr_url ?? null;
  const showSidebarBranch = SHOW_SIDEBAR_PR_DETAILS || !existingPrUrl;
  const runningJob = fixJobs.find((j) => j.state === 'running' && j.alive) ?? null;
  const liveRepro = reproJob ?? data.jobs.find((j) => j.kind === 'reproduce' && j.state === 'running' && j.alive)?.id ?? null;

  const seekStep = (i: number) => {
    const c = chapters.find((x) => x.kind === 'step' && x.step_index === i);
    if (c) {
      setMedia('video');
      setSeek({ t_ms: c.t_ms, n: Date.now() });
    }
  };

  return (
    <>
      <div className="run-head">
        <div className="label">
          <Link to="/runs">Runs</Link> / <Link to={`/runs/${ws}/${encodeURIComponent(run)}`}>{data.run.name ?? run}</Link> / <Link to={`/runs/${ws}/${encodeURIComponent(run)}#${data.group.id}`}>{data.group.id}</Link> / {f.id}
        </div>
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <span className="mono" style={{ fontWeight: 700 }}>
            {f.id}
          </span>
          <SevChip sev={f.severity} />
          <StatusChip status={f.status} />
          <Chip>{f.type}</Chip>
          <Chip tone="outline">{f.evidence_kind}</Chip>
          {f.history_tag !== 'new' && <Chip tone="sev-major dot">{f.history_tag}</Chip>}
          {f.found_by.seeded_by_code_intel && <Chip tone="mint">code-intel seed</Chip>}
        </div>
        <h1 className="bug-title">{f.title}</h1>
        <p className="mono small muted" style={{ margin: '10px 0 0' }}>
          {f.page} · {f.browsers.join(', ')} · {widthRange(f)} · repro {f.reproduction.rate ?? 'not auto-verified'} · confidence {pct(f.confidence)}
        </p>
      </div>

      <div className="bug-grid">
        {/* ---------------- left: evidence + repro + details ---------------- */}
        <div className="stack" style={{ ['--gap' as string]: '22px', minWidth: 0 }}>
          <MediaPanel f={f} ws={ws} run={run} m={m} setM={setMedia} chapters={chapters} seek={seek} afterShot={data.after_shot} onChapter={(c) => setActiveStep(c?.kind === 'step' ? c.step_index : null)} />

          <BugPullRequest manuallyVerified={data.manually_verified} key={`${ws}/${run}/${f.id}`} ws={ws} run={run} id={f.id} url={existingPrUrl} body={data.pr_body} branch={f.fix?.branch ?? latestJob?.branch ?? null} base={f.fix?.base} readyToPublish={canFix && !runningJob && (!!data.manually_verified || (!!f.fix?.verified && f.fix.verification?.result === 'fixed' && !f.fix.flags?.length && !f.fix.blocked))} onUpdated={reload} />

          <FixVerification groupBlockers={data.group_blockers} manuallyVerified={data.manually_verified} onUpdated={reload} regressions={data.regressions} f={f} ws={ws} run={run} branch={f.fix?.branch ?? latestJob?.branch ?? null} afterShot={data.after_shot} running={!!runningJob} prUrl={f.fix?.pr_url ?? latestJob?.pr_url ?? null} reproducing={!!liveRepro} onReproduceStarted={(job) => setReproJob(job.id)} />

          <Box head="Reproduction" chip={<Chip tone={f.reproduction.rate === '3/3' ? 'mint' : 'outline'}>{f.reproduction.rate ? `${f.reproduction.rate} replays` : 'visual only'}</Chip>}>
            <Repro f={f} chapters={chapters} activeStep={activeStep} onStep={seekStep} spec={data.spec} ws={ws} run={run} />
          </Box>

          <Box head="Details">
            <Details f={f} manuallyVerified={!!data.manually_verified} />
          </Box>

          <Transcript base={base} session={f.found_by.session} />

          <Box head="Raw finding record (findings.json)">
            <JsonView value={f} max={420} />
          </Box>
        </div>

        {/* ---------------- right: actions + fix status ---------------- */}
        <aside className="stack bug-side" style={{ ['--gap' as string]: '18px' }}>
          <Box head="Actions" chip={canFix ? undefined : <Chip tone="outline">no repo</Chip>}>
            <div className="stack" style={{ ['--gap' as string]: '12px' }}>
              <Chamfer tone="light" onClick={() => setReproOpen(true)} disabled={!!liveRepro}>
                {liveRepro ? 'Reproduction window open' : '▶ Reproduce in a new window'}
              </Chamfer>
              {liveRepro && <ReproStatus id={liveRepro} onEnd={() => setReproJob(null)} onSaved={() => void reload()} />}
              {canFix && <AttachSession base={base} />}
              {canFix ? (
                <>
                  <Chamfer tone="green" onClick={() => setFixScope({ ids: [f.id], title: f.title })} disabled={!!runningJob}>
                    {runningJob ? 'Fix in progress…' : f.fix ? 'Fix again' : 'Fix this bug'}
                  </Chamfer>
                  {data.group.findings.length > 1 && (
                    <Chamfer small onClick={() => setFixScope({ ids: [data.group.id], title: data.group.summary })} disabled={!!runningJob}>
                      Fix whole group ({data.group.findings.length})
                    </Chamfer>
                  )}
                </>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  This run was made against a URL without <code>--repo</code>, so there's no code to fix.
                </p>
              )}
              <hr className="divider" style={{ margin: '4px 0' }} />
              <div className="stack" style={{ ['--gap' as string]: '6px' }}>
                <span className="label">Your progress</span>
                <WorkflowControls ws={ws} run={run} f={f} onChanged={reload} />
                {f.workflow?.archived && <span className="small muted">Archived{f.workflow.archived_at ? ` ${ago(f.workflow.archived_at)}` : ''}: it stays in this run's Archived tab and out of the active counts.</span>}
              </div>
              <hr className="divider" style={{ margin: '4px 0' }} />
              <LabelControls ws={ws} run={run} id={f.id} status={f.status} groups={data.groups} currentGroup={data.group.id} onChanged={reload} />
              <hr className="divider" style={{ margin: '4px 0' }} />
              <ReportProblem ws={ws} run={run} id={f.id} reports={data.reports ?? []} />
            </div>
          </Box>

          {(runningJob || latestJob) && <FixStatus job={(runningJob ?? latestJob)!} ws={ws} run={run} onDone={reload} showBranch={showSidebarBranch} />}

          {showSidebarBranch && f.fix && !(runningJob ?? latestJob)?.branch && <BranchPanel ws={ws} run={run} branch={f.fix.branch} base={f.fix.base} publish={{ ids: [f.id] }} />}

          {data.jobs.length > 0 && (
            <Box head={`Jobs for this bug (${data.jobs.length})`}>
              <ul className="bug-jobs">
                {data.jobs.map((j) => (
                  <li key={j.id}>
                    <Link to={`/jobs/${j.id}`} className="bug-job">
                      <Chip tone="outline">{j.kind}</Chip>
                      <JobStateChip job={j} />
                      <span className="small muted">
                        {j.scope && j.scope !== f.id ? `${j.scope} · ` : ''}
                        {ago(j.started_at)}
                        {j.error && j.state !== 'running' ? ` · ${j.error.split('\n')[0].slice(0, 70)}` : ''}
                      </span>
                    </Link>
                    {j.pr_url && (
                      <a href={j.pr_url} target="_blank" rel="noreferrer" className="small">
                        PR ↗
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </Box>
          )}

          <Box head={`Root cause ${data.group.id}`} chip={<Chip>{data.group.findings.length} finding{data.group.findings.length > 1 ? 's' : ''}</Chip>}>
            <p style={{ marginTop: 0 }}>{data.group.summary}</p>
            {data.group.fix_plan && (
              <p className="small">
                <b className="label">Fix plan</b> {data.group.fix_plan}
              </p>
            )}
            {data.group.files.length > 0 && (
              <div className="row" style={{ gap: 6 }}>
                {data.group.files.map((x) => (
                  <code key={x} className="chip">
                    {x}
                  </code>
                ))}
              </div>
            )}
            <ul className="siblings">
              {data.group.findings.map((s) => (
                <li key={s.id} className={s.id === f.id ? 'on' : ''}>
                  <Link to={`/runs/${ws}/${encodeURIComponent(run)}/bugs/${s.id}`}>
                    <span className="mono small">{s.id}</span> {s.title}
                  </Link>{' '}
                  <StatusChip status={s.status} />
                </li>
              ))}
            </ul>
          </Box>

          {SHOW_SIDEBAR_PR_DETAILS && data.pr_body && (
            <Box head="PR description draft">
              <MarkdownDescription text={data.pr_body} />
            </Box>
          )}
        </aside>
      </div>

      <ReproduceDialog
        open={reproOpen}
        onClose={() => setReproOpen(false)}
        ws={ws}
        run={run}
        id={f.id}
        env={{ browser: f.reproduction.environment.browser, viewport: f.reproduction.environment.viewport, device: f.reproduction.environment.variant.device ?? null }}
        onStarted={(job) => setReproJob(job.id)}
      />
      {fixScope && <FixDialog open onClose={() => setFixScope(null)} ws={ws} run={run} ids={fixScope.ids} title={fixScope.title} onStarted={() => void reload()} />}
    </>
  );
}

// ---------------- media ----------------
function MediaPanel({ f, ws, run, m, setM, chapters, seek, afterShot, onChapter }: { f: Finding; ws: string; run: string; m: Media; setM: (m: Media) => void; chapters: Chapter[]; seek: { t_ms: number; n: number } | null; afterShot: string | null; onChapter: (c: Chapter | null) => void }) {
  const [viewer, setViewer] = useState<number | null>(null);
  const explorerShot = f.screenshots.explorer ?? null;
  const v = f.video;
  const tabs: { id: Media; label: string }[] = [
    ...(v?.mp4 || v?.webm ? [{ id: 'video' as Media, label: 'Video' }] : []),
    { id: 'annotated', label: 'Annotated' },
    { id: 'crop', label: 'Close-up' },
    { id: 'full', label: 'Full page' },
    ...(v?.filmstrip ? [{ id: 'filmstrip' as Media, label: 'Filmstrip' }] : []),
    ...(afterShot ? [{ id: 'after' as Media, label: 'After fix' }] : []),
    ...(explorerShot ? [{ id: 'explorer' as Media, label: "Explorer's shot" }] : []),
  ];
  const pathOf = (k: Media) => (k === 'annotated' ? f.screenshots.annotated : k === 'crop' ? f.screenshots.crop : k === 'full' ? f.screenshots.full : k === 'filmstrip' ? v?.filmstrip : k === 'after' ? afterShot : k === 'explorer' ? explorerShot : null);
  const img = pathOf(m);
  // Every still image of this bug, in tab order, for flipping through in the viewer.
  const gallery: (ViewerImage & { key: Media })[] = tabs.filter((t) => t.id !== 'video' && pathOf(t.id)).map((t) => ({ key: t.id, label: `${f.id} · ${t.label}`, src: fileUrl(ws, run, pathOf(t.id)) }));
  return (
    <div className="box media">
      <Tabs<Media> tabs={tabs} value={m} onChange={setM} />
      <div className="media-stage">
        {m === 'video' && v && (
          <VideoPlayer src={fileUrl(ws, run, v.mp4 ?? v.webm)} poster={fileUrl(ws, run, f.screenshots.annotated)} chapters={chapters} bugAtMs={v.bug_at_ms} seek={seek} onChapter={onChapter} />
        )}
        {m !== 'video' && img && (
          <button className="media-img" onClick={() => setViewer(Math.max(0, gallery.findIndex((g) => g.key === m)))} title="Click to zoom and pan">
            <img src={fileUrl(ws, run, img)} alt={`${f.id} ${m}`} />
            <span className="media-zoom-hint label">Click to zoom</span>
          </button>
        )}
        {m === 'after' && f.screenshots.annotated && (
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            Same steps and viewport replayed on the fix branch.
          </p>
        )}
      </div>
      <div className="row media-foot">
        <span className="label">Legend</span>
        <span className="row small">
          <i className="swatch" style={{ borderColor: '#ff1744' }} /> defect
        </span>
        <span className="row small">
          <i className="swatch" style={{ borderColor: '#ff9100' }} /> related element
        </span>
        <span className="row small">
          <i className="swatch dashed" style={{ borderColor: '#2979ff' }} /> element acted on (video)
        </span>
        <span style={{ marginLeft: 'auto' }} className="row">
          {v?.gif && (
            <a className="btn-ghost" href={fileUrl(ws, run, v.gif)} target="_blank" rel="noreferrer">
              GIF
            </a>
          )}
          {v?.trace && (
            <>
              <a className="btn-ghost" href={fileUrl(ws, run, v.trace, true)}>
                Playwright trace
              </a>
              <CopyButton text={`npx playwright show-trace "${v.trace}"`} label="Copy show-trace" />
            </>
          )}
        </span>
      </div>
      {viewer !== null && gallery.length > 0 && <ImageViewer images={gallery} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

// ---------------- reproduction ----------------
function Repro({ f, chapters, activeStep, onStep, spec, ws, run }: { f: Finding; chapters: Chapter[]; activeStep: number | null; onStep: (i: number) => void; spec: string | null; ws: string; run: string }) {
  const [trace, setTrace] = useState<'minimal' | 'original' | null>(null);
  const env = f.reproduction.environment;
  const variant = variantEntries(env.variant as unknown as Record<string, unknown>);
  const hasStepChapters = chapters.some((c) => c.kind === 'step');
  const steps = f.reproduction.steps_human;
  return (
    <div className="stack" style={{ ['--gap' as string]: '16px' }}>
      <div className="row" style={{ gap: 6 }}>
        <Chip tone="ink">{env.browser}</Chip>
        <Chip>
          {env.viewport.width}×{env.viewport.height}
        </Chip>
        {variant.map(([k, v]) => (
          <Chip key={k} tone="outline">
            {k}: {Array.isArray(v) ? v.join('/') : String(v)}
          </Chip>
        ))}
        {env.persona && <Chip tone="mint">{env.persona}</Chip>}
        {f.viewports.length > 1 && <Chip tone="outline">affects {widthRange(f)}</Chip>}
      </div>
      <ol className="steps">
        {steps.map((s, i) => {
          const isLast = i === steps.length - 1 && !f.reproduction.steps_minimal[i];
          const clickable = hasStepChapters && !isLast;
          return (
            <li key={i} className={`${activeStep === i ? 'on' : ''} ${isLast ? 'look' : ''}`}>
              {clickable ? (
                <button onClick={() => onStep(i)} title="Play this step in the video">
                  <span>{s}</span> <span className="label">▶ play</span>
                </button>
              ) : (
                <span>{s}</span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="ea">
        <div className="expected">
          <div className="label">Expected</div>
          {f.reproduction.expected}
        </div>
        <div className="actual">
          <div className="label">Actual</div>
          {f.reproduction.actual}
        </div>
      </div>
      <div className="row">
        <button className={`btn-ghost ${trace === 'minimal' ? 'on' : ''}`} onClick={() => setTrace(trace === 'minimal' ? null : 'minimal')}>
          Minimal trace ({f.reproduction.steps_minimal.length} steps)
        </button>
        <button className={`btn-ghost ${trace === 'original' ? 'on' : ''}`} onClick={() => setTrace(trace === 'original' ? null : 'original')}>
          Original explorer trace ({f.reproduction.steps_original.length} steps)
        </button>
      </div>
      {trace && <JsonView value={trace === 'minimal' ? f.reproduction.steps_minimal : f.reproduction.steps_original} max={320} />}
      {spec && (
        <details>
          <summary className="spread" style={{ cursor: 'pointer' }}>
            <span className="label">Executable repro · {f.reproduction.spec}</span>
            <span className="row" onClick={(e) => e.preventDefault()}>
              <CopyButton text={`BUGBASH_BASE_URL=<app url> npx playwright test -c repros/playwright.config.mjs ${f.id}`} label="Copy run command" />
              <a className="btn-ghost" href={fileUrl(ws, run, f.reproduction.spec, true)}>
                Download
              </a>
            </span>
          </summary>
          <pre className="code" style={{ marginTop: 10 }}>
            {spec}
          </pre>
        </details>
      )}
    </div>
  );
}

// ---------------- details ----------------
function Details({ f, manuallyVerified = false }: { f: Finding; manuallyVerified?: boolean }) {
  const b = f.confidence_breakdown;
  const parts = (['explorer', 'reviewer', 'detector', 'repro'] as const).filter((k) => b[k] != null);
  return (
    <div className="stack" style={{ ['--gap' as string]: '18px' }}>
      {f.description && <p style={{ margin: 0 }}>{f.description}</p>}
      <div className="grid-2" style={{ gap: 14 }}>
        {f.likely_cause && (
          <div className="box flat" style={{ padding: 12 }}>
            <div className="label">Likely cause</div>
            {f.likely_cause}
          </div>
        )}
        {f.fix_hint && (
          <div className="box flat" style={{ padding: 12, background: 'color-mix(in srgb, var(--mint) 40%, transparent)' }}>
            <div className="label">Fix hint</div>
            {f.fix_hint}
          </div>
        )}
      </div>
      {f.source_hints.length > 0 && (
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Source hints</div>
          <ul className="files">
            {f.source_hints.map((h, i) => (
              <li key={i}>
                <code>
                  <FileIcon /> {h.file}
                  {h.line ? `:${h.line}` : ''}
                </code>
                <span className="small muted">{h.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid-2" style={{ gap: 14 }}>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Confidence</div>
          <ConfidenceBar value={f.confidence} w={160} />
          <table className="t" style={{ marginTop: 8 }}>
            <tbody>
              {parts.map((k) => (
                <tr key={k}>
                  <td className="label">{k}</td>
                  <td>
                    <ConfidenceBar value={b[k] as number} w={110} />
                  </td>
                </tr>
              ))}
              <tr>
                <td className="label">raw → calibrated</td>
                <td className="mono small">
                  {b.raw != null ? pct(b.raw) : '—'} → {b.calibrated != null ? pct(b.calibrated) : '—'} <span className="muted">({b.calibration_bucket ?? 'uncalibrated'})</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Found by</div>
          <dl className="kv">
            <dt>Session</dt>
            <dd className="mono">{f.found_by.session ?? '—'}</dd>
            <dt>Persona</dt>
            <dd>{f.found_by.persona ?? '—'}</dd>
            <dt>Strategy</dt>
            <dd className="mono small">{f.found_by.strategy ?? '—'}</dd>
            <dt>Hypothesis</dt>
            <dd>{f.found_by.hypothesis ?? '—'}</dd>
          </dl>
        </div>
      </div>
      <div className="grid-2" style={{ gap: 14 }}>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Element</div>
          <dl className="kv">
            <dt>Selector</dt>
            <dd>
              <code>{f.element.selector ?? '—'}</code>
            </dd>
            <dt>Text</dt>
            <dd>{f.element.text ?? '—'}</dd>
            <dt>Box</dt>
            <dd className="mono small">{f.element.bbox ? `${f.element.bbox.x},${f.element.bbox.y} · ${f.element.bbox.width}×${f.element.bbox.height}` : '—'}</dd>
            <dt>Component</dt>
            <dd className="mono small">{f.element.signature ?? '—'}</dd>
          </dl>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Measurements</div>
          <Metrics metrics={f.metrics} />
        </div>
      </div>
      {f.viewports.length > 0 && (
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Affected viewports</div>
          <div className="row" style={{ gap: 6 }}>
            {f.viewports.map((v) => (
              <Chip key={`${v.width}x${v.height}`} tone="outline">
                {v.width}×{v.height}
              </Chip>
            ))}
          </div>
        </div>
      )}
      {b.notes.length > 0 && (
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Triage notes</div>
          <ul className="notes">
            {b.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {f.fix && (
        <div>
          <div className="label" style={{ marginBottom: 6 }}>Fix record</div>
          <dl className="kv">
            <dt>Branch</dt>
            <dd className="mono">{f.fix.branch}</dd>
            <dt>Base</dt>
            <dd className="mono">{f.fix.base ?? '—'}</dd>
            <dt>Automatic verification</dt>
            <dd>{f.fix.verified ? 'yes' : 'incomplete'}</dd>
            <dt>Manual verification</dt>
            <dd>{manuallyVerified ? 'verified; ready for PR' : 'not recorded'}</dd>
            <dt>Fixed by</dt>
            <dd className="mono">{f.fix.fixed_by ?? '—'}</dd>
            <dt>PR</dt>
            <dd>{f.fix.pr_url ? <a href={f.fix.pr_url}>{f.fix.pr_url}</a> : '—'}</dd>
            <dt>When</dt>
            <dd>{ago(f.fix.at)}</dd>
          </dl>
        </div>
      )}
      {f.label_note && (
        <p className="small">
          <b className="label">Label note</b> {f.label_note}
        </p>
      )}
    </div>
  );
}

function Metrics({ metrics }: { metrics: Record<string, unknown> }) {
  const rows = Object.entries(metrics).filter(([k]) => k !== 'related' && k !== 'message');
  const related = metrics.related as { selector?: string; text?: string } | undefined;
  return (
    <div>
      {typeof metrics.message === 'string' && <p className="small" style={{ marginTop: 0 }}>{metrics.message}</p>}
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd className="mono small">
              <MetricValue v={v} />
            </dd>
          </div>
        ))}
        {related?.selector && (
          <>
            <dt>related</dt>
            <dd>
              <code>{related.selector}</code> {related.text && <span className="small muted">“{related.text.slice(0, 60)}”</span>}
            </dd>
          </>
        )}
      </dl>
      {!rows.length && !related && <p className="muted small">No detector measurements (judged visually).</p>}
    </div>
  );
}

function MetricValue({ v }: { v: unknown }) {
  if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'selector' in (x as object)))
    return (
      <ul className="metric-list">
        {(v as { selector: string; text?: string }[]).map((x, i) => (
          <li key={i}>
            <code>{x.selector}</code> {x.text && <span className="muted">“{x.text.slice(0, 50)}”</span>}
          </li>
        ))}
      </ul>
    );
  if (Array.isArray(v)) return <>{v.join(', ')}</>;
  if (v && typeof v === 'object') return <>{JSON.stringify(v)}</>;
  return <>{String(v)}</>;
}

// ---------------- transcript ----------------
function Transcript({ base, session }: { base: string; session: string | null }) {
  const [open, setOpen] = useState(false);
  const { data, loading } = useApi<{ session: string | null; items: TranscriptItem[]; total: number }>(open ? `${base}/transcript` : null);
  return (
    <div className="box">
      <div className="box-head">
        <div className="path">Explorer transcript · how the agent found it {session ? `(${session.split(',')[0]})` : ''}</div>
        <button className="btn-link" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className="box-body">
          {loading && <Loading what="Loading transcript" />}
          {data && !data.items.length && <p className="muted">No transcript saved for this session.</p>}
          {data && data.items.length > 0 && (
            <>
              <p className="small muted" style={{ marginTop: 0 }}>
                Last {data.items.length} of {data.total} steps, ending where the agent recorded this finding.
              </p>
              <ol className="transcript">
                {data.items.map((it, i) => (
                  <li key={i} className={it.kind}>
                    {it.kind === 'text' && <div className="md-text">{it.text}</div>}
                    {it.kind === 'tool' && (
                      <div>
                        <span className="chip ink">{it.name}</span> <code className="small">{JSON.stringify(it.input).slice(0, 300)}</code>
                      </div>
                    )}
                    {it.kind === 'result' && (
                      <details>
                        <summary className={`small ${it.is_error ? '' : 'muted'}`} style={it.is_error ? { color: 'var(--err)' } : undefined}>
                          {it.is_error ? 'error: ' : '↳ '}
                          {(it.text ?? '').split('\n')[0].slice(0, 140)} {it.image ? '[+ screenshot]' : ''}
                        </summary>
                        <pre className="code" style={{ marginTop: 6, maxHeight: 260 }}>
                          {it.text}
                        </pre>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- fix status (live) ----------------
function FixStatus({ job, ws, run, onDone, showBranch }: { job: BugDetail['jobs'][number]; ws: string; run: string; onDone: () => void; showBranch: boolean }) {
  const { status, events, ended } = useJobStream(job.id);
  const st = status ?? job;
  useEffect(() => {
    if (ended) onDone();
  }, [ended]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Box
        head={`${st.kind === 'fix' ? 'Fix' : st.kind} job · ${st.id}`}
        chip={<JobStateChip job={st} />}
        foot={
          <>
            Open job <Arrow />
          </>
        }
        footHref={`/jobs/${st.id}`}
      >
        <div className="stack" style={{ ['--gap' as string]: '12px' }}>
          <div className="spread small">
            <span className="muted">
              {st.finding_ids.join(', ')} · started {ago(st.started_at)}
            </span>
            <CancelButton job={st} onDone={onDone} />
          </div>
          {st.error && st.state !== 'running' && (
            <div className="small" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>
              {st.error}
            </div>
          )}
          <JobTimeline events={events} status={st} />
        </div>
      </Box>
      {showBranch && st.branch && <BranchPanel ws={ws} run={run} branch={st.branch} base={st.base} live={st.state === 'running'} publish={{ ids: st.scope && /^RC-\d+$/i.test(st.scope) ? [st.scope] : st.finding_ids }} />}
    </>
  );
}

/** Compact live status of a reproduction window (steps as they replay; cancel closes the window). */
function ReproStatus({ id, onEnd, onSaved }: { id: string; onEnd: () => void; onSaved: () => void }) {
  const { status, events, ended } = useJobStream(id);
  useEffect(() => {
    if (ended) onEnd();
  }, [ended]); // eslint-disable-line react-hooks/exhaustive-deps
  const last = [...events].reverse().find((e) => e.level !== 'agent');
  if (!status) return null;
  return (
    <div className="box flat" style={{ padding: 10 }}>
      <div className="spread">
        <JobStateChip job={status} />
        <CancelButton job={status} />
      </div>
      <p className={`small ${last?.level === 'warn' || last?.level === 'error' ? '' : 'muted'}`} style={{ margin: '8px 0 0', color: last?.level === 'error' ? 'var(--err)' : undefined }}>
        {status.error && status.state !== 'running' ? status.error : last?.msg ?? 'Starting…'}
      </p>
      <ReproCapture key={status.id} job={status} onSaved={onSaved} />
    </div>
  );
}
