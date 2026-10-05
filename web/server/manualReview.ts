import { execa } from 'execa';
import { readFindings, findById, readRun, writeFindings } from '../../src/store/store.ts';
import type { Finding, LayoutRegression } from '../../src/store/schema.ts';
import { parseRegression } from '../../src/fix/regressions.ts';
import { candidateKey, reviewBlockers } from '../../src/fix/manualReview.ts';
import { listJobs, readEvents } from './jobs.ts';
import { HttpError } from './workspaces.ts';

export function layoutCandidates(dir: string, f: Finding): LayoutRegression[] {
  if (f.fix?.verification?.regressions) return f.fix.verification.regressions;
  const job = listJobs({ runDir: dir }).find((j) => j.id === f.fix?.job_id);
  const last = (job ? readEvents(job.dir).events : []).filter((e) => Array.isArray(e.data?.regressions)).at(-1);
  return (last?.data?.regressions as unknown[] | undefined)?.flatMap((value) => {
    const parsed = typeof value === 'string' ? parseRegression(value) : null;
    return parsed ? [parsed] : [];
  }) ?? [];
}
export async function reviewHead(dir: string, f: Finding): Promise<string> {
  const repo = readRun(dir).repo_path;
  if (!repo || !f.fix?.branch) throw new HttpError(409, 'No local fix branch to review');
  if (listJobs({ runDir: dir }).some((j) => j.branch === f.fix?.branch && j.alive)) throw new HttpError(409, 'Wait for the branch job to finish');
  const head = (await execa('git', ['rev-parse', '--verify', `refs/heads/${f.fix.branch}`], { cwd: repo })).stdout.trim();
  const worktrees = (await execa('git', ['worktree', 'list', '--porcelain'], { cwd: repo })).stdout;
  const block = worktrees.split('\n\n').find((b) => b.split('\n').includes(`branch refs/heads/${f.fix!.branch}`));
  const worktree = block?.split('\n').find((l) => l.startsWith('worktree '))?.slice(9);
  if (worktree && (await execa('git', ['status', '--porcelain'], { cwd: worktree })).stdout.trim()) throw new HttpError(409, 'Commit changes and refresh verification before approving this fix');
  return head;
}
export async function saveManualReview(dir: string, id: string, body: { evidenceAt?: unknown; candidate?: unknown; dismissed?: unknown; confirm?: unknown }) {
  let ff = readFindings(dir);
  let f = ff && findById(ff, id)?.finding;
  if (!ff || !f?.fix?.verification) throw new HttpError(409, 'No saved verification to review');
  if (body.evidenceAt !== f.fix.verification.at) throw new HttpError(409, 'Verification changed. Refresh and review the latest evidence');
  const head = await reviewHead(dir, f);
  const branch = f.fix.branch;
  ff = readFindings(dir);
  f = ff && findById(ff, id)?.finding;
  if (!ff || !f?.fix?.verification || f.fix.branch !== branch || f.fix.verification.at !== body.evidenceAt) throw new HttpError(409, 'Verification changed. Refresh and review the latest evidence');
  const candidates = layoutCandidates(dir, f);
  const previous = f.fix.manual_review;
  const dismissed = previous?.head_commit === head && previous.evidence_at === f.fix.verification.at ? [...previous.dismissed] : [];
  let verifiedAt: string | null = null;
  if (body.candidate !== undefined) {
    if (typeof body.candidate !== 'string' || typeof body.dismissed !== 'boolean' || !candidates.some((r) => candidateKey(r) === body.candidate)) throw new HttpError(400, 'Choose a current layout candidate and dismissal state');
    const index = dismissed.indexOf(body.candidate);
    if (body.dismissed && index < 0) dismissed.push(body.candidate);
    if (!body.dismissed && index >= 0) dismissed.splice(index, 1);
  } else {
    if (body.confirm !== true) throw new HttpError(400, 'Explicit manual verification confirmation is required');
    const blockers = reviewBlockers(f, candidates, dismissed);
    if (blockers.length) throw new HttpError(409, blockers.join(' '));
    verifiedAt = new Date().toISOString();
  }
  // Persist legacy candidate details with the reviewed evidence, without changing automatic outcomes.
  f.fix.verification.regressions = candidates;
  if (verifiedAt) f.fix.blocked = false;
  else if (previous?.verified_at && !f.fix.pr_url) f.fix.blocked = true;
  f.fix.manual_review = { head_commit: head, evidence_at: f.fix.verification.at, dismissed, verified_at: verifiedAt };
  writeFindings(dir, { run_id: ff.run_id, target: ff.target, generated_at: ff.generated_at, groups: ff.groups });
  return { ok: true };
}
