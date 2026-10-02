import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, fileUrl, useApi } from '../lib/api.ts';
import type { JobView } from '../lib/types.ts';
import { ago, targetName } from '../lib/format.ts';
import { Chamfer, Chip, Dialog, ErrorBox, Loading, Stat, Tabs, useToast } from '../components/ui.tsx';
import { DataTable } from '../components/Charts.tsx';
import { ImprovementPrList } from '../components/ImprovementPrList.tsx';

type Kind = 'lesson' | 'prior' | 'detector' | 'tweak';
interface Proposal {
  id: string;
  run: string;
  source: 'retro' | 'lead' | 'report';
  kind: Kind;
  scope: 'site' | 'general';
  title: string;
  body: string;
  prior: { strategy: string; persona: string | null; page_kind: string | null; effect: 'prefer' | 'avoid' } | null;
  detector: { finding_type: string; sketch: string } | null;
  tweak: { target: string; change: string } | null;
  evidence: { finding_ids: string[]; numbers: string[]; transcripts: string[] };
  status: 'pending' | 'approved' | 'rejected';
  edited: boolean;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
}
interface RunGroup {
  ws: string;
  run: string;
  name: string | null;
  target: string;
  retro: { ok: boolean; at: string; error: string | null; summary: string; job_id: string | null } | null;
  proposals: Proposal[];
}
interface BacklogItem {
  ws: string;
  id: string;
  proposal_id: string;
  run: string;
  kind: 'detector' | 'tweak';
  title: string;
  body: string;
  detector: Proposal['detector'];
  tweak: Proposal['tweak'];
  status: 'open' | 'implementing' | 'implemented' | 'merged' | 'failed' | 'closed';
  branch: string | null;
  job_id: string | null;
  pr_url: string | null;
  error: string | null;
  created_at: string;
}
interface Overview {
  pending: number;
  runs: RunGroup[];
  backlog: BacklogItem[];
  priors: { ws: string; id: string; strategy: string; persona: string | null; page_kind: string | null; effect: string; reason: string; proposal_id: string; approved_at: string }[];
  rejected: number;
  lessons: { ws: string; path: string; text: string }[];
  bench: { version: string; commit: string | null; runs: { run: string; recall: number; precision: number | null }[]; best_recall: number; mean_recall: number; regression: { from: string; drop: number } | null }[];
  jobs: JobView[];
}

const KIND_LABEL: Record<Kind, string> = { lesson: 'Lesson', prior: 'Strategy prior', detector: 'Detector suggestion', tweak: 'Prompt / config tweak' };
const APPROVE_EFFECT: Record<Kind, string> = {
  lesson: 'Approving adds it to the lessons future leads and explorers read.',
  prior: 'Approving adds it to the strategy priors the lead plans with.',
  detector: 'Approving puts it on the backlog. Code only changes if you implement it on a branch and merge it.',
  tweak: 'Approving puts it on the backlog. Code only changes if you implement it on a branch and merge it.',
};
type Tab = 'pending' | 'backlog' | 'prs' | 'knowledge' | 'bench' | 'history';
const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export function Improvements() {
  const { data, error, reload } = useApi<Overview>('/improvements', { pollMs: 8000 });
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'pending';
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what="Loading improvements" />;
  const all = data.runs.flatMap((r) => r.proposals.map((p) => ({ p, r })));
  const approved = all.filter(({ p }) => p.status === 'approved').length;
  const openBacklog = data.backlog.filter((b) => b.status !== 'closed' && b.status !== 'implemented' && b.status !== 'merged').length;
  const regressed = data.bench.some((v) => v.regression);
  const prOpen = new Set(data.backlog.filter((b) => b.pr_url && b.status === 'implemented').map((b) => b.pr_url)).size;
  return (
    <>
      <div className="run-head">
        <div className="label">
          <Link to="/">Dashboard</Link> / Learning loop
        </div>
        <h1 className="page-title">Improvements</h1>
        <p className="muted" style={{ maxWidth: 760, margin: '6px 0 0' }}>
          After each triaged run, a retrospective agent proposes what the agents should learn. Nothing changes until you approve it here, one item at a time. Rejected ideas are remembered and not proposed again.
        </p>
      </div>
      <div className="stats" style={{ marginTop: 20 }}>
        <Stat n={data.pending} label="Waiting for review" />
        <Stat n={approved} label="Approved" />
        <Stat n={data.rejected} label="Rejected" sub="remembered" />
        <Stat n={openBacklog} label="Backlog" sub="code changes to implement" />
        <Stat n={data.priors.length} label="Strategy priors" />
        <Stat n={data.bench.length ? pct(data.bench[data.bench.length - 1].best_recall) : '—'} label="Bench recall" sub={regressed ? 'a version lowered recall' : 'latest agent version'} color={regressed ? 'var(--err)' : undefined} />
      </div>
      <div style={{ marginTop: 20 }}>
        <Tabs<Tab>
          tabs={[
            { id: 'pending', label: `Pending (${data.pending})` },
            { id: 'backlog', label: `Backlog (${data.backlog.length})` },
            { id: 'prs', label: `Pull requests${prOpen ? ` (${prOpen} open)` : ''}` },
            { id: 'knowledge', label: 'Approved knowledge' },
            { id: 'bench', label: 'Benchmark gate' },
            { id: 'history', label: 'History' },
          ]}
          value={tab}
          onChange={(t) => setParams(t === 'pending' ? {} : { tab: t }, { replace: true })}
        />
      </div>
      <div style={{ marginTop: 20 }}>
        {tab === 'pending' && <Pending runs={data.runs} reload={reload} />}
        {tab === 'backlog' && <Backlog items={data.backlog} runs={data.runs} reload={reload} />}
        {tab === 'prs' && <ImprovementPrList onChanged={reload} />}
        {tab === 'knowledge' && <Knowledge data={data} />}
        {tab === 'bench' && <Bench data={data} />}
        {tab === 'history' && <History rows={all.filter(({ p }) => p.status !== 'pending')} />}
      </div>
    </>
  );
}

function Pending({ runs, reload }: { runs: RunGroup[]; reload: () => void }) {
  const groups = runs.map((r) => ({ ...r, pending: r.proposals.filter((p) => p.status === 'pending') })).filter((r) => r.pending.length || (r.retro && !r.retro.ok));
  if (!groups.length)
    return (
      <div className="empty">
        Nothing to review. Retrospectives run after triage (turn this off per preset), or start one from a run page with <b>Run retrospective</b>.
      </div>
    );
  return (
    <div className="stack" style={{ ['--gap' as string]: '28px' }}>
      {groups.map((g) => (
        <section key={`${g.ws}/${g.run}`} className="stack" style={{ ['--gap' as string]: '12px' }}>
          <div className="spread" style={{ alignItems: 'baseline' }}>
            <div>
              <div className="label">
                {targetName(g.target)} · {g.retro ? `retrospective ${ago(g.retro.at)}` : 'lead notes'}
              </div>
              <h2 className="display h3" style={{ margin: '2px 0 0' }}>
                <Link to={`/runs/${g.ws}/${encodeURIComponent(g.run)}`}>{g.name ?? g.run}</Link>
              </h2>
            </div>
            <Chip>{g.pending.length} pending</Chip>
          </div>
          {g.retro?.summary && (
            <p className="muted" style={{ margin: 0, maxWidth: 900 }}>
              {g.retro.summary}
            </p>
          )}
          {g.retro && !g.retro.ok && (
            <div className="empty" style={{ color: 'var(--err)' }}>
              Retrospective failed: {g.retro.error}
            </div>
          )}
          {g.pending.map((p) => (
            <ProposalCard key={p.id} p={p} ws={g.ws} reload={reload} />
          ))}
        </section>
      ))}
    </div>
  );
}

function ProposalCard({ p, ws, reload }: { p: Proposal; ws: string; reload: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
  const [title, setTitle] = useState(p.title);
  const [body, setBody] = useState(p.body);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (action: 'approve' | 'reject', extra: Record<string, string> = {}) => {
    setBusy(true);
    try {
      const r = await api<{ applied: string }>(`/improvements/${ws}/${encodeURIComponent(p.run)}/${p.id}`, { json: { action, ...extra } });
      toast(r.applied);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="box proposal" aria-labelledby={`${p.id}-t`}>
      <div className="box-head">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="mono small">{p.id}</span>
          <Chip tone="ink">{KIND_LABEL[p.kind]}</Chip>
          {p.scope === 'general' && <Chip tone="outline">general</Chip>}
          <Chip tone="outline">{p.source === 'lead' ? 'from the lead' : p.source === 'report' ? 'from your report' : 'retrospective'}</Chip>
        </div>
      </div>
      <div className="box-body stack" style={{ ['--gap' as string]: '10px' }}>
        {mode === 'edit' ? (
          <>
            <label className="field">
              <span className="label">Title</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Text</span>
              <textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <h3 id={`${p.id}-t`} className="proposal-title">
              {p.title}
            </h3>
            <p style={{ margin: 0 }}>{p.body}</p>
          </>
        )}
        {p.prior && (
          <dl className="kv">
            <dt>Strategy</dt>
            <dd className="mono small">
              {p.prior.effect === 'prefer' ? 'prefer' : 'avoid'} {p.prior.strategy}
            </dd>
            {p.prior.persona && (
              <>
                <dt>Persona</dt>
                <dd>{p.prior.persona}</dd>
              </>
            )}
            {p.prior.page_kind && (
              <>
                <dt>Pages</dt>
                <dd>{p.prior.page_kind}</dd>
              </>
            )}
          </dl>
        )}
        {p.detector && (
          <div className="small">
            <span className="label">Detector for</span> <span className="mono">{p.detector.finding_type}</span>
            <p style={{ margin: '4px 0 0' }}>{p.detector.sketch}</p>
          </div>
        )}
        {p.tweak && (
          <div className="small">
            <span className="label">Change to {p.tweak.target}</span>
            <p style={{ margin: '4px 0 0' }}>{p.tweak.change}</p>
          </div>
        )}
        <Evidence p={p} ws={ws} />
        <p className="small muted" style={{ margin: 0 }}>
          {APPROVE_EFFECT[p.kind]}
        </p>
        {mode === 'reject' && (
          <label className="field">
            <span className="label">Why not? (optional, kept with the decision)</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. too costly, wrong for this site" autoFocus />
          </label>
        )}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {mode === 'view' && (
            <>
              <Chamfer tone="green" small disabled={busy} onClick={() => send('approve')}>
                Approve
              </Chamfer>
              <button className="btn-ghost" disabled={busy} onClick={() => setMode('edit')}>
                Edit
              </button>
              <button className="btn-ghost" disabled={busy} onClick={() => setMode('reject')}>
                Reject
              </button>
            </>
          )}
          {mode === 'edit' && (
            <>
              <Chamfer tone="green" small disabled={busy || !title.trim() || !body.trim()} onClick={() => send('approve', { title, body })}>
                Save and approve
              </Chamfer>
              <button className="btn-ghost" onClick={() => (setMode('view'), setTitle(p.title), setBody(p.body))}>
                Cancel
              </button>
            </>
          )}
          {mode === 'reject' && (
            <>
              <Chamfer tone="danger" small disabled={busy} onClick={() => send('reject', note.trim() ? { note } : {})}>
                Reject
              </Chamfer>
              <button className="btn-ghost" onClick={() => setMode('view')}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function Evidence({ p, ws }: { p: Proposal; ws: string }) {
  const e = p.evidence;
  if (!e.finding_ids.length && !e.numbers.length && !e.transcripts.length) return null;
  return (
    <details className="evidence">
      <summary className="label">Evidence</summary>
      <div className="stack small" style={{ ['--gap' as string]: '6px', marginTop: 8 }}>
        {e.numbers.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {e.numbers.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {e.finding_ids.length > 0 && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {e.finding_ids.map((id) =>
              /^BB-\d+$/.test(id) ? (
                <Link key={id} to={`/runs/${ws}/${encodeURIComponent(p.run)}/bugs/${id}`} className="mono">
                  {id}
                </Link>
              ) : (
                <span key={id} className="mono">
                  {id}
                </span>
              ),
            )}
          </div>
        )}
        {e.transcripts.length > 0 && (
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {e.transcripts.map((t) => (
              <a key={t} className="mono" href={fileUrl(ws, p.run, t)} target="_blank" rel="noreferrer">
                {t}
              </a>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

const STATUS_TONE: Record<BacklogItem['status'], string> = { open: 'outline', implementing: 'green live', implemented: 'mint', merged: 'mint', failed: 'sev-critical dot', closed: 'outline' };

function Backlog({ items, runs, reload }: { items: BacklogItem[]; runs: RunGroup[]; reload: () => void }) {
  const [impl, setImpl] = useState<{ ws: string; ids: string[]; all: boolean } | null>(null);
  const [sel, setSel] = useState<string[]>([]); // "ws/id"
  if (!items.length) return <div className="empty">The backlog is empty. Approved detector suggestions and prompt/config tweaks land here.</div>;
  const open = items.filter((b) => b.status === 'open' || b.status === 'failed');
  const openByWs = new Map<string, BacklogItem[]>();
  for (const b of open) openByWs.set(b.ws, [...(openByWs.get(b.ws) ?? []), b]);
  const selected = sel.map((k) => items.find((b) => `${b.ws}/${b.id}` === k)).filter(Boolean) as BacklogItem[];
  const selWs = [...new Set(selected.map((b) => b.ws))];
  const toggle = (b: BacklogItem, on: boolean) => setSel((cur) => (on ? [...cur, `${b.ws}/${b.id}`] : cur.filter((k) => k !== `${b.ws}/${b.id}`)));
  return (
    <>
      {open.length > 0 && (
        <div className="backlog-bar">
          <span className="small muted">Implement several approved items at once: parallel agents, one branch each, every item checked by typecheck and tests, then merged into main unless something gets in the way.</span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Chamfer small tone="green" disabled={!selected.length || selWs.length > 1} onClick={() => setImpl({ ws: selWs[0], ids: selected.map((b) => b.id), all: false })}>
              Implement selected ({selected.length})
            </Chamfer>
            {[...openByWs.entries()].map(([ws, list]) => (
              <button key={ws} className="btn-ghost" onClick={() => setImpl({ ws, ids: list.map((b) => b.id), all: true })}>
                Implement all open ({list.length}){openByWs.size > 1 ? ` · ${targetName(runs.find((r) => r.ws === ws)?.target ?? ws)}` : ''}
              </button>
            ))}
          </div>
          {selWs.length > 1 && (
            <span className="small" style={{ color: 'var(--warn)' }}>
              Selected items belong to different projects; implement one project's items at a time.
            </span>
          )}
        </div>
      )}
      {[...new Set(items.map((b) => b.ws))].map((ws) => {
        const wsItems = items.filter((b) => b.ws === ws);
        const label = targetName(runs.find((r) => r.ws === ws)?.target ?? ws);
        return (
          <section key={ws} className="stack" style={{ ['--gap' as string]: '14px', marginBottom: 24 }}>
            {new Set(items.map((b) => b.ws)).size > 1 && (
              <h2 className="display h3" style={{ margin: 0 }}>
                {label}
              </h2>
            )}
            {[...wsItems].reverse().map((b) => {
              const pickable = b.status === 'open' || b.status === 'failed';
              return (
                <article key={`${b.ws}/${b.id}`} className={`box ${sel.includes(`${b.ws}/${b.id}`) ? 'selected' : ''}`}>
                  <div className="box-head">
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      {pickable && <input type="checkbox" checked={sel.includes(`${b.ws}/${b.id}`)} onChange={(e) => toggle(b, e.target.checked)} aria-label={`Select ${b.id}`} style={{ accentColor: 'var(--ink)' }} />}
                      <span className="mono small">{b.id}</span>
                      <Chip tone="ink">{KIND_LABEL[b.kind]}</Chip>
                      <Chip tone={STATUS_TONE[b.status]}>{b.status}</Chip>
                    </div>
                    <span className="small muted">from {b.proposal_id}</span>
                  </div>
                  <div className="box-body stack" style={{ ['--gap' as string]: '8px' }}>
                    <h3 className="proposal-title">{b.title}</h3>
                    <p style={{ margin: 0 }}>{b.body}</p>
                    {(b.detector || b.tweak) && (
                      <p className="small muted" style={{ margin: 0 }}>
                        {b.detector ? `${b.detector.finding_type}: ${b.detector.sketch}` : `${b.tweak!.target}: ${b.tweak!.change}`}
                      </p>
                    )}
                    {b.branch && (
                      <div className="small">
                        Branch <span className="mono">{b.branch}</span>
                        {b.pr_url && (
                          <>
                            {' · '}
                            <a href={b.pr_url} target="_blank" rel="noreferrer">
                              pull request
                            </a>
                          </>
                        )}
                        {b.job_id && (
                          <>
                            {' · '}
                            <Link to={`/jobs/${b.job_id}`}>job</Link>
                          </>
                        )}
                      </div>
                    )}
                    {b.error && (
                      <div className="small" style={{ color: 'var(--err)' }}>
                        {b.error}
                      </div>
                    )}
                    {pickable && (
                      <div>
                        <Chamfer small onClick={() => setImpl({ ws: b.ws, ids: [b.id], all: false })}>
                          {b.status === 'failed' ? 'Try again' : 'Implement'}
                        </Chamfer>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        );
      })}
      {impl && (
        <ImplementDialog
          ws={impl.ws}
          items={items.filter((b) => b.ws === impl.ws && impl.ids.includes(b.id))}
          all={impl.all}
          onClose={() => setImpl(null)}
          onStarted={() => {
            setSel([]);
            reload();
          }}
        />
      )}
    </>
  );
}

type Landing = 'merge' | 'branch' | 'pr';

function ImplementDialog({ ws, items, all, onClose, onStarted }: { ws: string; items: BacklogItem[]; all: boolean; onClose: () => void; onStarted: () => void }) {
  const many = items.length > 1;
  const [landing, setLanding] = useState<Landing>('merge');
  const [parallel, setParallel] = useState(Math.min(3, Math.max(1, items.length)));
  const [confirmPush, setConfirmPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  const start = async () => {
    setBusy(true);
    try {
      const land = { pr: landing === 'pr', merge: landing === 'merge', confirmPush: landing === 'pr' ? confirmPush : undefined };
      const job = await api<JobView>(`/backlog/${ws}/implement`, { json: { ...(all ? { all: true } : { ids: items.map((b) => b.id) }), ...land, parallel: many ? parallel : 1 } });
      toast(many ? `Implementing ${items.length} items with ${parallel} agent${parallel > 1 ? 's' : ''}` : 'Implementation started');
      onStarted();
      nav(`/jobs/${job.id}`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  const landings: { id: Landing; label: string; help: string }[] = [
    { id: 'merge', label: 'Merge into main automatically', help: 'Each item that passes is rebased onto the latest main (the agent resolves conflicts with items merged before it), checked again, and merged. If anything gets in the way, it stays on its branch with the reason. Nothing is pushed.' },
    { id: 'branch', label: 'Leave each on its own branch', help: 'Nothing is merged; review and merge the improve/… branches yourself.' },
    { id: 'pr', label: 'Open a pull request for each', help: 'Pushes each passing branch to GitHub and opens a PR (see the Pull requests tab).' },
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      title={many ? `Implement ${items.length} items` : `Implement ${items[0]?.id ?? ''}`}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <Chamfer tone="green" onClick={start} disabled={busy || (landing === 'pr' && !confirmPush) || !items.length}>
            {busy ? 'Starting…' : landing === 'merge' ? 'Implement and merge' : landing === 'pr' ? 'Implement and open PRs' : 'Implement on branches'}
          </Chamfer>
        </>
      }
    >
      <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
        {items.map((b) => (
          <li key={b.id}>
            <span className="mono">{b.id}</span> {b.title}
          </li>
        ))}
      </ol>
      <p className="small muted" style={{ margin: 0 }}>
        Each item gets its own agent, branch and worktree of the bugbash repo. After the agent finishes, typecheck and tests run (failures go back to it once); an item that passes is committed, one that still fails is dropped and marked failed.
      </p>
      {many && (
        <label className="field">
          <span className="label">Agents at the same time</span>
          <select className="select" value={parallel} onChange={(e) => setParallel(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6].filter((n) => n <= items.length).map((n) => (
              <option key={n} value={n}>
                {n === 1 ? '1 (one after another)' : `${n} in parallel`}
              </option>
            ))}
          </select>
          <span className="small muted">More agents finish sooner but use more of your Claude usage and run several test suites at once.</span>
        </label>
      )}
      <fieldset className="stack" style={{ ['--gap' as string]: '8px', border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 6 }}>
          When an item passes
        </legend>
        {landings.map((l) => (
          <label key={l.id} className="check">
            <input type="radio" name="landing" checked={landing === l.id} onChange={() => setLanding(l.id)} />{' '}
            <span>
              {l.label}
              {landing === l.id && (
                <span className="small muted" style={{ display: 'block' }}>
                  {l.help}
                </span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      {landing === 'pr' && (
        <label className="check" style={{ color: 'var(--sev-major)', paddingLeft: 24 }}>
          <input type="checkbox" checked={confirmPush} onChange={(e) => setConfirmPush(e.target.checked)} /> <span>I understand this pushes to GitHub</span>
        </label>
      )}
    </Dialog>
  );
}

function Knowledge({ data }: { data: Overview }) {
  return (
    <div className="dash-grid">
      <div className="span-2 box">
        <div className="box-head">
          <div className="path">Lessons the agents read</div>
        </div>
        <div className="box-body">
          {data.lessons.length ? (
            data.lessons.map((l) => (
              <div key={l.ws}>
                <div className="label small">{l.path}/memory/lessons.md</div>
                <pre className="lessons">{l.text.trim()}</pre>
              </div>
            ))
          ) : (
            <p className="muted small">No lessons yet.</p>
          )}
        </div>
      </div>
      <div className="box">
        <div className="box-head">
          <div className="path">Strategy priors</div>
        </div>
        <div className="box-body">
          {data.priors.length ? (
            <DataTable head={['Strategy', 'Effect', 'Where', 'Why']} rows={data.priors.map((p) => [<span className="mono small">{p.strategy}</span>, p.effect, [p.persona, p.page_kind].filter(Boolean).join(' · ') || 'everywhere', p.reason])} />
          ) : (
            <p className="muted small">No priors yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Bench({ data }: { data: Overview }) {
  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      <p className="muted" style={{ margin: 0, maxWidth: 820 }}>
        <span className="mono">bugbash bench</span> runs the agents on the seeded fixture (11 known bugs) and records which version of the agent code (<span className="mono">src/</span>) ran. A version whose best recall drops by at least one seeded
        bug against the previous version is flagged. Run the bench on an improvement branch before merging it.
      </p>
      {data.bench.length ? (
        <div className="box">
          <DataTable
            head={['Agent version', 'Commit', 'Bench runs', 'Best recall', 'Mean recall', 'Precision (last)', 'Gate']}
            rows={data.bench.map((v) => [
              <span className="mono small">{v.version}</span>,
              <span className="mono small">{v.commit ?? '—'}</span>,
              v.runs.length,
              pct(v.best_recall),
              pct(v.mean_recall),
              pct(v.runs[v.runs.length - 1]?.precision),
              v.regression ? (
                <Chip tone="sev-critical dot">
                  recall −{Math.round(v.regression.drop * 100)} pts vs {v.regression.from}
                </Chip>
              ) : (
                <Chip tone="outline">ok</Chip>
              ),
            ])}
          />
        </div>
      ) : (
        <div className="empty">No benchmark runs yet.</div>
      )}
    </div>
  );
}

function History({ rows }: { rows: { p: Proposal; r: RunGroup }[] }) {
  if (!rows.length) return <div className="empty">No decisions yet.</div>;
  return (
    <div className="box">
      <DataTable
        head={['Decided', 'Proposal', 'Kind', 'Decision', 'Note']}
        rows={[...rows]
          .sort((a, b) => String(b.p.decided_at).localeCompare(String(a.p.decided_at)))
          .map(({ p }) => [
            <span className="small">{ago(p.decided_at)}</span>,
            <span>
              <span className="mono small">{p.id}</span> {p.title}
              {p.edited ? <span className="small muted"> (edited)</span> : null}
            </span>,
            KIND_LABEL[p.kind],
            p.status === 'approved' ? <Chip tone="mint">approved</Chip> : <Chip tone="outline">rejected</Chip>,
            <span className="small muted">{p.decision_note ?? ''}</span>,
          ])}
      />
    </div>
  );
}

export function RetroButton({ ws, run, triaged }: { ws: string; run: string; triaged: boolean }) {
  const toast = useToast();
  const nav = useNavigate();
  return (
    <button
      className="btn-ghost"
      disabled={!triaged}
      title={triaged ? 'Post-mortem this run: propose lessons and improvements for you to review' : 'Triage the run first'}
      onClick={async () => {
        try {
          const job = await api<JobView>(`/runs/${ws}/${encodeURIComponent(run)}/retro`, { json: {} });
          toast('Retrospective started');
          nav(`/jobs/${job.id}`);
        } catch (e) {
          toast((e as Error).message, true);
        }
      }}
    >
      Run retrospective
    </button>
  );
}
