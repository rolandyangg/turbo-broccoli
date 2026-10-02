import { MarkdownDescription } from './MarkdownPreview.tsx';
import { BranchPanel } from './Jobs.tsx';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, useApi } from '../lib/api.ts';
import { ago, targetName } from '../lib/format.ts';
import { Box, Chamfer, Chip, Dialog, ErrorBox, Loading, SevChip, Stat } from './ui.tsx';

interface PrRow {
  url: string;
  repo: string;
  number: number | null;
  branch: string | null;
  run: { ws: string; run: string; name: string | null; target: string };
  bugs: { id: string; title: string; severity: string; status: string; side_effect: boolean; verified: boolean; flags: string[] }[];
  jobs: { id: string; state: string; started_at: string; verified: boolean | null }[];
  opened_at: string | null;
  status: {
    number: number;
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
    checks: { name: string; state: string }[];
  } | null;
  status_error: string | null;
}
interface PrData {
  prs: PrRow[];
  counts: { total: number; draft: number; open: number; merged: number; closed: number; unknown: number };
}

/** "open", "draft", "merged", "closed" with the matching chip tone (text always says the state). */
function stateOf(p: PrRow): { label: string; tone: string } {
  if (!p.status) return { label: 'unknown', tone: 'outline' };
  if (p.status.state === 'MERGED') return { label: 'merged', tone: 'mint' };
  if (p.status.state === 'CLOSED') return { label: 'closed', tone: 'outline' };
  return p.status.isDraft ? { label: 'draft', tone: 'ink' } : { label: 'open', tone: 'green' };
}

/** Pull requests opened by fixes, with live GitHub state and links to their bugs and jobs. Per run or across runs. */
export function PrList({ scope }: { scope: { ws: string; run: string } | null }) {
  const q = scope ? `/prs?ws=${scope.ws}&run=${encodeURIComponent(scope.run)}` : '/prs';
  const { data, error, reload } = useApi<PrData>(q, { pollMs: 60_000 });
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what="Checking pull requests on GitHub" />;
  const c = data.counts;
  if (!c.total)
    return (
      <div className="empty" style={{ marginTop: 20 }}>
        No pull requests yet{scope ? ' for this run' : ''}. Open one from a fixed bug's page (Open pull request…) or when starting a fix.
      </div>
    );
  return (
    <div className="stack" style={{ ['--gap' as string]: '18px', marginTop: 20 }}>
      <div className="stats">
        <Stat n={c.total} label="Pull requests" />
        <Stat n={c.open} label="Open" />
        <Stat n={c.draft} label="Draft" />
        <Stat n={c.merged} label="Merged" />
        <Stat n={c.closed} label="Closed" />
      </div>
      <div className="spread">
        <span className="small muted">Live state from GitHub (refreshed every minute).</span>
        <button className="btn-ghost" onClick={() => reload()}>
          Refresh
        </button>
      </div>
      <ul className="pr-list">
        {data.prs.map((p) => {
          const st = stateOf(p);
          const runHref = `/runs/${p.run.ws}/${encodeURIComponent(p.run.run)}`;
          const latest = p.jobs[0];
          return (
            <li key={p.url} className="box">
              <div className="pr-head">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Chip tone={st.tone}>{st.label}</Chip>
                  {p.bugs.some((b) => !b.verified) && <Chip tone="sev-major dot">not fully verified</Chip>}
                  <a href={p.url} target="_blank" rel="noreferrer" className="mono small">
                    {p.repo}#{p.number ?? '?'} ↗
                  </a>
                  {p.status?.reviewDecision && <Chip tone="outline">{p.status.reviewDecision.replace(/_/g, ' ').toLowerCase()}</Chip>}
                  {p.status?.checks.length ? (
                    <Chip tone={p.status.checks.some((x) => /FAIL|ERROR/.test(x.state)) ? 'sev-critical dot' : p.status.checks.every((x) => /SUCCESS|COMPLETED|NEUTRAL|SKIPPED/.test(x.state)) ? 'mint' : 'outline'}>
                      checks: {p.status.checks.some((x) => /FAIL|ERROR/.test(x.state)) ? 'failing' : p.status.checks.every((x) => /SUCCESS|COMPLETED|NEUTRAL|SKIPPED/.test(x.state)) ? 'passing' : 'running'}
                    </Chip>
                  ) : null}
                </div>
                <span className="small muted">
                  {p.status?.mergedAt ? `merged ${ago(p.status.mergedAt)}` : p.status?.closedAt ? `closed ${ago(p.status.closedAt)}` : p.opened_at ? `opened ${ago(p.opened_at)}` : ''}
                </span>
              </div>
              <a href={p.url} target="_blank" rel="noreferrer" className="pr-title">
                {p.status?.title ?? p.branch ?? p.url}
              </a>
              {p.status_error && <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>Couldn't read the PR from GitHub: {p.status_error}</p>}
              <div className="small muted">
                {p.branch && <span className="mono">{p.branch}</span>}
                {p.status && ` → ${p.status.baseRefName} · +${p.status.additions} −${p.status.deletions}`}
                {!scope && (
                  <>
                    {' · '}
                    <Link to={runHref}>{p.run.name ?? targetName(p.run.target)}</Link>
                  </>
                )}
              </div>
              <div className="pr-links">
                <div>
                  <span className="label">Bugs</span>
                  <ul>
                    {p.bugs.map((b) => (
                      <li key={b.id}>
                        <Link to={`${runHref}/bugs/${b.id}`} className="mono small">
                          {b.id}
                        </Link>{' '}
                        <SevChip sev={b.severity} /> <span className="small">{b.title}</span>
                        {b.side_effect && <span className="small muted"> (fixed as a side effect)</span>}
                        {!b.verified && <div className="small" style={{ color: 'var(--warn)' }}>⚠ {(b.flags[0] ?? 'not fully verified').replace(/^BB-\d+: /, '')}</div>}
                      </li>
                    ))}
                    {!p.bugs.length && <li className="small muted">—</li>}
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
                          {j.state}
                          {j.verified ? ', verified' : ''} · {ago(j.started_at)}
                        </span>
                      </li>
                    ))}
                    {!p.jobs.length && <li className="small muted">—</li>}
                  </ul>
                </div>
              </div>
              <UpdatePrBody p={p} onUpdated={reload} />
              {latest && latest.state === 'failed' && <p className="small muted" style={{ margin: 0 }}>The latest job on this branch failed; open it to Continue or Retry.</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function UpdatePrBody({ p, onUpdated }: { p: PrRow; onUpdated: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  const [manuallyVerified, setManuallyVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (p.status?.state !== 'OPEN') return null;
  async function update() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await api<{ images: number }>('/prs/body', { json: { ws: p.run.ws, run: p.run.run, url: p.url, manuallyVerified } });
      setMessage(`PR body updated with the latest saved verification and ${result.images} image(s).`);
      setConfirm(false);
      await onUpdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <div>
        <button
          className="btn-ghost"
          disabled={busy || p.jobs.some((j) => j.state === 'running')}
          onClick={() => { setManuallyVerified(false); setConfirm(true); }}
          title="Replaces the generated PR body with current changes and saved verification/screenshots. Manual edits to the body are replaced."
        >
          {busy ? 'Updating PR body…' : 'Update PR body'}
        </button>
      </div>
      <Dialog open={confirm} dismissible={!busy} onClose={() => { if (!busy) setConfirm(false); }} title="Update PR body?" footer={
        <>
          <button className="btn-link" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          <Chamfer small tone="green" disabled={busy || p.jobs.some((j) => j.state === 'running')} onClick={() => void update()}>{busy ? 'Updating…' : 'Update PR body'}</Chamfer>
        </>
      }>
        <p style={{ margin: 0 }}>Update <a href={p.url} target="_blank" rel="noreferrer">{p.repo}#{p.number ?? '?'}</a> with the latest saved verification, screenshots, and description of the published changes?</p>
        <p className="small muted" style={{ margin: 0 }}>This replaces the current PR body, including any manual edits. It does not push code changes.</p>
        <label className="check">
          <input type="checkbox" checked={manuallyVerified} disabled={busy} onChange={(e) => setManuallyVerified(e.target.checked)} />
          <span>I manually verified this fix. Add my confirmation to the PR’s Verification section.</span>
        </label>
        {error && <div role="alert"><ErrorBox error={error} /></div>}
      </Dialog>
      {message && <p className="small muted" role="status">{message}</p>}
      {error && <div role="alert"><ErrorBox error={error} /></div>}
    </div>
  );
}

/** Existing PR details belong beside the bug evidence, outside the action sidebar. */
export function BugPullRequest({ ws, run, id, url, body, branch, onUpdated }: { ws: string; run: string; id: string; url: string | null; body: string | null; branch: string | null; onUpdated: () => Promise<void> }) {
  const { data, error, reload } = useApi<PrData>(`/prs?ws=${encodeURIComponent(ws)}&run=${encodeURIComponent(run)}`, { pollMs: 60_000 });
  const p = data?.prs.find((p) => p.url === url || (!url && p.bugs.some((b) => b.id === id)));
  if (!p && !url) return null;
  const prBranch = p?.branch ?? branch;
  const content = (
    <div className="stack" style={{ ['--gap' as string]: '14px', marginBottom: 14 }}>
      {(error || p?.status_error) && <p className="small" role="status">Couldn't check GitHub status: {error ?? p?.status_error}</p>}
      {p && <UpdatePrBody key={p.url} p={p} onUpdated={async () => { await Promise.all([reload(), onUpdated()]); }} />}
      {body && <details><summary className="label" style={{ cursor: 'pointer' }}>Saved PR description</summary><MarkdownDescription text={body} /></details>}
    </div>
  );
  if (prBranch) return <BranchPanel ws={ws} run={run} branch={prBranch}>{content}</BranchPanel>;
  return (
    <Box head="Pull request" chip={<Chip tone={p ? stateOf(p).tone : 'outline'}>{p ? stateOf(p).label : 'checking status'}</Chip>}>
      <a href={p?.url ?? url!} target="_blank" rel="noreferrer" className="h3" style={{ overflowWrap: 'anywhere' }}>
        {p?.status?.title ?? 'View pull request'} ↗
      </a>
      {content}
    </Box>
  );
}
