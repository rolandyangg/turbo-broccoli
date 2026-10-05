import { manualReviewValid } from './manualReview.js';
import { annotateDefect } from '../triage/annotate.js';
import type { LayoutRegression } from '../store/schema.js';
import { fixJobKind } from '../jobs/kinds.js';
import { existsSync, mkdirSync, copyFileSync, symlinkSync, writeFileSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { execa } from 'execa';
import { Config } from '../config.js';
import type { Finding, FixVerification, RootCauseGroup } from '../store/schema.js';
import { readRun, readFindings, writeFindings, findById, allFindings } from '../store/store.js';
import { resolveTarget } from '../target/resolve.js';
import { runAgent } from '../llm/runner.js';
import { BrowserPool } from '../triage/replay.js';
import { verifyFinding, captureAfter, recordAfterVideo, needsVideo, pageSnapshot, type VerifyResult } from './verify.js';
import { Memory } from '../memory/siteMemory.js';
import { writeReport } from '../store/report.js';
import { JobReporter, newJobId, describeAgentEvent, type JobEvent } from '../jobs/events.js';
import { notifyFixDone } from '../notify/events.js';
import { commitMessage, explainChanges, technicalSection, type FileStat } from './describe.js';
import { prBody } from './prBody.js';
import { fixBrowserTools } from './browser.js';

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
  mode?: 'new' | 'retry' | 'continue' | 'verify';
  /** Branch to continue (default: the branch this scope would get). */
  branch?: string | null;
  /** The person's instructions for the fix agent (e.g. sent to a finished job to re-steer it). */
  instructions?: string | null;
  /** Publish even though the fix isn't fully verified (an explicit, separately confirmed override). */
  publishUnverified?: boolean;
  /**
   * With publishUnverified on a continued branch: publish with the saved verification and the before/after pictures
   * the person reviewed (including a manually chosen after screenshot), instead of re-checking the branch and
   * capturing new after pictures right before publishing.
   */
  keepEvidence?: boolean;
}

const git = (cwd: string, args: string[], input?: string) => execa('git', args, { cwd, reject: false, ...(input !== undefined ? { input } : {}) });

/** Shortens at a word boundary. */
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n - 1) > n * 0.6 ? s.lastIndexOf(' ', n - 1) : n - 1).trimEnd() + '…');

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export async function fixFindings(o: FixOptions) {
  const kind = fixJobKind(o);
  const rep = new JobReporter(join(o.runDir, 'jobs'), o.jobId ?? newJobId(kind), kind, {
    run_dir: o.runDir,
    finding_ids: o.ids,
    scope: o.ids.join(','),
    options: { pr: o.pr, draft: o.draft, base: o.base ?? null, maxAttempts: o.maxAttempts, mode: o.mode ?? 'new', branch: o.branch ?? null, instructions: o.instructions ?? null, publishUnverified: !!o.publishUnverified, keepEvidence: !!o.keepEvidence },
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
    rep.finish('succeeded', { verified: r.verified, pr_url: r.prUrl, also_fixed: r.alsoFixed, options: { ...rep.status.options, flags: r.flags }, error: r.publishError ? `Not published: ${r.publishError}` : null, summary: `${r.verified ? 'Fixed and verified' : 'Committed, but not fully verified'}${r.publishError ? ' — committed locally, but the push/PR failed (see the retry command)' : ''}` });
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
  // Publishing with the saved evidence: no re-check, no new pictures, no agent.
  const keep = !!o.keepEvidence;
  if (keep && !(mode === 'continue' && o.publishUnverified && o.pr)) throw new Error('Keeping the current before/after pictures only applies when publishing a continued fix anyway (--continue --pr --publish-unverified)');
  if (keep && o.instructions?.trim()) throw new Error("Instructions change the fix, so its pictures can't be kept; send instructions without keeping the pictures");
  if (keep) {
    const missing = selected.filter((f) => !f.fix?.verification).map((f) => f.id);
    if (missing.length) throw new Error(`No saved verification for ${missing.join(', ')} to publish with; publish without keeping the pictures so it is checked first`);
  }
  const branchExists = async (b: string) => (await git(gitRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).exitCode === 0;
  const defaultBranch = `bugbash/${scopeLabel.toLowerCase()}-${slug(scopeIsGroup ? groups.get(o.ids[0])!.summary : selected[0].title)}`;
  let branch = defaultBranch;
  if (mode === 'continue' || mode === 'verify') {
    branch = o.branch ?? defaultBranch;
    if (!(await branchExists(branch))) throw new Error(`Branch ${branch} doesn't exist any more, so there's nothing to continue. Use Retry to start over.`);
  } else if (mode === 'retry') for (let n = 2; await branchExists(branch); n++) branch = `${defaultBranch}-${n}`;
  const worktree = join(dirname(gitRoot), `${basename(gitRoot)}-bugbash-worktrees`, branch.replace(/\//g, '__'));
  const appDir = join(worktree, relative(gitRoot, repo));

  rep.update({ finding_ids: selected.map((f) => f.id), scope: scopeLabel, branch, base: baseBranch, worktree });
  say('worktree', `Fixing ${selected.map((f) => f.id).join(', ')} (${scopeIsGroup ? 'whole group' : 'selected findings'}) on branch ${branch} from ${baseBranch}`, 'info', { branch, base: baseBranch, worktree, findings: selected.map((f) => f.id), group_scope: scopeIsGroup });
  let createdWorktree = false;
  if (mode === 'continue' || mode === 'verify') {
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
  if (mode !== 'verify') markFixing(o.runDir, selected.map((f) => f.id), { branch, base: baseBranch, job_id: rep.status.id, scope: scopeLabel });
  let target: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    // Give the worktree its own node_modules so the dev server can start there.
    await provideDependencies(repo, appDir, say);
    target = await resolveTarget(appDir, { devCommand: config.devCommand, devPort: null, log: (m) => say('server', m) });
  } catch (e) {
    // Setup failed before any work: remove what this job created so a retry starts clean (a continued branch is kept).
    if (createdWorktree) await git(gitRoot, ['worktree', 'remove', '--force', worktree]);
    if (mode !== 'continue' && mode !== 'verify') await git(gitRoot, ['branch', '-D', branch]);
    rep.update({ worktree: createdWorktree ? null : worktree });
    say('cleanup', mode === 'continue' || mode === 'verify' ? `Setup failed; ${branch} is kept` : `Setup failed; removed the worktree and branch ${branch}`, 'warn');
    throw e;
  }
  const pool = new BrowserPool();
  const vo = { baseUrl: target.baseUrl, guardrails: config.guardrails, pool };
  const groupMembers = [...new Set([...groups.values()].flatMap((g) => g.findings))].filter((f) => !selected.includes(f));
  const touchedPages = [...new Set(selected.map((f) => f.page))];
  const memory = new Memory(info.workspace);
  const assetsDir = join(o.runDir, 'fixes', branch.replace(/\//g, '__'));
  mkdirSync(assetsDir, { recursive: true });

  // After-fix checks: detectors where they can decide, a visual before/after review where they can't.
  const reviewed = (attempt: number | string) => ({ ...vo, review: { runDir: o.runDir, outDir: join(assetsDir, `check-${attempt}`), provider: config.provider, model: config.model, transcriptDir: assetsDir } });
  const label = (a: VerifyResult) => (a.present === null ? 'inconclusive' : a.present ? 'STILL PRESENT' : a.method === 'visual-review' ? 'fixed (visual review)' : 'fixed');
  try {
    // ---- baseline: confirm the bug is present in the worktree ----
    const before: VerifyResult[] = [];
    if (keep) say('evidence', 'Publishing with the current before/after pictures and the saved verification: the branch is not re-checked and no new pictures are taken', 'info');
    else for (const f of selected) before.push(await verifyFinding(f, vo));
    // In continue mode the "baseline" is the branch as it stands (used to spot regressions from further attempts).
    if (mode !== 'continue' && mode !== 'verify') for (const b of before) say('baseline', `Baseline ${b.id}: ${b.present === null ? 'not auto-checkable (visual review after the fix)' : b.present ? 'present ✓' : 'NOT present (already fixed or not reproducible here)'}`, b.present === false ? 'warn' : 'info', { result: b });
    const baselineSnap = new Map<string, Awaited<ReturnType<typeof pageSnapshot>>>();
    if (!keep) for (const p of touchedPages) baselineSnap.set(p, await pageSnapshot(p, vo));

    // ---- fix loop ----
    let feedback = '';
    let after: VerifyResult[] = [];
    let regressions: string[] = [];
    let regressionDetails: LayoutRegression[] = [];
    let agentSummary = '';
    let attempt = 0;
    // Continue: check the branch as it stands first; only bring the agent back if the bug is still there.
    let skipAgent = false;
    if (keep) {
      after = selected.map((f) => savedResult(f));
      regressionDetails = selected.flatMap((f) => f.fix?.verification?.regressions ?? []);
      regressions = [...new Set(regressionDetails.map((r) => `${r.page} @${r.width}px: new ${r.type} on ${r.selector} — ${r.message}`))];
      skipAgent = true;
      agentSummary = (await git(worktree, ['log', '-1', '--format=%B', branch])).stdout.trim();
      say('verify:continue', `Saved verification: ${after.map((a) => `${a.id}=${label(a)}`).join(' ')}`, 'info', { after });
    } else if (mode === 'continue' || mode === 'verify') {
      for (const f of selected) after.push(await verifyFinding(f, reviewed('branch')));
      const changed = (await git(worktree, ['diff', '--stat', baseSha])).stdout.trim();
      const still = after.filter((a) => a.present);
      say('verify:continue', `Branch as it stands: ${after.map((a) => `${a.id}=${label(a)}`).join(' ')}${changed ? '' : '; no changes yet'}`, still.length || !changed ? 'info' : 'success', { after });
      if (mode === 'verify') {
        skipAgent = true;
        agentSummary = (await git(worktree, ['log', '-1', '--format=%B', branch])).stdout.trim();
      } else if (changed && !still.length && !o.instructions) {
        skipAgent = true;
        agentSummary = (await git(worktree, ['log', '-1', '--format=%B', branch])).stdout.trim();
      } else if (changed && !still.length) feedback = '';
      else if (changed) feedback = `This continues earlier work on the branch. Still present:\n${still.map((x) => `- ${x.id}: ${x.checks.filter((c) => c.present).map((c) => `${c.browser} ${c.width}x${c.height}`).join(', ')}`).join('\n')}\n\nCurrent diff from the base:\n${(await git(worktree, ['diff', baseSha])).stdout.slice(0, 6000)}`;
    }
    // The person's instructions go first, and always bring the agent back (they asked for a change).
    const steer = o.instructions?.trim() ? `# Instructions from the person reviewing this fix (follow them within your rules)\n${o.instructions.trim()}\n\nCurrent diff from the base:\n${(await git(worktree, ['diff', baseSha])).stdout.slice(0, 6000) || '(no changes yet)'}` : '';
    if (steer && mode !== 'verify') skipAgent = false;
    for (attempt = 1; !skipAgent && attempt <= o.maxAttempts; attempt++) {
      say(`attempt:${attempt}`, `Attempt ${attempt}/${o.maxAttempts}: fix agent is working…`, 'info', { attempt, feedback: feedback ? feedback.slice(0, 2000) : null });
      const browserTools = fixBrowserTools(selected, config, target.baseUrl, join(assetsDir, `browser-attempt-${attempt}`));
      const r = await runAgent({
        onEvent: (e) => {
          for (const d of describeAgentEvent(e)) say(`attempt:${attempt}`, d.msg, 'agent', d.data);
        },
        prompt: fixPrompt(selected, [...groups.values()], groupMembers, scopeIsGroup, o.runDir, [steer, feedback].filter(Boolean).join('\n\n')),
        systemPrompt: FIX_SYSTEM,
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
        mcpServers: browserTools.mcpServers,
        allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', ...browserTools.allowedTools],
        cwd: worktree,
        addDirs: [o.runDir],
        provider: config.provider, model: config.model,
        timeoutMs: 20 * 60_000,
        transcriptPath: join(assetsDir, `agent-attempt-${attempt}.jsonl`),
        agentName: 'fix agent',
      });
      agentSummary = r.text;
      if (!r.ok) say(`attempt:${attempt}`, `Fix agent error: ${r.error}`, 'warn');
      else say(`attempt:${attempt}`, 'Fix agent finished', 'info', { summary: r.text.slice(0, 3000), tool_calls: r.toolCalls, duration_ms: r.durationMs });
      await new Promise((res) => setTimeout(res, 1500)); // let dev servers hot-reload
      after = [];
      for (const f of selected) after.push(await verifyFinding(f, reviewed(attempt)));
      regressions = [];
      regressionDetails = [];
      for (const p of touchedPages) {
        await pageSnapshot(p, { ...vo, onCandidate: async (key, candidate, page) => {
          if (baselineSnap.get(p)!.has(key)) return;
          const width = Number(key.split('|')[0]);
          regressions.push(`${p} @${width}px: new ${candidate.type} on ${candidate.selector} — ${candidate.message}`);
          const stem = join(assetsDir, `regression-${attempt}-${regressionDetails.length + 1}`);
          let preview: string | null = null;
          try {
            await annotateDefect(page, { selector: candidate.selector, relatedSelector: candidate.related?.selector,
              fallbackBBox: candidate.bbox, label: candidate.message,
              files: { annotated: `${stem}.png`, crop: `${stem}-crop.png`, full: `${stem}-full.png` } });
            preview = relative(o.runDir, `${stem}-crop.png`);
          } catch { /* Keep the description even when a screenshot cannot be captured. */ }
          regressionDetails.push({ page: p, width, type: candidate.type, selector: candidate.selector,
            message: candidate.message, text: candidate.text, preview });
        } });
      }
      const still = after.filter((a) => a.present);
      const diff = (await git(worktree, ['diff', '--stat', baseSha])).stdout.trim();
      const ok = !!diff && !still.length && !regressions.length;
      say(`verify:${attempt}`, `Verify: ${after.map((a) => `${a.id}=${label(a)}`).join(' ')}; regressions: ${regressions.length}; diff: ${diff.split('\n').pop() || 'none'}`, ok && after.every((a) => a.present === false) ? 'success' : 'warn', { after, regressions, regression_details: regressionDetails, diff_stat: diff });
      for (const a of after) if (a.review) say(`verify:${attempt}`, `Visual review of ${a.id}: ${a.review.fixed ? 'looks fixed' : 'still looks broken'} (${Math.round(a.review.confidence * 100)}%): ${a.review.reasoning}`, a.review.fixed ? 'info' : 'warn');
      if (!diff) feedback = 'No files were changed. Make the fix.';
      else if (still.length || regressions.length)
        feedback = [
          still.length ? `Still present after your change:\n${still.map((s) => `- ${s.id}: ${s.checks.filter((c) => c.present).map((c) => `${c.browser} ${c.width}x${c.height}`).join(', ')}`).join('\n')}` : '',
          regressions.length ? `Your change introduced new layout problems:\n${regressions.slice(0, 10).map((r) => `- ${r}`).join('\n')}` : '',
          `Current diff:\n${(await git(worktree, ['diff', baseSha])).stdout.slice(0, 6000)}`,
        ].filter(Boolean).join('\n\n');
      else break;
    }
    // Verified means every check shows the bug gone; "couldn't tell" never counts as fixed.
    const verified = keep ? selected.every((f) => f.fix?.verified) : after.length > 0 && after.every((a) => a.present === false) && regressions.length === 0;
    const inconclusive = after.filter((a) => a.present === null).map((a) => a.id);
    if (inconclusive.length) say('verify', `Couldn't confirm ${inconclusive.join(', ')} automatically: compare the before/after on the bug page, or reproduce it on the fixed version`, 'warn');
    const diff = (await git(worktree, ['diff', '--stat', baseSha])).stdout.trim();
    if (!diff) throw new Error('Fix agent made no changes; nothing to commit.');

    // ---- other findings in the group that this fix also resolved ----
    const alsoFixed: string[] = [];
    for (const m of keep ? [] : groupMembers) {
      const r = await verifyFinding(m, vo);
      if (r.present === false) alsoFixed.push(m.id);
    }
    if (groupMembers.length && !keep) say('also-fixed', alsoFixed.length ? `Also resolves ${alsoFixed.join(', ')}` : 'No other findings in the group were resolved', 'info', { also_fixed: alsoFixed });

    // ---- evidence: after stills of the same spot, plus a video for behaviour bugs ----
    const evidence = new Map<string, FixVerification>();
    if (keep) for (const f of selected) evidence.set(f.id, f.fix!.verification!);
    for (const f of keep ? [] : selected) {
      const a = after.find((x) => x.id === f.id)!;
      const shotFile = join(assetsDir, `${f.id}-after.png`);
      const shot = await captureAfter(f, shotFile, vo).catch(() => null);
      let video: FixVerification['after_video'] = null;
      if (needsVideo(f)) {
        say('evidence', `Recording an after-fix video of ${f.id} (it's a behaviour bug)`);
        const v = await recordAfterVideo(f, assetsDir, vo).catch(() => null);
        if (v) video = { mp4: v.mp4 && relative(o.runDir, v.mp4), gif: v.gif && relative(o.runDir, v.gif), filmstrip: v.filmstrip && relative(o.runDir, v.filmstrip) };
      }
      const rel = (p: string) => (existsSync(p) ? relative(o.runDir, p) : null);
      evidence.set(f.id, {
        result: a.present === false ? 'fixed' : a.present ? 'present' : 'inconclusive',
        method: a.method,
        checks: a.checks,
        review: a.review,
        after: shot ? { annotated: rel(shotFile), crop: rel(shotFile.replace(/\.png$/, '-crop.png')), full: rel(shotFile.replace(/\.png$/, '-full.png')), element_found: shot.found } : null,
        regressions: regressionDetails,
        after_video: video,
        at: new Date().toISOString(),
      });
    }
    if (!keep) say('evidence', `Captured after-fix evidence${[...evidence.values()].some((e) => e.after_video) ? ' (stills and video)' : ''}`, 'info', { after: Object.fromEntries(evidence) });

    // Anything that keeps this fix from being fully trusted, in words a reviewer can act on.
    const flags = keep ? [...new Set(selected.flatMap((f) => f.fix?.flags ?? []))] : verificationFlags(selected, after, evidence, regressions);
    if (flags.length) say('verify', `Flags:\n${flags.map((x) => `- ${x}`).join('\n')}`, 'warn', { flags });

    if (mode === 'verify') {
      // Re-verification only: update the record, change nothing on the branch.
      const fresh = readFindings(o.runDir)!;
      for (const f of allFindings(fresh)) {
        const ev = evidence.get(f.id);
        if (!ev) continue;
        const own = flags.filter((x) => x.startsWith(`${f.id}:`) || !/^BB-\d+:/.test(x));
        if (f.fix) {
          f.fix.verification = ev;
          f.fix.verified = ev.result === 'fixed' && regressions.length === 0;
          f.fix.flags = own;
          if (f.fix.verified) f.fix.blocked = false;
        } else f.fix = { branch, base: baseBranch, pr_url: null, verified: ev.result === 'fixed', fixed_by: scopeLabel, job_id: rep.status.id, at: new Date().toISOString(), verification: ev, flags: own, blocked: false, manual_after: null };
      }
      writeFindings(o.runDir, { run_id: fresh.run_id, target: fresh.target, generated_at: fresh.generated_at, groups: fresh.groups });
      say('record', `Re-verified: ${verified ? 'fixed ✓' : inconclusive.length ? `couldn't confirm ${inconclusive.join(', ')}` : 'NOT fixed ✗'}`, verified ? 'success' : 'warn');
      return { branch, prUrl: null, verified, alsoFixed, worktree, publishError: null, flags };
    }

    // ---- stage, explain the change (from the real diff), then commit with a message about the change ----
    await git(worktree, ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude).bugbash', ':(exclude)**/.bugbash']);
    // Never commit a bugbash workspace into the target repo, whatever its .gitignore says.
    const staged = (await git(worktree, ['diff', '--cached', '--name-only'])).stdout.split('\n').filter((p) => /(^|\/)\.bugbash\//.test(p));
    if (staged.length) await git(worktree, ['reset', '-q', '--', ...staged]);
    // Base → index covers what's already committed on a continued branch plus what's about to be.
    const stats: FileStat[] = (await git(worktree, ['diff', '--cached', '--numstat', baseSha])).stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'))
      .map(([a, r, file]) => ({ file, added: Number(a) || 0, removed: Number(r) || 0 }));
    say('commit', 'Writing a description of the change');
    const explanation = await explainChanges({ diff: (await git(worktree, ['diff', '--cached', baseSha])).stdout, stats, findings: selected, groups: [...groups.values()], agentSummary, provider: config.provider, model: config.model, transcriptPath: join(assetsDir, 'explain.jsonl') });
    if (!explanation) say('commit', "Couldn't write a description of the change; using the changed files and the fix agent's notes", 'warn');
    const technical = technicalSection(explanation, stats, agentSummary);
    const title = scopeIsGroup ? groups.get(o.ids[0])!.summary : selected.length === 1 ? selected[0].title : `${selected.length} UI fixes: ${selected.map((f) => f.id).join(', ')}`;
    const commitMsg = commitMessage(explanation, stats, { fallbackTitle: title, refs: [...selected.map((f) => f.id), ...alsoFixed], runId: info.run_id, verified });
    // A continued branch may already have everything committed.
    if ((await git(worktree, ['diff', '--cached', '--quiet'])).exitCode !== 0) {
      const c = await git(worktree, ['commit', '-F', '-'], commitMsg);
      if (c.exitCode !== 0) throw new Error(`git commit failed: ${c.stderr || c.stdout}`);
    }
    const sha = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    const manualVerified = keep && selected.every((f) => manualReviewValid(f, sha));
    if (keep && selected.some((f) => f.fix?.manual_review?.verified_at) && !manualVerified) throw new Error('Manual approval is outdated. Review the latest commit and evidence before publishing.');
    say('commit', `${skipAgent ? 'Fix already committed' : 'Committed'} ${sha.slice(0, 8)} on ${branch}`, 'success', { sha, message: commitMsg.split('\n')[0] });
    const touched = (await git(worktree, ['diff', '--name-only', baseSha, 'HEAD'])).stdout.split('\n').filter(Boolean);
    const overlap = touched.filter((f) => dirty.includes(f));
    if (overlap.length) say('commit', `Heads up: the fix changes ${overlap.join(', ')}, which you also have uncommitted edits to. Commit or stash those before merging ${branch}.`, 'warn', { overlap });

    // ---- PR ----
    let prUrl: string | null = null;
    let publishError: string | null = null;
    // Gate: never publish a fix that isn't fully verified, unless the person explicitly overrides it.
    const blocked = !!o.pr && !verified && !o.publishUnverified;
    if (blocked) {
      publishError = `Blocked: not fully verified, so it was not pushed and no PR was opened. ${flags.length ? `Flags: ${flags.join('; ')}` : ''}`.trim();
      say('pr', `Publishing blocked: the fix isn't fully verified. Nothing was pushed. Review the before/after, then send the agent more instructions, retry verification, or publish anyway.`, 'error', { flags });
      o.keepWorktree = true;
    }
    if (o.pr && !blocked) {
      // Screenshots are never committed to the target repo (the .bugbash workspace stays private); they're hosted by
      // GitHub itself once the branch is pushed (see attachImages below).
      let images: Map<string, string> | null = null;
      const bodyFile = join(assetsDir, 'pr-body.md');
      const writeBody = () => writeFileSync(bodyFile, prBody({ selected, groups: [...groups.values()], alsoFixed, before, after, regressions, verified, technical, runId: info.run_id, images, attempts: attempt, flags, manualVerified, manualOverride: !!o.publishUnverified && !verified, evidenceAt: Object.fromEntries([...evidence].map(([id, ev]) => [id, ev.at])) }));
      writeBody();
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
        const nwo = (await execa('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: worktree, reject: false })).stdout.trim();
        images = await attachImages(nwo, existing || `https://github.com/${nwo}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}?expand=1`, selected, o.runDir, assetsDir, say, keep);
        writeBody();
        if (existing) {
          prUrl = existing;
          const edited = await execa('gh', ['pr', 'edit', existing, '--body-file', bodyFile], { cwd: worktree, reject: false });
          if (edited.exitCode !== 0) throw new Error(`gh pr edit failed: ${edited.stderr.trim()}`);
        } else {
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
      writeFileSync(join(assetsDir, 'pr-body.md'), prBody({ selected, groups: [...groups.values()], alsoFixed, before, after, regressions, verified, technical, runId: info.run_id, images: null, attempts: attempt, flags, manualVerified, manualOverride: !!o.publishUnverified && !verified, evidenceAt: Object.fromEntries([...evidence].map(([id, ev]) => [id, ev.at])) }));
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
      f.fix = { branch, base: baseBranch, pr_url: prUrl, verified: isSel ? verified : true, fixed_by: isSel ? scopeLabel : `${scopeLabel} (side effect)`, job_id: rep.status.id, at: now, verification: evidence.get(f.id) ?? null, flags: isSel ? flags.filter((x) => x.startsWith(`${f.id}:`) || !/^BB-\d+:/.test(x)) : [], blocked: isSel && blocked, manual_review: keep ? (f.fix?.manual_review ?? null) : null, manual_after: keep ? (f.fix?.manual_after ?? null) : null };
      memory.setBugStatus(f.fingerprint, 'fixing', info.run_id, f.id);
    }
    writeFindings(o.runDir, { run_id: fresh.run_id, target: fresh.target, generated_at: fresh.generated_at, groups: fresh.groups });
    writeReport(o.runDir);
    say('record', `Done: ${verified ? 'verified ✓' : 'NOT fully verified ✗'}${alsoFixed.length ? `; also fixed ${alsoFixed.join(', ')}` : ''}`, verified ? 'success' : 'warn');
    return { branch, prUrl, verified, alsoFixed, worktree, publishError, flags };
  } catch (e) {
    if (mode !== 'verify') restoreStatus(o.runDir, selected, rep.status.id);
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
    f.fix = { branch: fix.branch, base: fix.base, pr_url: null, verified: false, fixed_by: fix.scope, job_id: fix.job_id, at: new Date().toISOString(), verification: f.fix?.verification ?? null, flags: f.fix?.flags ?? [], blocked: false, manual_after: f.fix?.branch === fix.branch ? f.fix.manual_after : null };
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
- You have live browser MCP tools named fix_chromium, fix_webkit or fix_firefox for the affected browsers, connected to this worktree's dev server. Start with observe. Reproduce the reported interaction before editing, then reload and repeat it after editing; inspect screenshots and run_detectors at the affected sizes. Use set_device for phones/tablets rather than only resizing a desktop window. Apply the finding's variant settings and confirm the actual viewport in observe. After changing devices, inspect state and reopen menus as needed.
- Browser probes require log_hypothesis after eight probes; use it to record the result and continue. Treat detector candidates as hints and compare the specific expected/actual behavior visually. If browser verification fails or conflicts with the detector, report the exact condition and evidence rather than claiming success. The pipeline also performs independent verification after you finish.
- Don't run git. Don't create new files unless required.
- Finish with a short summary: root cause, what you changed (file:line), browser/device/viewport checks actually performed and saved screenshot paths, plus any remaining failures or untested conditions.`;

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

/**
 * Before/after pictures hosted by GitHub (user-attachments, like dragging an image into a PR), so nothing is
 * committed. Needs a connected GitHub session; without one, or if GitHub refuses, the PR goes out without pictures.
 */
async function attachImages(nwo: string, pageUrl: string, selected: Finding[], runDir: string, assetsDir: string, say: (stage: string, msg: string, level?: JobEvent['level']) => void, current = false) {
  if (!nwo) return null;
  // current: the after picture the person reviewed (a manually chosen one first), not a freshly captured one.
  const afterOf = (f: Finding) => {
    const saved = f.fix?.manual_after?.path ?? f.fix?.verification?.after?.annotated;
    return current && saved ? join(runDir, saved) : join(assetsDir, `${f.id}-after.png`);
  };
  const files = selected.flatMap((f) => [
    ...(f.video?.gif ? [{ path: join(runDir, f.video.gif), name: `${f.id}-before.gif` }] : f.screenshots.annotated ? [{ path: join(runDir, f.screenshots.annotated), name: `${f.id}-before.png` }] : []),
    ...(existsSync(afterOf(f)) ? [{ path: afterOf(f), name: `${f.id}-after.png` }] : []),
  ]);
  try {
    const { uploadToGitHub } = await import('./githubImages.js');
    say('pr', `Uploading ${files.length} before/after image(s) to GitHub's image hosting (not committed)`);
    const images = await uploadToGitHub(pageUrl, files);
    say('pr', `Attached ${images.size} image(s)`, 'success');
    return images;
  } catch (e) {
    say('pr', `No pictures in the PR: ${(e as Error).message}`, 'warn');
    return null;
  }
}

/** Reasons a fix can't be fully trusted yet, one line each (prefixed with the bug id when it's about one bug). */
/** A finding's saved verification as a check result (for publishing with the evidence the person reviewed). */
export function savedResult(f: Finding): VerifyResult {
  const v = f.fix?.verification;
  return { id: f.id, verifiable: !!v?.checks.length, present: !v || v.result === 'inconclusive' ? null : v.result === 'present', method: v?.method ?? 'none', checks: v?.checks ?? [], review: v?.review ?? null, after: null };
}

export function verificationFlags(selected: Finding[], after: VerifyResult[], evidence: Map<string, FixVerification>, regressions: string[]): string[] {
  const out: string[] = [];
  for (const f of selected) {
    const a = after.find((x) => x.id === f.id);
    const ev = evidence.get(f.id);
    if (!a || a.present === null) out.push(`${f.id}: couldn't confirm the fix automatically`);
    else if (a.present) out.push(`${f.id}: the bug is still present`);
    else if (a.method === 'visual-review') out.push(`${f.id}: verified only by a visual review (${Math.round((a.review?.confidence ?? 0) * 100)}% confident), not by a detector`);
    const unsure = (a?.checks ?? []).filter((c) => c.present === null);
    if (a && a.present !== null && unsure.length) out.push(`${f.id}: some checks were inconclusive (${unsure.map((c) => `${c.browser} ${c.width}px${c.error ? `: ${c.error}` : ''}`).join(', ')})`);
    if (!ev?.after?.annotated) out.push(`${f.id}: no after-fix screenshot`);
    else if (!ev.after.element_found) out.push(`${f.id}: the after-fix screenshot couldn't find the element, so it shows its old position`);
    if (needsVideo(f) && !ev?.after_video?.mp4) out.push(`${f.id}: behaviour bug without an after-fix video`);
  }
  if (regressions.length) out.push(`${regressions.length} new layout problem(s) on the pages it touched`);
  return out;
}
