import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRun, readFindings, allFindings } from '../store/store.js';
import { categoryOf } from '../store/schema.js';
import { notifyDetached, runPath } from './notify.js';

const ACTIVE = new Set(['new', 'confirmed', 'fixing']);

/** Run finished (explored, or explored + triaged): headline counts, new critical/major bugs and regressions. */
export function notifyRunDone(runDir: string) {
  try {
    const info = readRun(runDir);
    const label = info.name ?? info.target;
    const ff = readFindings(runDir);
    const path = runPath(info.workspace, info.run_id);
    if (!ff) {
      const raw = existsSync(join(runDir, 'agent-findings.jsonl')) ? readFileSync(join(runDir, 'agent-findings.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
      notifyDetached({ event: 'run', level: 'info', title: `Bug bash finished: ${label}`, body: `${raw} raw finding(s) recorded. Triage it next to dedupe and verify them.`, path });
      return;
    }
    const active = allFindings(ff).filter((f) => ACTIVE.has(f.status) && !f.workflow?.archived && (f.category ?? categoryOf(f.type)) === 'layout');
    const functional = allFindings(ff).filter((f) => ACTIVE.has(f.status) && !f.workflow?.archived && (f.category ?? categoryOf(f.type)) === 'ux-functional').length;
    const crit = active.filter((f) => f.severity === 'critical');
    const major = active.filter((f) => f.severity === 'major');
    const newHigh = [...crit, ...major].filter((f) => f.history_tag === 'new');
    const regressed = active.filter((f) => f.history_tag === 'regressed');
    const lines = [
      `${active.length} active bug(s): ${crit.length} critical, ${major.length} major${functional ? ` (+${functional} functional)` : ''}.`,
      newHigh.length ? `New critical/major: ${newHigh.slice(0, 3).map((f) => `${f.id} ${f.title}`).join('; ')}${newHigh.length > 3 ? ` and ${newHigh.length - 3} more` : ''}.` : '',
      regressed.length ? `Regressed: ${regressed.slice(0, 3).map((f) => `${f.id} ${f.title}`).join('; ')}${regressed.length > 3 ? ` and ${regressed.length - 3} more` : ''}.` : '',
    ].filter(Boolean);
    notifyDetached({ event: 'run', level: regressed.length || crit.length ? 'warn' : 'success', title: `Triage finished: ${label}`, body: lines.join('\n'), path });
    // Reviewer outages silently weaken triage: surface them as a failure.
    const stats = existsSync(join(runDir, 'triage-stats.json')) ? (JSON.parse(readFileSync(join(runDir, 'triage-stats.json'), 'utf8')) as { findings?: { reviewer: string }[] }) : null;
    const unavailable = stats?.findings?.filter((f) => f.reviewer === 'unavailable').length ?? 0;
    if (unavailable) notifyDetached({ event: 'failure', level: 'warn', title: `Reviewer unavailable during triage: ${label}`, body: `The independent reviewer couldn't check ${unavailable} finding(s), so they rely on detectors and replays only.`, path });
  } catch {}
}

export function notifyFixDone(runDir: string, d: { ids: string[]; branch: string; verified: boolean; prUrl: string | null }) {
  try {
    const info = readRun(runDir);
    notifyDetached({
      event: 'fix',
      level: d.verified ? 'success' : 'warn',
      title: `Fix ${d.verified ? 'verified' : 'committed (not fully verified)'}: ${d.ids.join(', ')}`,
      body: `Branch ${d.branch}${d.prUrl ? `\nPR: ${d.prUrl}` : '\nNot pushed.'}`,
      path: `${runPath(info.workspace, info.run_id)}/bugs/${d.ids[0]}`,
    });
  } catch {}
}

export function notifyProposals(n: number, summary: string) {
  if (!n) return;
  notifyDetached({ event: 'proposals', level: 'info', title: `${n} improvement proposal(s) waiting for review`, body: summary.slice(0, 400), path: '/improvements' });
}

export function notifyFailure(title: string, body: string, path: string | null = null) {
  notifyDetached({ event: 'failure', level: 'error', title, body, path });
}
