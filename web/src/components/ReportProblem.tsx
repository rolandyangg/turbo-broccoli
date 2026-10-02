import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../lib/api.ts';
import type { BugReportView, JobView } from '../lib/types.ts';
import { ago } from '../lib/format.ts';
import { Chamfer, Chip, Dialog, useToast } from './ui.tsx';

const CATEGORIES: { id: string; label: string; hint: string }[] = [
  { id: 'not-a-bug', label: 'It isn’t a real bug', hint: 'e.g. intentional design, or it doesn’t happen for real users' },
  { id: 'missed', label: 'It missed something more important', hint: 'e.g. "the track cards cover the What we do section on iPad, but it only reported clipped text"' },
  { id: 'evidence', label: 'The picture or video is wrong', hint: 'e.g. it highlights the wrong thing, or shows mirrored text that isn’t the problem' },
  { id: 'classification', label: 'Wrong severity, type or grouping', hint: 'e.g. this is major, not minor' },
  { id: 'fix', label: 'The fix didn’t work or verification is wrong', hint: 'e.g. the after picture doesn’t show the change' },
  { id: 'other', label: 'Something else', hint: '' },
];

/** Report a problem with this finding; an agent investigates which stage went wrong and proposes improvements. */
export function ReportProblem({ ws, run, id, reports }: { ws: string; run: string; id: string; reports: BugReportView[] }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('missed');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ job: JobView }>(`/runs/${ws}/${encodeURIComponent(run)}/bugs/${id}/report`, { json: { category, text } });
      toast('Thanks — an agent is investigating');
      setOpen(false);
      nav(`/jobs/${r.job.id}`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  const cat = CATEGORIES.find((c) => c.id === category);
  return (
    <div className="stack" style={{ ['--gap' as string]: '8px' }}>
      <div>
        <button className="btn-ghost" onClick={() => setOpen(true)}>
          Report a problem with this bug…
        </button>
      </div>
      {reports.map((r) => (
        <div key={r.id} className="report-item">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <Chip tone={r.status === 'done' ? 'mint' : r.status === 'failed' ? 'sev-critical dot' : 'green live'}>{r.status === 'investigating' ? 'investigating' : r.status}</Chip>
            <span className="small muted">
              {CATEGORIES.find((c) => c.id === r.category)?.label ?? r.category} · {ago(r.at)}
            </span>
            {r.job_id && (
              <Link to={`/jobs/${r.job_id}`} className="small">
                job
              </Link>
            )}
          </div>
          {r.text && <p className="small" style={{ margin: '4px 0 0' }}>“{r.text}”</p>}
          {r.diagnosis && (
            <div className="small" style={{ marginTop: 6 }}>
              <b>Found ({r.diagnosis.stage}):</b> {r.diagnosis.summary}
              {r.diagnosis.recommended_action && (
                <div style={{ marginTop: 4 }}>
                  <b>Recommended:</b> {r.diagnosis.recommended_action}
                </div>
              )}
              {r.proposals.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <Link to="/improvements">{r.proposals.length} improvement proposal(s) waiting for your review →</Link>
                </div>
              )}
            </div>
          )}
          {r.error && <p className="small" style={{ margin: '4px 0 0', color: 'var(--err)' }}>{r.error}</p>}
        </div>
      ))}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Report a problem with ${id}`}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <Chamfer tone="green" onClick={send} disabled={busy}>
              {busy ? 'Sending…' : 'Send & investigate'}
            </Chamfer>
          </>
        }
      >
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">What’s wrong?</legend>
          <div className="stack" style={{ ['--gap' as string]: '4px' }}>
            {CATEGORIES.map((c) => (
              <label key={c.id} className="check">
                <input type="radio" name="report-cat" checked={category === c.id} onChange={() => setCategory(c.id)} /> <span>{c.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="label">Details</span>
          <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={cat?.hint || 'What did you expect, and what did bugbash do?'} />
        </label>
        <p className="small muted" style={{ margin: 0 }}>
          An agent reads this bug’s trail (explorer transcript, detector measurements, triage replays and review, screenshots, fix verification), works out which stage went wrong, and proposes improvements on the Improvements page. Nothing changes until you approve it.
        </p>
      </Dialog>
    </div>
  );
}
