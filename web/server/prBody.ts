import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { execa } from 'execa';
import { readRun, readFindings, allFindings } from '../../src/store/store.ts';
import { Config } from '../../src/config.ts';
import { prBody } from '../../src/fix/prBody.ts';
import { explainChanges, technicalSection } from '../../src/fix/describe.ts';
import { uploadToGitHub } from '../../src/fix/githubImages.ts';
import type { VerifyResult } from '../../src/fix/verify.ts';
import { listJobs, readEvents } from './jobs.ts';
import { HttpError, runDirOf } from './workspaces.ts';

// GitHub attachment uploads share one browser profile. Serialize refreshes using it.
let updating = false;

/** Refresh saved evidence and verification without modifying or pushing the fix branch. */
export async function updatePrBody(b: { ws?: string; run?: string; url?: string; manuallyVerified?: boolean }) {
  if (!b.ws || !b.run || !b.url || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(b.url)) throw new HttpError(400, 'Pass ws, run and a GitHub pull request URL');
  if (b.manuallyVerified !== undefined && typeof b.manuallyVerified !== 'boolean') throw new HttpError(400, 'manuallyVerified must be true or false');
  const dir = runDirOf(b.ws, b.run);
  const ff = readFindings(dir);
  if (!ff) throw new HttpError(409, 'This run has no findings');
  const jobs = listJobs({ runDir: dir }).filter((j) => j.kind === 'fix');
  const known = allFindings(ff).some((f) => f.fix?.pr_url === b.url) || jobs.some((j) => j.pr_url === b.url);
  if (!known) throw new HttpError(404, 'This PR was not opened by this run');
  if (updating) throw new HttpError(409, 'Another PR body update is in progress');
  updating = true;
  try {
    const { stdout } = await execa('gh', ['pr', 'view', b.url, '--json', 'state,headRefName,headRefOid,files']);
    const pr = JSON.parse(stdout) as { state: string; headRefName: string; headRefOid: string; files: { path: string; additions: number; deletions: number }[] };
    if (pr.state !== 'OPEN') throw new HttpError(409, 'Only open PR bodies can be updated');
    const branchJobs = jobs.filter((j) => j.branch === pr.headRefName);
    if (branchJobs.some((j) => j.alive)) throw new HttpError(409, 'Wait for the fix or verification job to finish');
    const matched = allFindings(ff).filter((f) => f.fix?.branch === pr.headRefName);
    const selected = matched.filter((f) => !/side effect/.test(f.fix?.fixed_by ?? ''));
    const alsoFixed = matched.filter((f) => !selected.includes(f)).map((f) => f.id);
    if (!selected.length) throw new HttpError(409, 'No saved findings for this PR branch');
    const info = readRun(dir);
    const flags = [...new Set(selected.flatMap((f) => f.fix?.flags ?? []))];
    // Saved evidence must describe the published commit, not newer local work.
    if (!info.repo_path) throw new HttpError(409, 'This run has no local repository');
    const head = await execa('git', ['rev-parse', '--verify', `refs/heads/${pr.headRefName}`], { cwd: info.repo_path });
    if (head.stdout.trim() !== pr.headRefOid) throw new HttpError(409, 'The local fix branch differs from the PR. Publish its latest changes before refreshing the evidence');
    const worktrees = (await execa('git', ['worktree', 'list', '--porcelain'], { cwd: info.repo_path })).stdout;
    const active = worktrees.split('\n\n').find((block) => block.split('\n').includes(`branch refs/heads/${pr.headRefName}`));
    const worktree = active?.split('\n').find((line) => line.startsWith('worktree '))?.slice(9);
    if (worktree) {
      const dirty = await execa('git', ['status', '--porcelain'], { cwd: worktree });
      if (dirty.stdout.trim()) throw new HttpError(409, 'Commit and publish local changes before refreshing the PR evidence');
    }
    const latest = branchJobs[0];
    if (latest && latest.state !== 'succeeded') flags.push(`Latest job ${latest.id} ${latest.state} at ${latest.stage}; automatic verification did not complete`);
    for (const f of selected) {
      if (!f.fix?.verification) flags.push(`${f.id}: no saved automatic verification`);
      if (!(f.fix?.manual_after?.path ?? f.fix?.verification?.after?.annotated)) flags.push(`${f.id}: no after-fix screenshot`);
    }
    const verified = selected.every((f) => f.fix?.verified && f.fix.verification?.result === 'fixed') && !flags.length;
    const after: VerifyResult[] = selected.map((f) => {
      const ev = f.fix?.verification;
      return { id: f.id, verifiable: ev?.method === 'detector', present: !ev || ev.result === 'inconclusive' ? null : ev.result === 'present', method: ev?.method ?? 'none', checks: ev?.checks ?? [], review: ev?.review ?? null, after: null };
    });
    const before = branchJobs.flatMap((j) => readEvents(j.dir).events.filter((e) => e.stage === 'baseline' && e.data?.result).map((e) => e.data!.result as VerifyResult));
    const files: { path: string; name: string }[] = [];
    const evidencePath = (p: string) => {
      const root = realpathSync(dir);
      const file = realpathSync(join(dir, p));
      const rel = relative(root, file);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new HttpError(403, 'Evidence must be inside this run');
      return file;
    };
    for (const f of selected) {
      const beforePath = f.video?.gif ?? f.screenshots.annotated;
      const afterPath = f.fix?.manual_after?.path ?? f.fix?.verification?.after?.annotated;
      if (beforePath) files.push({ path: evidencePath(beforePath), name: `${f.id}-before.${f.video?.gif ? 'gif' : 'png'}` });
      if (afterPath) files.push({ path: evidencePath(afterPath), name: `${f.id}-after.png` });
    }
    const images = files.length ? await uploadToGitHub(b.url, files) : new Map<string, string>();
    if (images.size !== files.length) throw new HttpError(409, 'Some screenshots could not be uploaded. The PR body was left unchanged');
    const assetsDir = join(dir, 'fixes', pr.headRefName.replace(/\//g, '__'));
    mkdirSync(assetsDir, { recursive: true });
    const groups = ff.groups.filter((g) => g.findings.some((f) => selected.includes(f)));
    const config = Config.parse(info.config);
    const stats = pr.files.map((f) => ({ file: f.path, added: f.additions, removed: f.deletions }));
    const diff = (await execa('gh', ['pr', 'diff', b.url, '--patch'])).stdout;
    const explanation = await explainChanges({ diff, stats, findings: selected, groups, agentSummary: '', provider: config.provider, model: config.model, transcriptPath: join(assetsDir, 'refresh-explain.jsonl') });
    const technical = technicalSection(explanation, stats, selected.map((f) => f.title).join('; '));
    const publishedAnyway = branchJobs.some((j) => j.pr_url === b.url && j.options.publishUnverified === true);
    const manualVerified = b.manuallyVerified === true;
    const body = prBody({ selected, groups, before, after, verified, flags, technical, images, runId: info.run_id, attempts: 0, evidenceAt: Object.fromEntries(selected.filter((f) => f.fix?.verification).map((f) => [f.id, f.fix!.verification!.at])), regressions: [], alsoFixed, manualVerified, manualOverride: !verified && publishedAnyway });
    // Avoid overwriting if another process pushed while evidence/description were being prepared.
    const current = JSON.parse((await execa('gh', ['pr', 'view', b.url, '--json', 'headRefOid,state'])).stdout);
    if (current.headRefOid !== pr.headRefOid || current.state !== 'OPEN') throw new HttpError(409, 'The PR changed during refresh. Try again');
    const file = join(assetsDir, 'pr-body-refresh.md');
    writeFileSync(file, body);
    await execa('gh', ['pr', 'edit', b.url, '--body-file', file]);
    writeFileSync(join(assetsDir, 'pr-body.md'), body);
    writeFileSync(join(assetsDir, 'pr-body-approval.json'), JSON.stringify({ pr_url: b.url, head_commit: pr.headRefOid, manually_verified: manualVerified, approved_at: new Date().toISOString() }, null, 2));
    return { ok: true, images: images.size };
  } finally {
    updating = false;
  }
}
