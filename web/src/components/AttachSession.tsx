import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '../lib/api.ts';
import { Chamfer, CopyButton, ErrorBox, Loading } from './ui.tsx';

interface Attachment { branch: string; worktree: string; commands: string; can_launch: boolean }

export function AttachSession({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Chamfer onClick={() => setOpen(true)}>Attach to session</Chamfer>
    {open && <AttachDialog key={base} base={base} onClose={() => setOpen(false)} />}
  </>;
}

function AttachDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const { data, error } = useApi<Attachment>(`${base}/attach`);
  const [busy, setBusy] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function launch() {
    if (!data) return;
    setBusy(true);
    setLaunchError(null);
    try {
      await api(`${base}/attach`, { json: { commands: data.commands } });
      setLaunched(true);
    } catch (e) { setLaunchError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="dialog box attach-dialog" aria-label="Attach to session" aria-busy={busy} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="box-head"><div className="path">Attach to session</div><button autoFocus className="btn-link" disabled={busy} onClick={onClose}>Close</button></div>
    <div className="box-body stack" style={{ gap: 14 }}>
      <p style={{ margin: 0 }}>Open an interactive Claude session on this bug’s fix branch. Automated sessions are not saved for resuming; the new session starts with the bug evidence and previous transcripts as context.</p>
      {error ? <ErrorBox error={error} /> : !data ? <Loading /> : <>
        <div className="small">Branch: <code>{data.branch}</code><br />Checkout: <code style={{ overflowWrap: 'anywhere' }}>{data.worktree}</code></div>
        <p className="small muted" style={{ margin: 0 }}>These commands reuse the branch’s checkout or create a dedicated worktree. Requires Claude Code installed and signed in. Terminal opens on the machine running Bugbash.</p>
        <pre className="code" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 280 }}>{data.commands}</pre>
        <div className="row">
          <CopyButton text={data.commands} label="Copy commands" />
          <Chamfer tone="green" disabled={busy || launched || !data.can_launch} onClick={() => void launch()}>{launched ? 'Terminal opened' : 'Run commands in Terminal'}</Chamfer>
        </div>
        {!data.can_launch && <p className="small muted">Automatic terminal launch is available on macOS. Copy these commands into your terminal.</p>}
        {launched && <p className="small" role="status">Terminal received the commands. Check it for setup progress or errors, then interact with Claude there.</p>}
        {launchError && <div role="alert"><ErrorBox error={launchError} /></div>}
      </>}
    </div>
  </dialog>;
}
