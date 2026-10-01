import { readRun, readFindings, writeFindings, allFindings } from './store.js';
import { FindingStatus, type Finding } from './schema.js';
import { Memory } from '../memory/siteMemory.js';

export interface WorkflowPatch {
  /** null clears the person's choice (back to "unsorted"). */
  state?: 'todo' | 'in_progress' | 'done' | null;
  archived?: boolean;
}

/**
 * The person's own sorting of findings in a run: to do / in progress / done, and archive. Done marks the finding
 * fixed (so counts, the fix pipeline and regression tracking agree); moving it off done restores the status it had.
 * Archived findings stay in findings.json but leave the active lists and counts.
 */
export function setWorkflow(runDir: string, ids: string[], patch: WorkflowPatch): Finding[] {
  const ff = readFindings(runDir);
  if (!ff) throw new Error('Run has no findings.json (triage first)');
  const want = new Set(ids.map((x) => x.toUpperCase()));
  const hits = allFindings(ff).filter((f) => want.has(f.id));
  const missing = [...want].filter((id) => !hits.some((f) => f.id === id));
  if (missing.length) throw new Error(`Unknown finding(s): ${missing.join(', ')}`);
  const info = readRun(runDir);
  const memory = new Memory(info.workspace);
  const now = new Date().toISOString();
  for (const f of hits) {
    const w = f.workflow;
    if (patch.state !== undefined && patch.state !== w.state) {
      if (patch.state === 'done' && f.status !== 'fixed') {
        w.prev_status = f.status;
        f.status = 'fixed';
        memory.setBugStatus(f.fingerprint, 'fixed', info.run_id, f.id);
      } else if (w.state === 'done' && patch.state !== 'done' && f.status === 'fixed' && w.prev_status) {
        const back = FindingStatus.safeParse(w.prev_status);
        f.status = back.success ? back.data : 'new';
        w.prev_status = null;
        memory.setBugStatus(f.fingerprint, f.status, info.run_id, f.id);
      }
      w.state = patch.state;
    }
    if (patch.archived !== undefined && patch.archived !== w.archived) {
      w.archived = patch.archived;
      w.archived_at = patch.archived ? now : null;
    }
    w.updated_at = now;
  }
  writeFindings(runDir, { run_id: ff.run_id, target: ff.target, generated_at: ff.generated_at, groups: ff.groups });
  return hits;
}
