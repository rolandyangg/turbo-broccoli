import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, useApi } from '../lib/api.ts';
import type { JobView } from '../lib/types.ts';
import { Chamfer, Dialog, useToast } from './ui.tsx';

/** Fix options + confirmation. Opening a PR requires ticking an explicit "push to GitHub" confirmation. */
export function FixDialog({ open, onClose, ws, run, ids, title, onStarted }: { open: boolean; onClose: () => void; ws: string; run: string; ids: string[]; title: string; onStarted?: (job: JobView) => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [pr, setPr] = useState(false);
  const [draft, setDraft] = useState(true);
  const [confirmPush, setConfirmPush] = useState(false);
  const [base, setBase] = useState('');
  const [attempts, setAttempts] = useState(3);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const job = await api<JobView>(`/runs/${ws}/${encodeURIComponent(run)}/fix`, { json: { ids, pr, draft, base: base.trim() || undefined, maxAttempts: attempts, keepWorktree: keep, confirmPush: pr ? confirmPush : undefined } });
      toast(`Fix job started for ${ids.join(', ')}`);
      onClose();
      if (onStarted) onStarted(job);
      else nav(`/jobs/${job.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Fix ${ids.join(', ')}`}
      footer={
        <>
          <button className="btn-link" onClick={onClose}>
            Cancel
          </button>
          <Chamfer tone="green" onClick={start} disabled={busy || (pr && !confirmPush)}>
            {busy ? 'Starting…' : pr ? 'Fix + open PR' : 'Start fix'}
          </Chamfer>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        <strong>{title}</strong>
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        The agent creates a new branch in a separate git worktree, edits the code, re-runs the repro checks at every affected browser and width, looks for regressions, and commits. Your working copy stays untouched.
      </p>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field">
          <span className="label">Base branch</span>
          <input className="input" placeholder="current branch" value={base} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Max attempts</span>
          <select className="select" value={attempts} onChange={(e) => setAttempts(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep the worktree afterwards (to inspect or run it)
      </label>
      <hr className="divider" style={{ margin: '4px 0' }} />
      <label className="check">
        <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} /> Push the branch and open a GitHub pull request
      </label>
      {pr && (
        <div className="stack" style={{ ['--gap' as string]: '8px', paddingLeft: 24 }}>
          <label className="check">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Open as draft
          </label>
          <label className="check" style={{ color: 'var(--sev-major)' }}>
            <input type="checkbox" checked={confirmPush} onChange={(e) => setConfirmPush(e.target.checked)} /> <span>I understand this pushes to <code>origin</code> and creates a PR visible to collaborators</span>
          </label>
          <PrPicturesNote />
        </div>
      )}
    </Dialog>
  );
}

export function LabelControls({ ws, run, id, status, groups, currentGroup, onChanged }: { ws: string; run: string; id: string; status: string; groups: { id: string; summary: string }[]; currentGroup: string; onChanged: () => void }) {
  const toast = useToast();
  const [fpOpen, setFpOpen] = useState(false);
  const [note, setNote] = useState('');
  const [scope, setScope] = useState('element');
  const [moveTo, setMoveTo] = useState('');
  const base = `/runs/${ws}/${encodeURIComponent(run)}`;
  const label = async (st: string, extra: Record<string, unknown> = {}) => {
    try {
      await api(`${base}/label`, { json: { id, status: st, ...extra } });
      toast(`${id} marked ${st.replace('_', ' ')}`);
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack" style={{ ['--gap' as string]: '10px' }}>
      <div className="row" style={{ gap: 6 }}>
        <button className={`btn-ghost ${status === 'confirmed' ? 'on' : ''}`} onClick={() => label('confirmed')}>
          Confirm bug
        </button>
        <button className={`btn-ghost ${status === 'false_positive' ? 'on' : ''}`} onClick={() => setFpOpen(true)}>
          False positive…
        </button>
        {['low_confidence', 'suppressed', 'false_positive'].includes(status) && (
          <button className="btn-ghost" onClick={() => label('new')}>
            Restore
          </button>
        )}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <select className="select" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move to group" style={{ maxWidth: 260, padding: '5px 8px', fontSize: 13 }}>
          <option value="">Move to group…</option>
          {groups
            .filter((g) => g.id !== currentGroup)
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.id} — {g.summary.slice(0, 60)}
              </option>
            ))}
          <option value="new">New group (split out)</option>
        </select>
        <button
          className="btn-ghost"
          disabled={!moveTo}
          onClick={async () => {
            try {
              await api(`${base}/regroup`, { json: { id, group: moveTo } });
              toast(`${id} moved to ${moveTo === 'new' ? 'a new group' : moveTo}`);
              setMoveTo('');
              onChanged();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Move
        </button>
      </div>
      <Dialog
        open={fpOpen}
        onClose={() => setFpOpen(false)}
        title={`Mark ${id} as a false positive`}
        footer={
          <Chamfer
            small
            onClick={async () => {
              await label('false_positive', { note: note || undefined, patternScope: scope, pattern: scope !== 'none' });
              setFpOpen(false);
            }}
          >
            Save label
          </Chamfer>
        }
      >
        <label className="field">
          <span className="label">Why? (kept in memory)</span>
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. intentional truncation with tooltip" />
        </label>
        <label className="field">
          <span className="label">Suppress similar findings in future runs</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="element">This element on this page</option>
            <option value="component">This component on every page</option>
            <option value="type-on-page">Any finding of this type on this page</option>
            <option value="none">Don't suppress (label only)</option>
          </select>
        </label>
      </Dialog>
    </div>
  );
}

/** Opens a real browser window with the bug's environment and replays it (runs on this machine). */
export function ReproduceDialog({ open, onClose, ws, run, id, env, onStarted }: { open: boolean; onClose: () => void; ws: string; run: string; id: string; env: { browser: string; viewport: { width: number; height: number }; device: string | null }; onStarted: (job: JobView) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'full' | 'start'>('full');
  const [slow, setSlow] = useState(false);
  const [browser, setBrowser] = useState('');
  const [guardrails, setGuardrails] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reproduce ${id}`}
      footer={
        <>
          <button className="btn-link" onClick={onClose}>
            Cancel
          </button>
          <Chamfer
            tone="green"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const job = await api<JobView>(`/runs/${ws}/${encodeURIComponent(run)}/bugs/${id}/reproduce`, { json: { mode, slow, browser: browser || undefined, guardrails } });
                toast('Opening a browser window…');
                onStarted(job);
                onClose();
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Opening…' : 'Open reproduction window'}
          </Chamfer>
        </>
      }
    >
      <p className="small" style={{ margin: 0 }}>
        Opens a new <b>{browser || env.browser}</b> window on this machine {env.device ? <>emulating <b>{env.device}</b> (touch, mobile browser)</> : <>at <b>{env.viewport.width}×{env.viewport.height}</b></>} with the bug's settings, replays the steps with captions and highlights the bug. The window is then yours to click around in, and closing it ends the job.
      </p>
      <div className="field">
        <span className="label">What to open</span>
        <label className="check">
          <input type="radio" name="mode" checked={mode === 'full'} onChange={() => setMode('full')} /> Replay the steps up to the bug and highlight it
        </label>
        <label className="check">
          <input type="radio" name="mode" checked={mode === 'start'} onChange={() => setMode('start')} /> Just open the page in the bug's environment (follow the steps yourself)
        </label>
      </div>
      <div className="grid-2" style={{ gap: 12 }}>
        <label className="field">
          <span className="label">Browser</span>
          <select className="select" value={browser} onChange={(e) => setBrowser(e.target.value)}>
            <option value="">As found ({env.browser})</option>
            <option value="chromium">chromium</option>
            <option value="webkit">webkit (Safari)</option>
            <option value="firefox">firefox</option>
          </select>
        </label>
        <div className="field">
          <span className="label">Options</span>
          <label className="check">
            <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} /> Slow motion
          </label>
          <label className="check">
            <input type="checkbox" checked={guardrails} onChange={(e) => setGuardrails(e.target.checked)} /> Keep guardrails (block data-changing requests)
          </label>
        </div>
      </div>
    </Dialog>
  );
}

/** In PR dialogs: whether before/after pictures will be attached, with a one-click GitHub sign-in when they won't. */
export function PrPicturesNote() {
  const { data, reload } = useApi<{ login: string | null; connected: boolean; connecting: string | null }>('/github', { pollMs: 5000 });
  const toast = useToast();
  if (!data) return <p className="small muted" style={{ margin: 0 }}>Checking GitHub connection for PR pictures…</p>;
  if (data.connected)
    return (
      <p className="small muted" style={{ margin: 0 }}>
        Before/after pictures will be attached with GitHub's image hosting (as {data.login}); nothing is committed.
      </p>
    );
  return (
    <div className="small" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span className="muted">{data.connecting ? 'A GitHub sign-in window is open: finish signing in there.' : "No pictures: GitHub isn't connected (your gh login can push, but GitHub only accepts image uploads from a signed-in browser)."}</span>
      {!data.connecting && (
        <button
          className="btn-ghost"
          onClick={async () => {
            try {
              await api('/github/connect', { json: {} });
              toast('A browser window is opening: sign in to GitHub there');
              reload();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Connect GitHub
        </button>
      )}
    </div>
  );
}

export interface FixRunDefaults {
  pr?: boolean;
  draft?: boolean;
  base?: string | null;
  maxAttempts?: number;
}

/**
 * Start a fix job in continue mode (pick up `branch` where it stopped: re-verify, more attempts only if needed,
 * commit, then publish) or retry mode (start over on a fresh branch). Pushing always needs fresh confirmation.
 */
export function FixRunDialog({ ws, run, ids, mode, branch, defaults = {}, title, submitLabel, onClose }: { ws: string; run: string; ids: string[]; mode: 'continue' | 'retry'; branch?: string | null; defaults?: FixRunDefaults; title?: string; submitLabel?: string; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const opts = defaults;
  const [pr, setPr] = useState(!!opts.pr);
  const [confirmPush, setConfirmPush] = useState(false);
  const [attempts, setAttempts] = useState(Math.min(5, Math.max(1, opts.maxAttempts ?? 3)));
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const j = await api<JobView>(`/runs/${ws}/${encodeURIComponent(run)}/fix`, {
        json: { ids, mode, branch: mode === 'continue' ? (branch ?? undefined) : undefined, pr, draft: opts.draft !== false, base: opts.base ?? undefined, maxAttempts: attempts, confirmPush: pr ? confirmPush : undefined },
      });
      toast(mode === 'continue' ? 'Continuing the fix' : 'Retrying the fix');
      onClose();
      nav(`/jobs/${j.id}`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={title ?? (mode === 'continue' ? `Continue ${ids.join(', ')}` : `Retry ${ids.join(', ')}`)}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <Chamfer tone="green" onClick={start} disabled={busy || (pr && !confirmPush)}>
            {busy ? 'Starting…' : pr && submitLabel ? submitLabel : mode === 'continue' ? 'Continue' : 'Retry'}
          </Chamfer>
        </>
      }
    >
      <p className="small muted" style={{ margin: 0 }}>
        {mode === 'continue' ? (
          <>
            Picks up <span className="mono">{branch}</span> where it stopped: re-checks the bug on the branch as it is, brings the fix agent back only if it's still there, commits anything uncommitted, then publishes if you ask.
          </>
        ) : (
          <>Starts over from your base branch on a fresh branch{branch ? <> (the old <span className="mono">{branch}</span> is left as it is)</> : null}.</>
        )}
      </p>
      <label className="field">
        <span className="label">Max attempts{mode === 'continue' ? ' (if the bug is still there)' : ''}</span>
        <select className="select" value={attempts} onChange={(e) => setAttempts(Number(e.target.value))}>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} /> Push the branch and open a {opts.draft !== false ? 'draft ' : ''}pull request
      </label>
      {pr && (
        <label className="check" style={{ color: 'var(--sev-major)', paddingLeft: 24 }}>
          <input type="checkbox" checked={confirmPush} onChange={(e) => setConfirmPush(e.target.checked)} /> <span>I understand this pushes to <code>origin</code> and creates a PR visible to collaborators</span>
        </label>
      )}
      {pr && <PrPicturesNote />}
    </Dialog>
  );
}
