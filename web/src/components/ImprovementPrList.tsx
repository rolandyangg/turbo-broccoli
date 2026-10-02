import { useState } from 'react';
import { Link } from 'react-router';
import { api, useApi } from '../lib/api.ts';
import { ago } from '../lib/format.ts';
import { Chamfer, Chip, Dialog, ErrorBox, Loading, Stat, useToast } from './ui.tsx';

interface ImprovementPr {
  url: string;
  repo: string;
  number: number | null;
  branch: string | null;
  items: { ws: string; id: string; title: string; kind: 'detector' | 'tweak'; status: string }[];
  jobs: { id: string; state: string; started_at: string; summary: string | null }[];
  status: {
    title: string;
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    isDraft: boolean;
    mergedAt: string | null;
    closedAt: string | null;
    updatedAt: string | null;
    reviewDecision: string | null;
    baseRefName: string;
    additions: number;
    deletions: number;
    commits: number;
    mergeable: string | null;
    mergeStateStatus: string | null;
    checks: { name: string; state: string }[];
  } | null;
  status_error: string | null;
  extra_commits: number;
  blocked: string | null;
}
interface Data {
  prs: ImprovementPr[];
  counts: { total: number; open: number; merged: number; closed: number };
}

function stateOf(p: ImprovementPr): { label: string; tone: string } {
  if (!p.status) return { label: 'unknown', tone: 'outline' };
  if (p.status.state === 'MERGED') return { label: 'merged', tone: 'mint' };
  if (p.status.state === 'CLOSED') return { label: 'closed', tone: 'outline' };
  return p.status.isDraft ? { label: 'draft', tone: 'ink' } : { label: 'open', tone: 'green' };
}

/** Pull requests from "Implement on a branch": the self-improvements of bugbash, with merge and close right here. */
export function ImprovementPrList({ onChanged }: { onChanged: () => void }) {
  const { data, error, reload } = useApi<Data>('/improvements/prs', { pollMs: 60_000 });
  const [merge, setMerge] = useState<ImprovementPr | null>(null);
  const [close, setClose] = useState<ImprovementPr | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what="Checking improvement pull requests on GitHub" />;
  const done = () => {
    reload();
    onChanged();
  };
  if (!data.counts.total) return <div className="empty">No improvement pull requests yet. On the Backlog tab, implement items on a branch with “Push the branch and open a GitHub pull request” ticked.</div>;
  return (
    <div className="stack" style={{ ['--gap' as string]: '18px' }}>
      <div className="stats">
        <Stat n={data.counts.total} label="Pull requests" />
        <Stat n={data.counts.open} label="Open" sub="waiting for you" />
        <Stat n={data.counts.merged} label="Merged" />
        <Stat n={data.counts.closed} label="Closed" />
      </div>
      <div className="spread">
        <span className="small muted">Changes to bugbash itself. Merging one changes how future runs behave, so review the diff on GitHub first. Live state from GitHub.</span>
        <button className="btn-ghost" onClick={() => api('/improvements/prs?fresh=1').then(done)}>
          Refresh
        </button>
      </div>
      <ul className="pr-list">
        {data.prs.map((p) => {
          const st = stateOf(p);
          const open = p.status?.state === 'OPEN';
          const failing = p.status?.checks.some((x) => /FAIL|ERROR/.test(x.state));
          return (
            <li key={p.url} className="box">
              <div className="pr-head">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Chip tone={st.tone}>{st.label}</Chip>
                  <a href={p.url} target="_blank" rel="noreferrer" className="mono small">
                    {p.repo}#{p.number ?? '?'} ↗
                  </a>
                  {open && p.status?.mergeable === 'CONFLICTING' && <Chip tone="sev-critical dot">conflicts</Chip>}
                  {open && p.status?.mergeable === 'MERGEABLE' && !p.blocked && <Chip tone="mint">ready to merge</Chip>}
                  {p.status?.checks.length ? <Chip tone={failing ? 'sev-critical dot' : 'outline'}>checks: {failing ? 'failing' : 'ok / running'}</Chip> : null}
                  {p.status?.reviewDecision && <Chip tone="outline">{p.status.reviewDecision.replace(/_/g, ' ').toLowerCase()}</Chip>}
                </div>
                <span className="small muted">{p.status?.mergedAt ? `merged ${ago(p.status.mergedAt)}` : p.status?.closedAt ? `closed ${ago(p.status.closedAt)}` : p.jobs[0] ? `opened ${ago(p.jobs[0].started_at)}` : ''}</span>
              </div>
              <a href={p.url} target="_blank" rel="noreferrer" className="pr-title">
                {p.status?.title ?? p.branch ?? p.url}
              </a>
              {p.status_error && <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>Couldn't read the PR from GitHub: {p.status_error}</p>}
              <div className="small muted">
                {p.branch && <span className="mono">{p.branch}</span>}
                {p.status && ` → ${p.status.baseRefName} · ${p.status.commits} commit${p.status.commits === 1 ? '' : 's'} · +${p.status.additions} −${p.status.deletions}`}
              </div>
              {open && p.extra_commits > 0 && (
                <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>
                  ⚠ {p.extra_commits} of its commits aren't improvement items (usually commits on your local {p.status?.baseRefName} that weren't on GitHub when the branch was pushed). Merging publishes them too.
                </p>
              )}
              <div className="pr-links">
                <div>
                  <span className="label">Backlog items</span>
                  <ul>
                    {p.items.map((it) => (
                      <li key={`${it.ws}/${it.id}`} className="small">
                        <span className="mono">{it.id}</span> {it.title} <span className="muted">· {it.status}</span>
                      </li>
                    ))}
                    {!p.items.length && <li className="small muted">—</li>}
                  </ul>
                </div>
                <div>
                  <span className="label">Jobs</span>
                  <ul>
                    {p.jobs.map((j) => (
                      <li key={j.id} className="small">
                        <Link to={`/jobs/${j.id}`} className="mono">
                          {j.id}
                        </Link>{' '}
                        <span className="muted">
                          {j.state} · {ago(j.started_at)}
                        </span>
                      </li>
                    ))}
                    {!p.jobs.length && <li className="small muted">—</li>}
                  </ul>
                </div>
              </div>
              {open && (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <a className="btn-ghost" href={`${p.url}/files`} target="_blank" rel="noreferrer">
                    Review the diff ↗
                  </a>
                  <Chamfer small tone="green" disabled={!!p.blocked} onClick={() => setMerge(p)}>
                    Merge…
                  </Chamfer>
                  <button className="btn-ghost" onClick={() => setClose(p)}>
                    Close without merging…
                  </button>
                  {p.blocked && <span className="small" style={{ color: 'var(--warn)' }}>Can't merge: {p.blocked}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {merge && <MergeDialog pr={merge} onClose={() => setMerge(null)} onDone={done} />}
      {close && <CloseDialog pr={close} onClose={() => setClose(null)} onDone={done} />}
    </div>
  );
}

function MergeDialog({ pr, onClose, onDone }: { pr: ImprovementPr; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>('merge');
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [extra, setExtra] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[] | null>(null);
  const toast = useToast();
  const draft = !!pr.status?.isDraft;
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ notes: string[] }>('/improvements/prs/merge', { json: { url: pr.url, method, deleteBranch, confirm, markReady: draft, allowExtraCommits: extra } });
      toast(`Merged ${pr.repo}#${pr.number}`);
      setNotes(r.notes);
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    }
    setBusy(false);
  };
  if (notes)
    return (
      <Dialog open onClose={onClose} title="Merged" footer={<Chamfer onClick={onClose}>Done</Chamfer>}>
        <p style={{ margin: 0 }}>
          {pr.items.map((i) => i.id).join(', ')} {pr.items.length === 1 ? 'is' : 'are'} merged into {pr.status?.baseRefName}.
        </p>
        {notes.length > 0 && (
          <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </Dialog>
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Merge ${pr.repo}#${pr.number ?? ''}`}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <Chamfer tone="green" onClick={go} disabled={busy || !confirm || (pr.extra_commits > 0 && !extra)}>
            {busy ? 'Merging…' : draft ? 'Mark ready & merge' : 'Merge'}
          </Chamfer>
        </>
      }
    >
      <p className="small" style={{ margin: 0 }}>
        Merges <span className="mono">{pr.branch}</span> into <span className="mono">{pr.status?.baseRefName}</span> on GitHub ({pr.status?.commits} commits, +{pr.status?.additions} −{pr.status?.deletions}). Future runs use these changes once you pull them.
      </p>
      <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
        {pr.items.map((b) => (
          <li key={b.id}>
            <span className="mono">{b.id}</span> {b.title}
          </li>
        ))}
      </ol>
      <label className="field">
        <span className="label">How</span>
        <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="merge">Merge commit (keeps one commit per item)</option>
          <option value="squash">Squash into one commit</option>
          <option value="rebase">Rebase onto {pr.status?.baseRefName}</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> <span>Then delete the branch (on GitHub and locally) and its worktree</span>
      </label>
      {draft && <p className="small muted" style={{ margin: 0 }}>It is a draft: it is marked ready for review first.</p>}
      {pr.extra_commits > 0 && (
        <label className="check" style={{ color: 'var(--sev-major)' }}>
          <input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} /> <span>Also merge its {pr.extra_commits} other commit(s) that aren't improvement items</span>
        </label>
      )}
      <label className="check" style={{ color: 'var(--sev-major)' }}>
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> <span>I reviewed the diff and want this merged on GitHub</span>
      </label>
    </Dialog>
  );
}

function CloseDialog({ pr, onClose, onDone }: { pr: ImprovementPr; onClose: () => void; onDone: () => void }) {
  const [comment, setComment] = useState('');
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const go = async () => {
    setBusy(true);
    try {
      await api('/improvements/prs/close', { json: { url: pr.url, comment: comment.trim() || undefined, deleteBranch } });
      toast(`Closed ${pr.repo}#${pr.number}; its items are open on the backlog again`);
      onDone();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Close ${pr.repo}#${pr.number ?? ''} without merging`}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <Chamfer tone="danger" onClick={go} disabled={busy}>
            {busy ? 'Closing…' : 'Close pull request'}
          </Chamfer>
        </>
      }
    >
      <p className="small muted" style={{ margin: 0 }}>
        {pr.items.map((i) => i.id).join(', ')} go back to open on the backlog, so you can implement them again.
      </p>
      <label className="field">
        <span className="label">Comment on GitHub (optional)</span>
        <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why it's being closed" />
      </label>
      <label className="check">
        <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> <span>Also delete the branch (on GitHub and locally) and its worktree</span>
      </label>
    </Dialog>
  );
}
