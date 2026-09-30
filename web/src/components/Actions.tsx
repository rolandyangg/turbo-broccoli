import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../lib/api.ts';
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
            <input type="checkbox" checked={confirmPush} onChange={(e) => setConfirmPush(e.target.checked)} /> I understand this pushes to <code>origin</code> and creates a PR visible to collaborators
          </label>
          <p className="small muted" style={{ margin: 0 }}>
            Before/after images are committed under <code>.bugbash/pr-assets/</code> in a separate commit so they render in the PR description.
          </p>
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

export function LauncherDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const [f, setF] = useState({ target: '', repo: '', browsers: ['chromium'] as string[], budgetSessions: 4, parallel: 2, maxCalls: 60, timeLimit: 45, noLead: false, codeIntel: true, thenTriage: true });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New bug bash"
      footer={
        <Chamfer
          tone="green"
          disabled={busy || !f.target.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const job = await api<JobView>('/explore', { json: { ...f, repo: f.repo.trim() || undefined } });
              toast('Bug bash started');
              onClose();
              nav(`/jobs/${job.id}`);
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Starting…' : 'Start bug bash'}
        </Chamfer>
      }
    >
      <label className="field">
        <span className="label">Target: URL, local folder, or repo</span>
        <input className="input" value={f.target} onChange={(e) => set('target', e.target.value)} placeholder="http://localhost:3000 or /path/to/app" autoFocus />
      </label>
      <label className="field">
        <span className="label">Source repo (optional, for URL targets)</span>
        <input className="input" value={f.repo} onChange={(e) => set('repo', e.target.value)} placeholder="/path/to/repo: enables code intel, source hints and fixing" />
      </label>
      <div className="field">
        <span className="label">Browsers</span>
        <div className="row">
          {['chromium', 'webkit', 'firefox'].map((b) => (
            <label key={b} className="check">
              <input type="checkbox" checked={f.browsers.includes(b)} onChange={(e) => set('browsers', e.target.checked ? [...f.browsers, b] : f.browsers.filter((x) => x !== b))} /> {b}
            </label>
          ))}
        </div>
      </div>
      <div className="grid-2" style={{ gap: 12 }}>
        {(
          [
            ['budgetSessions', 'Explorer sessions'],
            ['parallel', 'In parallel'],
            ['maxCalls', 'Tool calls / session'],
            ['timeLimit', 'Time limit (min)'],
          ] as const
        ).map(([k, l]) => (
          <label key={k} className="field">
            <span className="label">{l}</span>
            <input className="input" type="number" min={1} value={f[k]} onChange={(e) => set(k, Number(e.target.value))} />
          </label>
        ))}
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={!f.noLead} onChange={(e) => set('noLead', !e.target.checked)} /> Lead agent
        </label>
        <label className="check">
          <input type="checkbox" checked={f.codeIntel} onChange={(e) => set('codeIntel', e.target.checked)} /> Read source code
        </label>
        <label className="check">
          <input type="checkbox" checked={f.thenTriage} onChange={(e) => set('thenTriage', e.target.checked)} /> Triage afterwards
        </label>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Runs headless Claude agents under your Claude Code login. A 4-session run takes roughly 10–20 minutes including triage.
      </p>
    </Dialog>
  );
}
