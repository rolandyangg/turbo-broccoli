import { useId, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { useToast } from './ui.tsx';
import './DeleteRun.css';

export function DeleteRun({ ws, run, name, live, onDeleted }: { ws: string; run: string; name?: string | null; live: boolean; onDeleted: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const toast = useToast();
  const remove = async () => {
    if (pending.current || live) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await api(`/runs/${ws}/${encodeURIComponent(run)}`, { method: 'DELETE', json: { confirm: true } });
      dialog.current?.close();
      toast('Run deleted');
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <>
    <button
      type="button"
      className="btn-ghost"
      style={{ color: 'var(--err)' }}
      disabled={live || busy}
      title={live ? 'Stop all active jobs for this run before deleting it' : `Delete ${name || run}`}
      onClick={() => { setError(null); dialog.current?.showModal(); }}
    >
      Delete run
    </button>
    {live && <span className="small muted">Stop active jobs before deleting.</span>}
    <dialog
      ref={dialog}
      className="dialog box delete-run-dialog"
      aria-labelledby={title}
      aria-describedby={description}
      aria-busy={busy}
      onCancel={(e) => { if (pending.current) e.preventDefault(); }}
    >
      <div className="box-head"><h2 id={title} className="path">Delete run?</h2></div>
      <div id={description} className="box-body stack">
        <p>Permanently delete <strong className="delete-run-name">{name || run}</strong>?</p>
        {name && <p className="small muted mono delete-run-name">{run}</p>}
        <p>All findings, screenshots, videos, transcripts, reports, and job history for this run will be deleted. This cannot be undone.</p>
        <p className="small muted">Shared workspace memory and source files will be kept.</p>
        {live && <p role="alert">Stop all active jobs for this run before deleting it.</p>}
        {error && <p role="alert" className="delete-run-error">{error}</p>}
      </div>
      <div className="row delete-run-actions">
        <button type="button" className="btn-ghost" autoFocus disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="chamfer danger small" disabled={busy || live} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
      </div>
    </dialog>
  </>;
}
