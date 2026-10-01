import { Link } from 'react-router';
import { useApi } from '../lib/api.ts';
import { ago, targetName } from '../lib/format.ts';
import { Chip, ErrorBox, Loading, SevChip, Stat } from './ui.tsx';

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
              {latest && latest.state === 'failed' && <p className="small muted" style={{ margin: 0 }}>The latest job on this branch failed; open it to Continue or Retry.</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
