import { existsSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { execa } from 'execa';
import { Config } from '../config.js';
import type { Finding, RootCauseGroup } from '../store/schema.js';
import { readRun, readFindings, writeFindings, findById, allFindings } from '../store/store.js';
import { resolveTarget } from '../target/resolve.js';
import { runClaude } from '../llm/claude.js';
import { BrowserPool } from '../triage/replay.js';
import { verifyFinding, captureAfter, pageSnapshot, type VerifyResult } from './verify.js';
import { Memory } from '../memory/siteMemory.js';
import { writeReport } from '../store/report.js';
import { JobReporter, newJobId, describeAgentEvent, type JobEvent } from '../jobs/events.js';
import { notifyFixDone } from '../notify/events.js';

export interface FixOptions {
  runDir: string;
  ids: string[];
  pr: boolean;
  draft: boolean;
  base?: string | null;
  maxAttempts: number;
  keepWorktree: boolean;
  log: (m: string) => void;
  jobId?: string | null;
  /**
   * new: fresh branch (fails if it exists). retry: start over on a fresh branch (name-2, -3, … if taken).
   * continue: pick up an existing branch where it stopped: re-verify it, run more attempts only if the bug is still
   * there, commit what's uncommitted, then publish.
   */
  mode?: 'new' | 'retry' | 'continue';
  /** Branch to continue (default: the branch this scope would get). */
  branch?: string | null;
}

const git = (cwd: string, args: string[]) => execa('git', args, { cwd, reject: false });

/** Shortens at a word boundary. */
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n - 1) > n * 0.6 ? s.lastIndexOf(' ', n - 1) : n - 1).trimEnd() + '…');

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export async function fixFindings(o: FixOptions) {
  const rep = new JobReporter(join(o.runDir, 'jobs'), o.jobId ?? newJobId('fix'), 'fix', {
    run_dir: o.runDir,
    finding_ids: o.ids,
    scope: o.ids.join(','),
    options: { pr: o.pr, draft: o.draft, base: o.base ?? null, maxAttempts: o.maxAttempts, mode: o.mode ?? 'new', branch: o.branch ?? null },
  });
  const say = (stage: string, msg: string, level: JobEvent['level'] = 'info', data?: Record<string, unknown>) => {
    if (level !== 'agent') o.log(msg);
    rep.event(stage, msg, level, data);
  };
  process.on('SIGTERM', () => {
    rep.finish('cancelled', { error: 'cancelled' });
    process.exit(143);
  });
  try {
    const r = await fixInner(o, rep, say);
    rep.finish('succeeded', { verified: r.verified, pr_url: r.prUrl, also_fixed: r.alsoFixed, error: r.publishError ? `Not published: ${r.publishError}` : null, summary: `${r.verified ? 'Fixed and verified' : 'Committed, but not fully verified'}${r.publishError ? ' — committed locally, but the push/PR failed (see the retry command)' : ''}` });
    notifyFixDone(o.runDir, { ids: o.ids, branch: r.branch, verified: r.verified, prUrl: r.prUrl });
    return r;
  } catch (e) {
    const msg = (e as Error).message;
    rep.finish('failed', { error: msg });
    throw e;
  }
}

type Say = (stage: string, msg: string, level?: JobEvent['level'], data?: Record<string, unknown>) => void;

async function fixInner(o: FixOptions, rep: JobReporter, say: Say) {
  say('resolve', `Resolving scope ${o.ids.join(', ')}`);
  const info = readRun(o.runDir);
  const config = Config.parse(info.config);
  const ff = readFindings(o.runDir);
  if (!ff) throw new Error('No findings.json in this run. Run `bugbash triage` first.');
  if (!info.repo_path) throw new Error('This run has no local repository (target was a URL without --repo); cannot fix.');
  if (!existsSync(info.repo_path)) throw new Error(`Repository not found: ${info.repo_path}`);
  // Real on-disk spelling: macOS paths are case-insensitive (Github vs GitHub), but path math below is not.
  const repo = realpathSync.native(info.repo_path);

  // ---- resolve scope: individual findings and/or whole groups ----
  const selected: Finding[] = [];
  const groups = new Map<string, RootCauseGroup>();
  for (const id of o.ids) {
    const g = ff.groups.find((x) => x.id === id);
    if (g) {
      g.findings.forEach((f) => selected.push(f));
      groups.set(g.id, g);
      continue;
    }
    const hit = findById(ff, id);
    if (!hit) throw new Error(`Unknown finding or group id: ${id}`);
    selected.push(hit.finding);
    groups.set(hit.group.id, hit.group);
  }
  const scopeIsGroup = o.ids.length === 1 && ff.groups.some((g) => g.id === o.ids[0]);
  const scopeLabel = scopeIsGroup ? o.ids[0] : selected.map((f) => f.id).join('+');
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  const gitTop = (await top).stdout.trim();
  if (!gitTop) throw new Error(`${repo} is not inside a git repository.`);
  const gitRoot = realpathSync.native(gitTop);
  const status = (await git(gitRoot, ['status', '--porcelain'])).stdout.split('\n').filter((l) => l.trim() && !l.slice(3).startsWith('.bugbash'));
  // The fix happens in a separate worktree branched from the last commit, so local edits can't leak into it and
  // aren't touched. Just say they're not included (and warn later if the fix edits the same files).
  const dirty = status.map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!);
  if (status.length) say('worktree', `Your working tree has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}). They stay as they are and aren't part of the fix branch.`, 'warn', { uncommitted: dirty.slice(0, 50) });
  const baseBranch = o.base ?? ((await git(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main');
  const mode = o.mode ?? 'new';
  const branchExists = async (b: string) => (await git(gitRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).exitCode === 0;
  const defaultBranch = `bugbash/${scopeLabel.toLowerCase()}-${slug(scopeIsGroup ? groups.get(o.ids[0])!.summary : selected[0].title)}`;
  let branch = defaultBranch;
  if (mode === 'continue') {
    branch = o.branch ?? defaultBranch;
    if (!(await branchExists(branch))) throw new Error(`Branch ${branch} doesn't exist any more, so there's nothing to continue. Use Retry to start over.`);
  } else if (mode === 'retry') for (let n = 2; await branchExists(branch); n++) branch = `${defaultBranch}-${n}`;
  const worktree = join(dirname(gitRoot), `${basename(gitRoot)}-bugbash-worktrees`, branch.replace(/\//g, '__'));
  const appDir = join(worktree, relative(gitRoot, repo));

  rep.update({ finding_ids: selected.map((f) => f.id), scope: scopeLabel, branch, base: baseBranch, worktree });
  say('worktree', `Fixing ${selected.map((f) => f.id).join(', ')} (${scopeIsGroup ? 'whole group' : 'selected findings'}) on branch ${branch} from ${baseBranch}`, 'info', { branch, base: baseBranch, worktree, findings: selected.map((f) => f.id), group_scope: scopeIsGroup });
  let createdWorktree = false;
  if (mode === 'continue') {
    if (existsSync(worktree)) say('worktree', `Continuing in the existing worktree for ${branch}`, 'info', { branch, worktree });
    else {
      const wt = await git(gitRoot, ['worktree', 'add', worktree, branch]);
      if (wt.exitCode !== 0) throw new Error(`git worktree add failed: ${wt.stderr}`);
      createdWorktree = true;
      say('worktree', `Checked out ${branch} in a worktree to continue`, 'success', { branch, worktree });
    }
  } else {
    if (existsSync(worktree)) throw new Error(`Worktree already exists: ${worktree} (remove it or use a different scope)`);
    if (await branchExists(branch)) throw new Error(`Branch ${branch} already exists. Use Continue to pick it up, or Retry to start over on a new branch.`);
    const wt = await git(gitRoot, ['worktree', 'add', '-b', branch, worktree, baseBranch]);
    if (wt.exitCode !== 0) throw new Error(`git worktree add failed: ${wt.stderr}`);
    createdWorktree = true;
    say('worktree', `Created branch ${branch} in worktree`, 'success', { branch, worktree });
  }
  // Everything is measured against where the branch left the base (committed + uncommitted work).
  const baseSha = (await git(gitRoot, ['merge-base', baseBranch, branch])).stdout.trim() || baseBranch;
  markFixing(o.runDir, selected.map((f) => f.id), { branch, base: baseBranch, job_id: rep.status.id, scope: scopeLabel });
  let target: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    // Give the worktree its own node_modules so the dev server can start there.
    await provideDependencies(repo, appDir, say);
    target = await resolveTarget(appDir, { devCommand: config.devCommand, devPort: null, log: (m) => say('server', m) });
  } catch (e) {
    // Setup failed before any work: remove what this job created so a retry starts clean (a continued branch is kept).
    if (createdWorktree) await git(gitRoot, ['worktree', 'remove', '--force', worktree]);
    if (mode !== 'continue') await git(gitRoot, ['branch', '-D', branch]);
    rep.update({ worktree: createdWorktree ? null : worktree });
    say('cleanup', mode === 'continue' ? `Setup failed; ${branch} is kept` : `Setup failed; removed the worktree and branch ${branch}`, 'warn');
    throw e;
  }
  const pool = new BrowserPool();
  const vo = { baseUrl: target.baseUrl, guardrails: config.guardrails, pool };
  const groupMembers = [...new Set([...groups.values()].flatMap((g) => g.findings))].filter((f) => !selected.includes(f));
  const touchedPages = [...new Set(selected.map((f) => f.page))];
  const memory = new Memory(info.workspace);
  const assetsDir = join(o.runDir, 'fixes', branch.replace(/\//g, '__'));
  mkdirSync(assetsDir, { recursive: true });

  try {
    // ---- baseline: confirm the bug is present in the worktree ----
    const before: VerifyResult[] = [];
    for (const f of selected) before.push(await verifyFinding(f, vo));
    // In continue mode the "baseline" is the branch as it stands (used to spot regressions from further attempts).
    if (mode !== 'continue') for (const b of before) say('baseline', `Baseline ${b.id}: ${b.present === null ? 'not auto-verifiable (visual)' : b.present ? 'present ✓' : 'NOT present (already fixed or not reproducible here)'}`, b.present === false ? 'warn' : 'info', { result: b });
    const baselineSnap = new Map<string, Awaited<ReturnType<typeof pageSnapshot>>>();
    for (const p of touchedPages) baselineSnap.set(p, await pageSnapshot(p, vo));

    // ---- fix loop ----
    let feedback = '';
    let after: VerifyResult[] = [];
    let regressions: string[] = [];
    let agentSummary = '';
    let attempt = 0;
    // Continue: check the branch as it stands first; only bring the agent back if the bug is still there.
    let skipAgent = false;
    if (mode === 'continue') {
      for (const f of selected) after.push(await verifyFinding(f, vo));
      const changed = (await git(worktree, ['diff', '--stat', baseSha])).stdout.trim();
      const still = after.filter((a) => a.present);
      say('verify:continue', `Branch as it stands: ${after.map((a) => `${a.id}=${a.present === null ? 'visual' : a.present ? 'STILL PRESENT' : 'fixed'}`).join(' ')}${changed ? '' : '; no changes yet'}`, still.length || !changed ? 'info' : 'success', { after });
      if (changed && !still.length) {
        skipAgent = true;
        agentSummary = (await git(worktree, ['log', '-1', '--format=%B', branch])).stdout.trim();
      } else if (changed) feedback = `This continues earlier work on the branch. Still present:\n${still.map((x) => `- ${x.id}: ${x.checks.filter((c) => c.present).map((c) => `${c.browser} ${c.width}x${c.height}`).join(', ')}`).join('\n')}\n\nCurrent diff from the base:\n${(await git(worktree, ['diff', baseSha])).stdout.slice(0, 6000)}`;
    }
    for (attempt = 1; !skipAgent && attempt <= o.maxAttempts; attempt++) {
      say(`attempt:${attempt}`, `Attempt ${attempt}/${o.maxAttempts}: fix agent is working…`, 'info', { attempt, feedback: feedback ? feedback.slice(0, 2000) : null });
      const r = await runClaude({
        onEvent: (e) => {
          for (const d of describeAgentEvent(e)) say(`attempt:${attempt}`, d.msg, 'agent', d.data);
        },
        prompt: fixPrompt(selected, [...groups.values()], groupMembers, scopeIsGroup, o.runDir, feedback),
        systemPrompt: FIX_SYSTEM,
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
        allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
        cwd: worktree,
        addDirs: [o.runDir],
        model: config.model,
        timeoutMs: 20 * 60_000,
        transcriptPath: join(assetsDir, `agent-attempt-${attempt}.jsonl`),
      });
      agentSummary = r.text;
      if (!r.ok) say(`attempt:${attempt}`, `Fix agent error: ${r.error}`, 'warn');
      else say(`attempt:${attempt}`, 'Fix agent finished', 'info', { summary: r.text.slice(0, 3000), tool_calls: r.toolCalls, duration_ms: r.durationMs });
      await new Promise((res) => setTimeout(res, 1500)); // let dev servers hot-reload
      after = [];
      for (const f of selected) after.push(await verifyFinding(f, vo));
      regressions = [];
      for (const p of touchedPages) {
        const snap = await pageSnapshot(p, vo);
        for (const [k, c] of snap) if (!baselineSnap.get(p)!.has(k)) regressions.push(`${p} @${k.split('|')[0]}px: new ${c.type} on ${c.selector} — ${c.message}`);
      }
      const still = after.filter((a) => a.present);
      const diff = (await git(worktree, ['diff', '--stat', baseSha])).stdout.trim();
      const ok = !!diff && !still.length && !regressions.length;
      say(`verify:${attempt}`, `Verify: ${after.map((a) => `${a.id}=${a.present === null ? 'visual' : a.present ? 'STILL PRESENT' : 'fixed'}`).join(' ')}; regressions: ${regressions.length}; diff: ${diff.split('\n').pop() || 'none'}`, ok ? 'success' : 'warn', { after, regressions, diff_stat: diff });
      if (!diff) feedback = 'No files were changed. Make the fix.';
      else if (still.length || regressions.length)
        feedback = [
          still.length ? `Still present after your change:\n${still.map((s) => `- ${s.id}: ${s.checks.filter((c) => c.present).map((c) => `${c.browser} ${c.width}x${c.height}`).join(', ')}`).join('\n')}` : '',
          regressions.length ? `Your change introduced new layout problems:\n${regressions.slice(0, 10).map((r) => `- ${r}`).join('\n')}` : '',
          `Current diff:\n${(await git(worktree, ['diff', baseSha])).stdout.slice(0, 6000)}`,
        ].filter(Boolean).join('\n\n');
      else break;
    }
    const verified = after.length > 0 && after.every((a) => a.present !== true) && regressions.length === 0;
    const diff = (await git(worktree, ['diff', '--stat', baseSha])).stdout.trim();
    if (!diff) throw new Error('Fix agent made no changes; nothing to commit.');

    // ---- other findings in the group that this fix also resolved ----
    const alsoFixed: string[] = [];
    for (const m of groupMembers) {
      const r = await verifyFinding(m, vo);
      if (r.present === false) alsoFixed.push(m.id);
    }
    if (groupMembers.length) say('also-fixed', alsoFixed.length ? `Also resolves ${alsoFixed.join(', ')}` : 'No other findings in the group were resolved', 'info', { also_fixed: alsoFixed });

    // ---- evidence ----
    for (const f of selected) await captureAfter(f, join(assetsDir, `${f.id}-after.png`), vo).catch(() => {});
    say('evidence', 'Captured after-fix screenshots', 'info', { after_shots: selected.map((f) => relative(o.runDir, join(assetsDir, `${f.id}-after.png`))) });

    // ---- commit ----
    const title = scopeIsGroup ? groups.get(o.ids[0])!.summary : selected.length === 1 ? selected[0].title : `${selected.length} UI fixes: ${selected.map((f) => f.id).join(', ')}`;
    const commitMsg = `fix(ui): ${clip(title, 64)}\n\nFixes ${selected.map((f) => f.id).join(', ')}${alsoFixed.length ? ` (also resolves ${alsoFixed.join(', ')})` : ''} found by bugbash run ${info.run_id}.\n${verified ? 'Verified: repro checks pass at all affected viewports/browsers; no new layout defects on touched pages.' : 'NOT fully verified — see PR description.'}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
    await git(worktree, ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude).bugbash', ':(exclude)**/.bugbash']);
    // Never commit a bugbash workspace into the target repo, whatever its .gitignore says.
    const staged = (await git(worktree, ['diff', '--cached', '--name-only'])).stdout.split('\n').filter((p) => /(^|\/)\.bugbash\//.test(p));
    if (staged.length) await git(worktree, ['reset', '-q', '--', ...staged]);
    // A continued branch may already have everything committed.
    if ((await git(worktree, ['diff', '--cached', '--quiet'])).exitCode !== 0) {
      const c = await git(worktree, ['commit', '-m', commitMsg]);
      if (c.exitCode !== 0) throw new Error(`git commit failed: ${c.stderr || c.stdout}`);
    }
    const sha = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    say('commit', `${skipAgent ? 'Fix already committed' : 'Committed'} ${sha.slice(0, 8)} on ${branch}`, 'success', { sha, message: commitMsg.split('\n')[0] });
    const touched = (await git(worktree, ['diff', '--name-only', baseSha, 'HEAD'])).stdout.split('\n').filter(Boolean);
    const overlap = touched.filter((f) => dirty.includes(f));
    if (overlap.length) say('commit', `Heads up: the fix changes ${overlap.join(', ')}, which you also have uncommitted edits to. Commit or stash those before merging ${branch}.`, 'warn', { overlap });

    // ---- PR ----
    let prUrl: string | null = null;
    let publishError: string | null = null;
    if (o.pr) {
      // Screenshots are never committed to the target repo (the .bugbash workspace stays private).
      const assetBase: string | null = null;
      const body = prBody({ selected, groups: [...groups.values()], alsoFixed, before, after, regressions, verified, agentSummary, runId: info.run_id, assetBase, attempts: attempt });
      const bodyFile = join(assetsDir, 'pr-body.md');
      writeFileSync(bodyFile, body);
      const prArgs = ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', `fix(ui): ${clip(title, 90)}`, '--body-file', bodyFile, ...(o.draft ? ['--draft'] : [])];
      // Publishing can fail for reasons unrelated to the fix (network, auth, GitHub limits). The verified commit is
      // kept either way; the job reports what to run to finish publishing.
      try {
        const leaked = (await git(worktree, ['log', '--name-only', '--format=', `${baseBranch}..${branch}`])).stdout.split('\n').filter((p) => /(^|\/)\.bugbash\//.test(p));
        if (leaked.length) throw new Error(`refusing to push: the branch contains .bugbash files (${leaked.slice(0, 3).join(', ')}); they must stay private`);
        say('push', `Pushing ${branch} to origin`);
        // HTTPS pushes over git's 1 MiB default buffer go out chunked, which GitHub sometimes rejects with
        // "RPC failed; HTTP 400" (evidence images easily exceed it): send them in one request instead.
        const push = await git(worktree, ['-c', 'http.postBuffer=524288000', 'push', '-u', 'origin', branch]);
        if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr.trim()}`);
        const existing = (await execa('gh', ['pr', 'view', branch, '--json', 'url,state', '-q', 'select(.state == "OPEN") | .url'], { cwd: worktree, reject: false })).stdout.trim();
        if (existing) prUrl = existing;
        else {
          const pr = await execa('gh', prArgs, { cwd: worktree, reject: false });
          if (pr.exitCode !== 0) throw new Error(`gh pr create failed: ${pr.stderr.trim()}`);
          prUrl = pr.stdout.trim().split('\n').pop() ?? null;
        }
        rep.update({ pr_url: prUrl });
        say('pr', `Opened ${o.draft ? 'draft ' : ''}PR ${prUrl}`, 'success', { pr_url: prUrl });
      } catch (e) {
        publishError = (e as Error).message;
        const retry = `git -C ${worktree} -c http.postBuffer=524288000 push -u origin ${branch} && gh pr create ${prArgs.slice(2).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
        say('push', `The fix is committed on ${branch}, but publishing failed: ${publishError}\nThe worktree is kept so you can retry:\n${retry}`, 'error', { retry });
        o.keepWorktree = true;
      }
    } else {
      writeFileSync(join(assetsDir, 'pr-body.md'), prBody({ selected, groups: [...groups.values()], alsoFixed, before, after, regressions, verified, agentSummary, runId: info.run_id, assetBase: null, attempts: attempt }));
      say('commit', `Not pushed (no PR requested). PR description draft saved.`, 'info', { pr_body: relative(o.runDir, join(assetsDir, 'pr-body.md')) });
    }

    // ---- record per-finding fix status ----
    const fresh = readFindings(o.runDir)!;
    const now = new Date().toISOString();
    for (const f of allFindings(fresh)) {
      const isSel = selected.some((s) => s.id === f.id);
      const isAlso = alsoFixed.includes(f.id);
      if (!isSel && !isAlso) continue;
      f.status = 'fixing';
      f.fix = { branch, base: baseBranch, pr_url: prUrl, verified: isSel ? verified : true, fixed_by: isSel ? scopeLabel : `${scopeLabel} (side effect)`, job_id: rep.status.id, at: now };
      memory.setBugStatus(f.fingerprint, 'fixing', info.run_id, f.id);
    }
    writeFindings(o.runDir, { run_id: fresh.run_id, target: fresh.target, generated_at: fresh.generated_at, groups: fresh.groups });
    writeReport(o.runDir);
    say('record', `Done: ${verified ? 'verified ✓' : 'NOT fully verified ✗'}${alsoFixed.length ? `; also fixed ${alsoFixed.join(', ')}` : ''}`, verified ? 'success' : 'warn');
    return { branch, prUrl, verified, alsoFixed, worktree, publishError };
  } catch (e) {
    restoreStatus(o.runDir, selected, rep.status.id);
    throw e;
  } finally {
    await pool.close();
    await target.stop();
    if (!o.keepWorktree) {
      await git(gitRoot, ['worktree', 'remove', '--force', worktree]);
      rep.update({ worktree: null });
      say('cleanup', `Worktree removed (branch ${branch} kept)`);
    } else say('cleanup', `Worktree kept at ${worktree}`);
  }
}

/** Marks findings as being fixed right away so every viewer sees the job. */
function markFixing(runDir: string, ids: string[], fix: { branch: string; base: string; job_id: string; scope: string }) {
  const ff = readFindings(runDir);
  if (!ff) return;
  for (const f of allFindings(ff)) {
    if (!ids.includes(f.id)) continue;
    f.status = 'fixing';
    f.fix = { branch: fix.branch, base: fix.base, pr_url: null, verified: false, fixed_by: fix.scope, job_id: fix.job_id, at: new Date().toISOString() };
  }
  writeFindings(runDir, { run_id: ff.run_id, target: ff.target, generated_at: ff.generated_at, groups: ff.groups });
}

/** On failure, put findings back to their pre-fix status (the job record keeps the failure). */
function restoreStatus(runDir: string, original: Finding[], jobId: string) {
  const ff = readFindings(runDir);
  if (!ff) return;
  for (const f of allFindings(ff)) {
    const o = original.find((x) => x.id === f.id);
    if (!o || f.fix?.job_id !== jobId) continue;
    f.status = o.status;
    f.fix = o.fix;
  }
  writeFindings(runDir, { run_id: ff.run_id, target: ff.target, generated_at: ff.generated_at, groups: ff.groups });
}

const FIX_SYSTEM = `You fix UI layout defects in a web codebase. You are in a git worktree on a dedicated branch.
Rules:
- Make the smallest, safest change that fixes the defect(s) in scope at every affected viewport and browser. Prefer robust CSS (min-height instead of height, allow wrapping, flex-wrap, min-width: 0, overflow-wrap: anywhere, max-width: 100%, responsive spacing) over magic numbers.
- Don't change unrelated code, formatting, dependencies, or tests. Don't touch findings outside your scope, even when they share a root cause (unless the scope is the whole group).
- Look at the screenshots/videos (Read tool) and the source hints before editing. Confirm the rule/markup that causes it.
- Don't run git. Don't create new files unless required.
- Finish with a short summary: root cause, what you changed (file:line), and why it fixes every affected width/browser.`;

function fixPrompt(selected: Finding[], groups: RootCauseGroup[], others: Finding[], wholeGroup: boolean, runDir: string, feedback: string) {
  const brief = (f: Finding) => ({
    id: f.id,
    title: f.title,
    type: f.type,
    severity: f.severity,
    page: f.page,
    browsers: f.browsers,
    viewports: f.viewports.map((v) => `${v.width}x${v.height}`),
    environment: f.reproduction.environment,
    element: f.element,
    metrics: f.metrics,
    expected: f.reproduction.expected,
    actual: f.reproduction.actual,
    steps: f.reproduction.steps_human,
    likely_cause: f.likely_cause,
    fix_hint: f.fix_hint,
    source_hints: f.source_hints,
    evidence: [f.screenshots.annotated, f.screenshots.crop, f.video?.filmstrip].filter(Boolean).map((p) => join(runDir, p!)),
  });
  return [
    `# Scope: ${wholeGroup ? 'fix the WHOLE root-cause group' : `fix ONLY ${selected.map((f) => f.id).join(', ')}`}`,
    `Findings to fix:\n${JSON.stringify(selected.map(brief), null, 1)}`,
    `Root-cause group context (for understanding; ${wholeGroup ? 'all in scope' : 'fix only the findings above'}):\n${JSON.stringify(groups.map((g) => ({ id: g.id, summary: g.summary, component: g.component, css_rule: g.css_rule, files: g.files, fix_plan: g.fix_plan })), null, 1)}`,
    others.length ? `Other findings in the same group (NOT in scope; mention in your summary if your fix likely affects them):\n${others.map((f) => `- ${f.id}: ${f.title}`).join('\n')}` : '',
    feedback ? `\n# Feedback from verification of your previous attempt\n${feedback}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function prBody(d: { selected: Finding[]; groups: RootCauseGroup[]; alsoFixed: string[]; before: VerifyResult[]; after: VerifyResult[]; regressions: string[]; verified: boolean; agentSummary: string; runId: string; assetBase: string | null; attempts: number }) {
  const lines: string[] = [];
  lines.push(`## Summary`, '', d.agentSummary.trim().slice(0, 3000) || '(no summary)', '');
  lines.push(`## Findings fixed`, '');
  for (const f of d.selected) {
    const b = d.before.find((x) => x.id === f.id);
    const a = d.after.find((x) => x.id === f.id);
    lines.push(`### ${f.id} — ${f.title}`, `- ${f.type}, ${f.severity}, on \`${f.page}\` (${f.browsers.join(', ')}; ${f.viewports.map((v) => v.width).join(', ')}px)`, `- Expected: ${f.reproduction.expected}`, `- Actual (before): ${f.reproduction.actual}`);
    lines.push(`- Verification: before ${b?.present === null ? 'visual-only' : b?.present ? 'present' : 'absent'} → after ${a?.present === null ? 'visual-only (please check screenshots)' : a?.present ? '**still present**' : 'fixed'}${a?.checks.length ? ` (${a.checks.map((c) => `${c.browser} ${c.width}px ${c.present ? '✗' : '✓'}`).join(', ')})` : ''}`);
    lines.push('', '<details><summary>Reproduction steps</summary>', '', ...f.reproduction.steps_human.map((s, i) => `${i + 1}. ${s}`), '', '</details>', '');
    if (d.assetBase) {
      const gif = f.video?.gif ? `<img src="${d.assetBase}/${f.id}-before.gif" width="420">` : `<img src="${d.assetBase}/${f.id}-before.png" width="420">`;
      lines.push(`| Before | After |`, `|---|---|`, `| ${gif} | <img src="${d.assetBase}/${f.id}-after.png" width="420"> |`, '');
    }
  }
  if (d.alsoFixed.length) lines.push(`## Also resolved (same root cause)`, '', d.alsoFixed.map((x) => `- ${x}`).join('\n'), '');
  const g = d.groups.map((x) => `- ${x.id}: ${x.summary}${x.fix_plan ? ` — plan: ${x.fix_plan}` : ''}`).join('\n');
  lines.push(`## Root-cause group`, '', g, '');
  lines.push(`## Verification`, '', d.verified ? `✅ Repro checks pass at every affected viewport/browser and the touched pages have no new layout defects (${d.attempts} attempt${d.attempts > 1 ? 's' : ''}).` : `⚠️ Not fully verified.${d.regressions.length ? `\nNew layout candidates on touched pages:\n${d.regressions.map((r) => `- ${r}`).join('\n')}` : ''}`, '');
  lines.push(`Found and fixed by bugbash (run \`${d.runId}\`).`, '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return lines.join('\n');
}

export function readText(p: string) {
  return readFileSync(p, 'utf8');
}

/**
 * Makes node_modules available in the worktree. A symlink back to the main checkout is not enough: Turbopack
 * (Next.js 16) rejects a node_modules symlink that points outside the project ("points out of the filesystem root").
 * In order: copy-on-write clone (macOS APFS `cp -c`, Linux `--reflink`; seconds, no extra disk), then a
 * lockfile-exact install with the project's package manager, then a symlink as the last resort.
 */
export async function provideDependencies(repo: string, appDir: string, say: (stage: string, msg: string, level?: JobEvent['level']) => void) {
  const src = join(repo, 'node_modules');
  const dest = join(appDir, 'node_modules');
  if (!existsSync(src) || existsSync(dest)) return;
  const t0 = Date.now();
  const clone = process.platform === 'darwin' ? await execa('cp', ['-cR', src, dest], { reject: false }) : await execa('cp', ['-R', '--reflink=always', src, dest], { reject: false });
  if (clone.exitCode === 0) {
    say('server', `Cloned node_modules into the worktree (copy-on-write, ${Math.round((Date.now() - t0) / 1000)}s)`);
    return;
  }
  await execa('rm', ['-rf', dest], { reject: false });
  const pm = existsSync(join(appDir, 'pnpm-lock.yaml'))
    ? ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline']
    : existsSync(join(appDir, 'yarn.lock'))
      ? ['yarn', 'install', '--frozen-lockfile', '--prefer-offline']
      : existsSync(join(appDir, 'package-lock.json'))
        ? ['npm', 'ci', '--prefer-offline', '--no-audit', '--no-fund']
        : null;
  if (pm) {
    say('server', `Installing dependencies in the worktree (${pm.slice(0, 2).join(' ')})`);
    const r = await execa(pm[0], pm.slice(1), { cwd: appDir, reject: false, timeout: 10 * 60_000, all: true });
    if (r.exitCode === 0) return;
    say('server', `${pm.slice(0, 2).join(' ')} failed: ${String(r.all ?? '').slice(-300)}`, 'warn');
  }
  symlinkSync(src, dest, 'dir');
  say('server', 'Linked node_modules from your checkout (some bundlers, e.g. Turbopack, reject this)', 'warn');
}

/** Keeps PR evidence light: scales screenshots wider than 1400px down (macOS sips; skipped elsewhere). */
async function shrinkImages(dir: string) {
  if (process.platform !== 'darwin' || !existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.png'))) {
    const w = Number((await execa('sips', ['-g', 'pixelWidth', join(dir, f)], { reject: false })).stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0);
    if (w > 1400) await execa('sips', ['--resampleWidth', '1400', join(dir, f)], { reject: false });
  }
}
