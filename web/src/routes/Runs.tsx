import { useState } from 'react';
import { Link } from 'react-router';
import { useApi, api } from '../lib/api.ts';
import type { RunSummary } from '../lib/types.ts';
import { ago, targetName } from '../lib/format.ts';
import { Arrow, Box, Chamfer, Chip, ErrorBox, FileIcon, Loading, Section, useToast } from '../components/ui.tsx';
import { LauncherDialog } from '../components/Launcher.tsx';
import { RunName } from '../components/RunName.tsx';

export function Runs() {
  const { data, error, reload } = useApi<RunSummary[]>('/runs', { pollMs: 8000 });
  const [launch, setLaunch] = useState(false);
  const [ws, setWs] = useState('');
  const toast = useToast();
  const byTarget = new Map<string, RunSummary[]>();
  for (const r of data ?? []) byTarget.set(r.target_key, [...(byTarget.get(r.target_key) ?? []), r]);
  return (
    <>
      <div className="run-head spread" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="label">
            <Link to="/">Dashboard</Link> / All runs
          </div>
          <h1 className="page-title">Runs</h1>
        </div>
        <div className="row">
          <Link className="btn-ghost" to="/compare">
            Compare runs
          </Link>
          <Chamfer small onClick={() => setLaunch(true)}>
            New bug bash
          </Chamfer>
        </div>
      </div>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Loading what="Loading runs" />}
      {data && !data.length && (
        <div className="empty" style={{ marginTop: 32 }}>
          <h2 className="display h2">No runs yet</h2>
          <p>
            Start one here, or from the CLI with <code>./bin/bugbash.js explore &lt;target&gt; --then-triage</code>. Runs from any workspace show up automatically.
          </p>
        </div>
      )}
      {[...byTarget.entries()].map(([target, runs]) => (
        <Section key={target} kicker={`${runs[0].target_kind} · ${runs.length} run${runs.length > 1 ? 's' : ''}`} title={targetName(target)} meta={<span className="mono small muted">{runs[0].repo_path ?? runs[0].base_url}</span>}>
          <div className="grid-auto">
            {runs.map((r) => (
              <RunCard key={r.ws + r.run} r={r} />
            ))}
          </div>
        </Section>
      ))}
      <div className="row" style={{ marginTop: 40, justifyContent: 'center' }}>
        <input className="input" placeholder="Add a workspace folder (…/.bugbash)" value={ws} onChange={(e) => setWs(e.target.value)} style={{ width: 380, maxWidth: '100%' }} />
        <button
          className="btn-ghost"
          onClick={async () => {
            try {
              await api('/workspaces', { json: { path: ws } });
              setWs('');
              toast('Workspace added');
              void reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Add
        </button>
      </div>
      <LauncherDialog open={launch} onClose={() => setLaunch(false)} />
    </>
  );
}

function RunCard({ r }: { r: RunSummary }) {
  const sev = r.counts.by_severity;
  const href = `/runs/${r.ws}/${encodeURIComponent(r.run)}`;
  return (
    <Box
      head={
        <>
          <FileIcon />
          <RunName ws={r.ws} run={r.run} name={r.name} fallback={r.run} />
        </>
      }
      chip={r.live ? <Chip tone="green live">live</Chip> : r.triaged ? <Chip>triaged</Chip> : <Chip tone="outline">not triaged</Chip>}
      foot={
        <>
          Open run <Arrow />
        </>
      }
      footHref={href}
    >
      <Link to={href} style={{ textDecoration: 'none' }}>
        <div className="run-stats">
          <div>
            <b>{r.counts.active}</b>
            <span className="label">active</span>
          </div>
          <div>
            <b>{sev.critical ?? 0}</b>
            <span className="label row" style={{ gap: 6 }}>
              <i className="stat-mark" style={{ background: 'var(--sev-critical)' }} />
              critical
            </span>
          </div>
          <div>
            <b>{sev.major ?? 0}</b>
            <span className="label row" style={{ gap: 6 }}>
              <i className="stat-mark" style={{ background: 'var(--sev-major)' }} />
              major
            </span>
          </div>
          <div>
            <b>{r.counts.groups}</b>
            <span className="label">groups</span>
          </div>
        </div>
        <p className="small muted" style={{ margin: '12px 0 0' }}>
          {r.name ? <span className="mono">{r.run} · </span> : null}
          {ago(r.started_at)} · {r.sessions} session{r.sessions === 1 ? '' : 's'} · {r.triaged ? `${r.counts.total} findings` : `${r.raw_findings} raw findings`}
          {r.counts.by_status.fixing ? ` · ${r.counts.by_status.fixing} being fixed` : ''}
        </p>
        {r.stop_reason && (
          <p className="small" style={{ margin: '6px 0 0', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {r.stop_reason}
          </p>
        )}
      </Link>
    </Box>
  );
}
