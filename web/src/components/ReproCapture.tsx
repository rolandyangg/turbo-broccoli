import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, fileUrl } from '../lib/api.ts';
import type { JobView } from '../lib/types.ts';
import type { ReproCapture as Capture } from '../../../src/repro/capture.ts';

export function ReproCapture({ job, onSaved }: { job: JobView; onSaved?: () => void }) {
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const confirmTitle = useId();
  const confirmDescription = useId();
  const [request, setRequest] = useState<string | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!request || capture) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const poll = async () => {
      try {
        const result = await api<Capture | { error: string } | null>(`/jobs/${job.id}/captures/${request}`);
        if (cancelled) return;
        if (result && 'error' in result) throw new Error(result.error);
        if (result) { setCapture(result); setBusy(false); return; }
        if (Date.now() - started > 15_000) throw new Error('Screenshot timed out. Check that the reproduction window is open, then try again.');
        timer = setTimeout(() => void poll(), 300);
      } catch (e) {
        if (!cancelled) { setError((e as Error).message); setBusy(false); setRequest(null); }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [request, capture, job.id]);
  if (job.kind !== 'reproduce' || !job.branch || !job.run) return null;
  const take = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const result = await api<{ id: string }>(`/jobs/${job.id}/capture`, { json: {} });
      setCapture(null); setRequest(result.id);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const replace = async () => {
    confirmDialog.current?.close();
    setBusy(true); setError(null);
    try {
      await api(`/jobs/${job.id}/captures/${request}/replace-after`, { json: {} });
      setSaved(true); onSaved?.();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="stack" style={{ marginTop: 12 }}>
    <p className="small muted">Once the fixed version looks right, take a screenshot to use as the new after image. Preview it, then confirm to replace the current after screenshot.</p>
    <button type="button" className="btn-ghost" disabled={busy || !job.alive} onClick={() => void take()}>{busy && !capture ? 'Taking screenshot…' : 'Take screenshot'}</button>
    {capture && <>
      <img width={capture.viewport?.width} height={capture.viewport?.height} src={fileUrl(job.run.ws, job.run.run, capture.path)} alt="Screenshot of the current fixed-version reproduction" style={{ width: '100%', maxHeight: 420, objectFit: 'contain' }} />
      <p className="small muted">Use this as the after screenshot. Automatic verification results stay unchanged. Refresh the PR body separately to publish it.</p>
      <div className="row"><button type="button" className="btn-primary" disabled={busy || saved} onClick={() => confirmDialog.current?.showModal()}>{saved ? 'After screenshot replaced' : busy ? 'Saving…' : 'Replace after'}</button><button type="button" className="btn-ghost" disabled={busy} onClick={() => { setCapture(null); setRequest(null); setSaved(false); }}>Discard</button></div>
    </>}
    <dialog ref={confirmDialog} className="dialog box repro-capture-confirm" aria-labelledby={confirmTitle} aria-describedby={confirmDescription}>
      <div className="box-head"><h2 id={confirmTitle} className="path">Replace the after screenshot?</h2></div>
      <div id={confirmDescription} className="box-body stack">
        <p>Are you sure? This will replace the current after screenshot in comparisons and future PR evidence.</p>
        <p className="small muted">The original file will remain saved, but it will no longer be the selected after image. Automatic verification results will stay unchanged.</p>
      </div>
      <div className="row repro-capture-confirm-actions">
        <button type="button" className="btn-ghost" autoFocus onClick={() => confirmDialog.current?.close()}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !capture || saved} onClick={() => void replace()}>Yes, replace after</button>
      </div>
    </dialog>
    {saved && <p className="small" role="status">Saved. <Link to={`/runs/${job.run.ws}/${encodeURIComponent(job.run.run)}/bugs/${job.finding_ids[0]}`}>View updated evidence →</Link></p>}
    {error && <p className="small" role="alert" style={{ color: 'var(--err)' }}>{error}</p>}
  </div>;
}
