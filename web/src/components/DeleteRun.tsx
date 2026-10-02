import { useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { useToast } from './ui.tsx';

export function DeleteRun({ ws, run, name, live, onDeleted }: { ws: string; run: string; name?: string | null; live: boolean; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const toast = useToast();
  return (
    <button
      className="btn-ghost"
      style={{ color: 'var(--err)' }}
      disabled={live || busy}
      title={live ? 'Stop all active jobs for this run before deleting it' : `Delete ${name || run}`}
      onClick={async () => {
        if (pending.current) return;
        if (!window.confirm(`Delete run "${name || run}"?\n\nYou will permanently lose all data and history associated with this run, including findings, screenshots, videos, transcripts, reports, and job history. This cannot be undone.\n\nShared workspace memory and source files will be kept.`)) return;
        pending.current = true;
        setBusy(true);
        try {
          await api(`/runs/${ws}/${encodeURIComponent(run)}`, { method: 'DELETE', json: { confirm: true } });
          toast('Run deleted');
          onDeleted();
        } catch (e) {
          toast((e as Error).message, true);
        } finally {
          pending.current = false;
          setBusy(false);
        }
      }}
    >
      {busy ? 'Deleting…' : 'Delete run'}
    </button>
  );
}
