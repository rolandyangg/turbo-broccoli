import { useState } from 'react';
import { api } from '../lib/api.ts';
import type { Finding } from '../lib/types.ts';
import { useToast } from './ui.tsx';

export type WfState = 'unsorted' | 'todo' | 'in_progress' | 'done';
export const WF_LABEL: Record<WfState, string> = { unsorted: 'Unsorted', todo: 'To do', in_progress: 'In progress', done: 'Done' };

/** Mirrors workflowStateOf() in the agent schema: the person's choice, else derived from fix progress. */
export function wfStateOf(f: Pick<Finding, 'status'> & { workflow?: Finding['workflow'] }): WfState {
  if (f.workflow?.state) return f.workflow.state;
  return f.status === 'fixed' ? 'done' : f.status === 'fixing' ? 'in_progress' : 'unsorted';
}
export const isArchived = (f: { workflow?: Finding['workflow'] }) => !!f.workflow?.archived;

/** Bulk-capable: set the board state and/or archive flag for findings in a run. */
export async function updateWorkflow(ws: string, run: string, ids: string[], patch: { state?: 'todo' | 'in_progress' | 'done' | null; archived?: boolean }) {
  return api<{ updated: { id: string }[] }>(`/runs/${ws}/${encodeURIComponent(run)}/workflow`, { json: { ids, ...patch } });
}

/**
 * To do / In progress / Done segmented control plus Archive. Clicking the active state again clears it (back to
 * unsorted). Done marks the bug fixed; moving it back restores its status.
 */
export function WorkflowControls({ ws, run, f, onChanged, compact }: { ws: string; run: string; f: Finding; onChanged: () => void; compact?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const state = wfStateOf(f);
  const archived = isArchived(f);
  const go = async (patch: Parameters<typeof updateWorkflow>[3], msg: string) => {
    setBusy(true);
    try {
      await updateWorkflow(ws, run, [f.id], patch);
      toast(msg);
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`wf ${compact ? 'compact' : ''}`}>
      <div className="wf-seg" role="group" aria-label={`Sort ${f.id}`}>
        {(['todo', 'in_progress', 'done'] as const).map((s) => (
          <button
            key={s}
            className={`wf-btn ${state === s ? 'on' : ''} ${s}`}
            aria-pressed={state === s}
            disabled={busy || archived}
            title={state === s ? `Click again to clear (${WF_LABEL[s]})` : s === 'done' ? 'Mark done (marks the bug fixed)' : `Move to ${WF_LABEL[s]}`}
            onClick={() => go({ state: state === s && f.workflow?.state === s ? null : s }, state === s && f.workflow?.state === s ? `${f.id} unsorted` : `${f.id} → ${WF_LABEL[s]}`)}
          >
            {WF_LABEL[s]}
          </button>
        ))}
      </div>
      <button className="btn-ghost wf-archive" disabled={busy} onClick={() => go({ archived: !archived }, archived ? `${f.id} restored from the archive` : `${f.id} archived`)}>
        {archived ? 'Unarchive' : 'Archive'}
      </button>
    </div>
  );
}
