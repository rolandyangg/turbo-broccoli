import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { runAgent } from '../llm/runner.js';
import { JobReporter, newJobId, describeAgentEvent, type JobEvent } from '../jobs/events.js';
import { backlog, updateBacklogItem, type BacklogItem } from './proposals.js';
import { notifyDetached } from '../notify/notify.js';

/** The bugbash repo itself: approved detector suggestions and prompt/config tweaks are code changes here. */
export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const git = (cwd: string, args: string[]) => execa('git', args, { cwd, reject: false });
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export interface ImplementOptions {
  ws: string;
  id: string;
  /** Push each item's branch and open a PR for it instead of merging it into the base branch. */
  pr: boolean;
  maxAttempts: number;
  keepWorktree: boolean;
  log: (m: string) => void;
  jobId?: string | null;
  /** Override for tests. */
  repoRoot?: string;
  /** The person's instructions for the implementing agent. */
  instructions?: string | null;
  /** Verification commands (default: typecheck + unit and detector tests). */
  checks?: string[][];
  /** Merge each passing item into the base branch automatically (default true; ignored with `pr`). */
  merge?: boolean;
  /** Agents working at the same time, one item each (1-6, default 2). */
  parallel?: number;
  /** Branch the items start from and merge into (default: the branch checked out in the repo). */
  base?: string | null;
  /** The implementing agent (tests replace it). */
  agent?: (a: { prompt: string; systemPrompt: string; cwd: string; transcriptPath: string; onEvent: (e: unknown) => void }) => Promise<{ ok: boolean; text: string; error?: string | null }>;
}

const DEFAULT_CHECKS = [
  ['npx', 'tsc', '--noEmit', '-p', '.'],
  ['npx', 'vitest', 'run', 'test/units.test.ts', 'test/detectors.test.ts', 'test/detectors-lab.test.ts'],
];

const SYSTEM = `You implement one approved improvement to "bugbash", an agentic UI bug-bashing tool (TypeScript, Playwright, headless Claude agents). You are in a git worktree on a dedicated branch of its repo.
Where things live:
- In-page detectors: src/detect/inpage.js (plain browser JS; each detector returns cand(type, el, confidence, message, metrics)). Wire new ones into detect(). New finding types go in FindingType (src/store/schema.ts); replay-verifiable types go in DETECTABLE (src/triage/replay.ts).
- Seeded test pages: fixtures/detector-lab/*.html with tests in test/detectors-lab.test.ts (add a positive and a negative case for any detector change).
- Prompts: src/explore/prompts/explorer.md, lead.md, personas/*.md. Config defaults: src/config.ts. Strategy catalog: src/explore/strategies.ts. Triage: src/triage/*.
Rules:
- Make the smallest change that implements the item as approved. Match the surrounding code style. Don't touch unrelated code or dependencies.
- Before adding something, check it doesn't already exist (an existing detector or rule may already cover part of the item); extend it instead of duplicating it.
- Other agents are implementing other items in parallel and their changes get merged into the same base: keep your edits local to what the item needs, so merges stay clean.
- Don't run git. You can't run commands; the typecheck and tests are run for you after you finish, and failures come back to you.
- Finish with a short summary: what you changed (file:line) and how it implements the item.`;

function prompt(item: BacklogItem, feedback: string) {
  return [
    `# Approved backlog item ${item.id} (${item.kind})`,
    `Title: ${item.title}`,
    `Why (approved by a person): ${item.body}`,
    item.detector ? `Detector: finding type "${item.detector.finding_type}". Sketch: ${item.detector.sketch}` : '',
    item.tweak ? `Tweak target: ${item.tweak.target}. Change: ${item.tweak.change}` : '',
    feedback ? `\n# Verification of your previous attempt failed\n${feedback}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Implements one backlog item on `improve/<id>-<slug>` and merges it when it passes; never touches your files otherwise. */
export async function implementBacklogItem(o: ImplementOptions) {
  const r = await implementBacklogItems({ ...o, ids: [o.id] });
  const it = r.results[0];
  return { branch: it?.branch ?? null, verified: !!it && it.outcome !== 'failed', merged: it?.outcome === 'merged', prUrl: it?.pr_url ?? null };
}

export interface BatchOptions extends Omit<ImplementOptions, 'id'> {
  /** Backlog ids to implement (in parallel up to `parallel`, merged in the order they finish). */
  ids: string[];
}

export interface ItemResult {
  id: string;
  title: string;
  /** merged: in the base branch. branch: passed, left on its branch (merging off, a PR, or an issue below). failed: not implemented. */
  outcome: 'merged' | 'branch' | 'failed';
  branch: string | null;
  sha: string | null;
  pr_url: string | null;
  /** Why it wasn't merged or implemented. */
  issue: string | null;
  summary: string;
}

/** One-at-a-time section (merges into the base branch never overlap). */
function mutex() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = last.then(fn, fn);
    last = run.catch(() => {});
    return run;
  };
}

/**
 * Implements backlog items with up to `parallel` agents at once, each item on its own branch and worktree. An item is
 * committed once typecheck and tests pass, then (by default) merged into the base branch: rebased onto its latest
 * tip (merge conflicts go back to the agent), re-checked, and fast-forwarded in. Anything that gets in the way (a
 * conflict it can't resolve, failing checks after the rebase, your uncommitted edits to the same files) leaves the
 * item on its branch with the reason; items that still fail their checks are dropped and marked failed.
 */
export async function implementBacklogItems(o: BatchOptions) {
  const all = backlog(o.ws);
  const items = o.ids.map((id) => {
    const it = all.find((b) => b.id === id);
    if (!it) throw new Error(`No backlog item ${id}`);
    return it;
  });
  if (!items.length) throw new Error('No backlog items to implement');
  const repo = o.repoRoot ?? ROOT;
  const single = items.length === 1;
  const parallel = Math.max(1, Math.min(6, Math.floor(o.parallel ?? 2)));
  const merge = !o.pr && o.merge !== false;
  const scope = single ? `${items[0].id}: ${items[0].title}` : `${items.length} items: ${items.map((i) => i.id).join(', ')}`;
  const rep = new JobReporter(join(o.ws, 'improvements', 'jobs'), o.jobId ?? newJobId('improve'), 'improve', { scope, options: { pr: o.pr, merge, parallel, backlog_id: single ? items[0].id : null, backlog_ids: items.map((i) => i.id), ws: o.ws } });
  const say = (stage: string, msg: string, level: JobEvent['level'] = 'info', data?: Record<string, unknown>) => {
    if (level !== 'agent') o.log(msg);
    rep.event(stage, msg, level, data);
  };
  const results: ItemResult[] = [];
  const worktrees = new Set<string>();
  // Cancelled from the web app: items not finished yet go back to open (not "implementing" forever).
  process.once('SIGTERM', () => {
    for (const it of items) if (!results.some((r) => r.id === it.id)) updateBacklogItem(o.ws, it.id, { status: 'open', branch: null, job_id: null, error: null });
    rep.finish('cancelled', { error: 'cancelled' });
    process.exit(143);
  });
  for (const it of items) updateBacklogItem(o.ws, it.id, { status: 'implementing', branch: null, job_id: rep.status.id, error: null });
  const base = o.base ?? ((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main');
  if (base === 'HEAD') throw new Error('The repo is on a detached HEAD: pass a base branch to merge into');
  rep.update({ base });
  say('plan', `${items.length} item${single ? '' : 's'} with up to ${parallel} agent${parallel > 1 ? 's' : ''} at once; ${o.pr ? 'each passing item gets its own pull request' : merge ? `each passing item is merged into ${base}` : 'each passing item stays on its own branch'}`, 'info', { parallel, merge, pr: o.pr, base });
  const serial = mutex();
  const branchExists = async (b: string) => (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).exitCode === 0;

  const runChecks = async (cwd: string) => {
    const failures: string[] = [];
    for (const cmd of o.checks ?? DEFAULT_CHECKS) {
      // A clean environment: the job's own BUGBASH_* settings (job folder, inbox, home) must not leak into the
      // repo's tests, or they write into the real job folders and fail for reasons unrelated to the change.
      const res = await execa(cmd[0], cmd.slice(1), { cwd, reject: false, all: true, timeout: 15 * 60_000, extendEnv: false, env: cleanEnv() });
      if (res.exitCode !== 0) failures.push(`$ ${cmd.join(' ')} (exit ${res.exitCode})\n${String(res.all ?? '').slice(-4000)}`);
    }
    return failures;
  };
  const describeFailures = (failures: string[]) => failures.map((x) => x.split('\n').slice(0, 1).concat(failingLines(x)).join('\n')).join('\n\n');
  const agent =
    o.agent ??
    ((a) =>
      runAgent({ prompt: a.prompt, systemPrompt: a.systemPrompt, tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], cwd: a.cwd, timeoutMs: 20 * 60_000, transcriptPath: a.transcriptPath, onEvent: a.onEvent as never }));
  const steer = o.instructions?.trim() ? `# Instructions from the person (follow them within your rules)\n${o.instructions.trim()}\n\n` : '';

  async function implementOne(item: BacklogItem): Promise<ItemResult> {
    const stage = `item:${item.id}`;
    const res: ItemResult = { id: item.id, title: item.title, outcome: 'failed', branch: null, sha: null, pr_url: null, issue: null, summary: '' };
    // Branch and worktree setup touch the shared repo: one item at a time.
    const { branch, worktree } = await serial(async () => {
      let b = `improve/${item.id.toLowerCase()}-${slug(item.title)}`;
      for (let n = 2; await branchExists(b); n++) b = `${b.replace(/-\d+$/, '')}-${n}`;
      const w = join(dirname(repo), `${basename(repo)}-improve-worktrees`, b.replace(/\//g, '__'));
      if (existsSync(w)) throw new Error(`Worktree already exists: ${w}`);
      const wt = await git(repo, ['worktree', 'add', '-b', b, w, base]);
      if (wt.exitCode !== 0) throw new Error(`git worktree add failed: ${wt.stderr}`);
      return { branch: b, worktree: w };
    });
    worktrees.add(worktree);
    res.branch = branch;
    updateBacklogItem(o.ws, item.id, { branch });
    for (const nm of ['node_modules', 'web/node_modules']) if (existsSync(join(repo, nm)) && !existsSync(join(worktree, nm))) symlinkSync(join(repo, nm), join(worktree, nm), 'dir');
    say(stage, `${item.id}: ${item.title} (on ${branch})`, 'info', { branch, worktree });

    let feedback = '';
    let verified = false;
    for (let attempt = 1; attempt <= o.maxAttempts && !verified; attempt++) {
      say(stage, `${item.id} attempt ${attempt}: the agent is implementing it`);
      const r = await agent({ prompt: steer + prompt(item, feedback), systemPrompt: SYSTEM, cwd: worktree, transcriptPath: join(o.ws, 'improvements', 'transcripts', `${item.id}-attempt-${attempt}.jsonl`), onEvent: (e) => { for (const d of describeAgentEvent(e as never)) rep.event(stage, d.msg, 'agent', d.data); } });
      res.summary = r.text;
      if (!r.ok) {
        res.issue = r.error ?? 'Agent failed';
        break;
      }
      if (!(await git(worktree, ['status', '--porcelain'])).stdout.trim()) {
        feedback = 'You made no changes. Implement the item.';
        res.issue = 'No changes were made';
        continue;
      }
      say(stage, `${item.id}: running typecheck and tests`);
      const failures = await runChecks(worktree);
      verified = failures.length === 0;
      res.issue = verified ? null : 'Typecheck/tests failed';
      say(stage, verified ? `${item.id}: typecheck and tests pass` : `${item.id}: verification failed (${failures.length} check(s)):\n${describeFailures(failures)}`, verified ? 'success' : 'warn', verified ? undefined : { output: failures.map((x) => x.slice(-3000)) });
      feedback = failures.join('\n\n');
    }
    if (!verified) {
      updateBacklogItem(o.ws, item.id, { status: 'failed', branch: null, error: res.issue ?? 'Failed' });
      say(stage, `${item.id} not implemented: ${res.issue ?? 'failed'}`, 'warn');
      await serial(async () => {
        await git(repo, ['worktree', 'remove', '--force', worktree]);
        await git(repo, ['branch', '-D', branch]);
      });
      worktrees.delete(worktree);
      res.branch = null;
      return res;
    }
    await git(worktree, ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude)web/node_modules', ':(exclude).bugbash', ':(exclude)**/.bugbash']);
    const type = item.kind === 'detector' ? 'feat(detect)' : 'feat(learn)';
    const msg = `${type}: ${item.title.replace(/\.$/, '').slice(0, 72)}\n\nImplements approved backlog item ${item.id} (proposal ${item.proposal_id}, run ${item.run}).\nTypecheck and tests pass.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
    const c = await git(worktree, ['commit', '-m', msg]);
    if (c.exitCode !== 0) throw new Error(`git commit failed: ${c.stderr}`);
    res.outcome = 'branch';
    res.sha = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    say(stage, `Committed ${item.id} on ${branch}`, 'success', { sha: res.sha });

    if (o.pr) {
      res.pr_url = await openPr(item, branch, worktree, res.summary, stage);
      updateBacklogItem(o.ws, item.id, { status: 'implemented', pr_url: res.pr_url, error: res.pr_url ? null : 'Committed, but the pull request could not be opened' });
    } else if (merge) await serial(() => mergeIn(item, branch, worktree, res, stage));
    else updateBacklogItem(o.ws, item.id, { status: 'implemented', error: null });
    return res;
  }

  /** Rebase onto the base's latest tip (conflicts go to the agent), re-check if anything moved, fast-forward the base. */
  async function mergeIn(item: BacklogItem, branch: string, worktree: string, res: ItemResult, stage: string) {
    const keep = (issue: string) => {
      res.issue = issue;
      updateBacklogItem(o.ws, item.id, { status: 'implemented', error: `Not merged: ${issue}. It is on ${branch}.` });
      say(stage, `${item.id} stays on ${branch}: ${issue}`, 'warn');
    };
    const tip = (await git(repo, ['rev-parse', `refs/heads/${base}`])).stdout.trim();
    const forkPoint = (await git(worktree, ['merge-base', 'HEAD', tip])).stdout.trim();
    if (forkPoint !== tip) {
      say(stage, `${item.id}: ${base} moved on (other items merged); rebasing onto it`);
      const rb = await git(worktree, ['rebase', tip]);
      if (rb.exitCode !== 0) {
        const conflicted = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
        say(stage, `${item.id}: merge conflicts in ${conflicted.join(', ') || 'some files'}; the agent is resolving them`, 'warn', { conflicted });
        const r = await agent({
          prompt: `${prompt(item, '')}\n\n# Resolve merge conflicts\nYour change for ${item.id} is being rebased onto ${base}, which now also has other approved improvements. These files have git conflict markers (<<<<<<< ======= >>>>>>>): ${conflicted.join(', ')}.\nEdit each file so it keeps BOTH sides: everything already in ${base} and your change for ${item.id}. Remove every conflict marker. Don't change anything else.`,
          systemPrompt: SYSTEM,
          cwd: worktree,
          transcriptPath: join(o.ws, 'improvements', 'transcripts', `${item.id}-conflicts.jsonl`),
          onEvent: (e) => { for (const d of describeAgentEvent(e as never)) rep.event(stage, d.msg, 'agent', d.data); },
        });
        const markers = conflicted.length ? (await git(worktree, ['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>)', '--', ...conflicted])).stdout.trim() : '';
        if (!r.ok || markers || !conflicted.length) {
          await git(worktree, ['rebase', '--abort']);
          return keep(`it conflicts with changes merged into ${base} meanwhile${markers ? ` (conflict markers left in ${markers.split('\n').join(', ')})` : ''}`);
        }
        await git(worktree, ['add', '-A', '--', ...conflicted]);
        const cont = await execa('git', ['rebase', '--continue'], { cwd: worktree, reject: false, env: { GIT_EDITOR: 'true' } });
        if (cont.exitCode !== 0) {
          await git(worktree, ['rebase', '--abort']);
          return keep(`the rebase onto ${base} could not be completed`);
        }
        say(stage, `${item.id}: conflicts resolved`, 'success');
      }
      say(stage, `${item.id}: re-running typecheck and tests on top of ${base}`);
      const failures = await runChecks(worktree);
      if (failures.length) {
        say(stage, `${item.id}: checks fail after the rebase:\n${describeFailures(failures)}`, 'warn', { output: failures.map((x) => x.slice(-3000)) });
        return keep(`typecheck/tests fail together with the other changes in ${base}`);
      }
    }
    const sha = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
    // Fast-forward the base: in the worktree that has it checked out (your files stay as they are unless the merge
    // needs to change a file you have uncommitted edits to, in which case git refuses), or just the ref.
    const list = (await git(repo, ['worktree', 'list', '--porcelain'])).stdout;
    const holder = list.split('\n\n').find((b) => b.includes(`branch refs/heads/${base}`))?.match(/^worktree (.+)$/m)?.[1];
    const ff = holder ? await git(holder, ['merge', '--ff-only', '--quiet', sha]) : await git(repo, ['update-ref', `refs/heads/${base}`, sha, tip]);
    if (ff.exitCode !== 0) {
      const why = /would be overwritten|local changes/i.test(ff.stderr) ? `you have uncommitted edits to files it changes (${ff.stderr.match(/\n\t(.+)/g)?.map((x) => x.trim()).join(', ') ?? 'see the job log'})` : `${base} could not be fast-forwarded (${ff.stderr.trim().split('\n')[0]})`;
      return keep(why);
    }
    res.outcome = 'merged';
    res.sha = sha;
    res.issue = null;
    updateBacklogItem(o.ws, item.id, { status: 'merged', branch: null, error: null });
    say(stage, `Merged ${item.id} into ${base} (${sha.slice(0, 8)})`, 'success', { sha, base });
    if (!o.keepWorktree) {
      await git(repo, ['worktree', 'remove', '--force', worktree]);
      worktrees.delete(worktree);
      await git(repo, ['branch', '-D', branch]); // its commit is in the base now
      res.branch = null;
    }
  }

  async function openPr(item: BacklogItem, branch: string, worktree: string, summary: string, stage: string): Promise<string | null> {
    const push = await git(worktree, ['-c', 'http.postBuffer=524288000', 'push', '-u', 'origin', branch]);
    if (push.exitCode !== 0) {
      say(stage, `${item.id}: git push failed: ${push.stderr.trim()}`, 'warn');
      return null;
    }
    const bodyFile = join(worktree, '..', `${basename(worktree)}-pr.md`);
    mkdirSync(dirname(bodyFile), { recursive: true });
    writeFileSync(bodyFile, prBodyFor([item], [], [{ item, summary }]));
    const title = `${item.kind === 'detector' ? 'feat(detect)' : 'feat(learn)'}: ${item.title.slice(0, 80)}`;
    const pr = await execa('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title.slice(0, 120), '--body-file', bodyFile], { cwd: worktree, reject: false });
    if (pr.exitCode !== 0) {
      say(stage, `${item.id}: gh pr create failed: ${pr.stderr.trim()}`, 'warn');
      return null;
    }
    const url = pr.stdout.trim().split('\n').pop() ?? null;
    say(stage, `Opened ${url}`, 'success', { pr_url: url });
    return url;
  }

  try {
    // A small worker pool: each worker takes the next item until none are left.
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(parallel, items.length) }, async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          try {
            results.push(await implementOne(item));
          } catch (e) {
            const msg = (e as Error).message;
            updateBacklogItem(o.ws, item.id, { status: 'failed', branch: null, error: msg.slice(0, 500) });
            say(`item:${item.id}`, `${item.id} failed: ${msg}`, 'error');
            results.push({ id: item.id, title: item.title, outcome: 'failed', branch: null, sha: null, pr_url: null, issue: msg, summary: '' });
          }
        }
      }),
    );
    results.sort((a, b) => o.ids.indexOf(a.id) - o.ids.indexOf(b.id));
    const merged = results.filter((r) => r.outcome === 'merged');
    const kept = results.filter((r) => r.outcome === 'branch');
    const failed = results.filter((r) => r.outcome === 'failed');
    const summary = [merged.length ? `${merged.length} merged into ${base}` : '', kept.length ? `${kept.length} on ${kept.length === 1 ? 'its branch' : 'their branches'}${kept.some((k) => k.issue) ? ` (${kept.filter((k) => k.issue).map((k) => `${k.id}: ${k.issue}`).join('; ')})` : ''}` : '', failed.length ? `failed: ${failed.map((f) => f.id).join(', ')}` : ''].filter(Boolean).join('; ') || 'nothing implemented';
    const prUrl = results.find((r) => r.pr_url)?.pr_url ?? null;
    const issues = [...kept.filter((k) => k.issue), ...failed];
    if (merged.length || kept.length) notifyDetached({ event: 'fix', level: issues.length ? 'warn' : 'success', title: merged.length ? `${merged.length} improvement(s) merged into ${base}` : `${kept.length} improvement(s) implemented`, body: `${summary}. Typecheck and tests pass for each.`, path: '/improvements?tab=backlog' });
    rep.finish(merged.length || kept.length ? 'succeeded' : 'failed', {
      verified: issues.length === 0,
      pr_url: prUrl,
      summary,
      error: issues.length ? `${issues.map((f) => `${f.id}: ${f.issue ?? 'failed'}`).join('; ')}` : null,
      options: { ...rep.status.options, results },
    });
    return { base, results, merged, kept, failed, prUrl };
  } catch (e) {
    const msg = (e as Error).message;
    for (const it of items) if (!results.some((r) => r.id === it.id)) updateBacklogItem(o.ws, it.id, { status: 'failed', error: msg.slice(0, 500) });
    rep.finish('failed', { error: msg });
    throw e;
  } finally {
    // Merged items' worktrees are already gone; others' branches stay, their worktrees go unless asked to keep them.
    if (!o.keepWorktree) for (const w of worktrees) if (existsSync(w)) await git(repo, ['worktree', 'remove', '--force', w]);
  }
}

function prBodyFor(done: BacklogItem[], failed: { item: BacklogItem; error: string }[], summaries: { item: BacklogItem; summary: string }[]) {
  const lines = ['## Summary', '', `Implements ${done.length} approved improvement${done.length > 1 ? 's' : ''} from the bugbash backlog, one commit each.`, ''];
  for (const d of done) {
    lines.push(`### ${d.id}: ${d.title}`, '', d.body, '');
    if (d.detector) lines.push(`Detector for \`${d.detector.finding_type}\`: ${d.detector.sketch}`, '');
    if (d.tweak) lines.push(`Change to ${d.tweak.target}: ${d.tweak.change}`, '');
    const s = summaries.find((x) => x.item === d)?.summary.trim();
    if (s) lines.push('<details><summary>What the agent changed</summary>', '', s.slice(0, 2500), '', '</details>', '');
  }
  if (failed.length) lines.push('## Not included', '', ...failed.map((f) => `- ${f.item.id}: ${f.item.title} (${f.error})`), '');
  lines.push('## Verification', '', '✅ Typecheck and tests pass after each item.', '', 'Consider running `bugbash bench` on this branch to check recall before merging.', '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)', '');
  return lines.join('\n');
}

/** The current environment minus bugbash's own job settings (BUGBASH_*), for running the repo's checks. */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('BUGBASH_') && k !== 'VITEST') env[k] = v;
  return env;
}

/** The lines of a test/typecheck run that say what failed (for the job page). */
function failingLines(out: string): string[] {
  const lines = out.split('\n').filter((l) => /(×|FAIL|error TS|AssertionError|Error:|expected)/.test(l)).map((l) => l.trim());
  return [...new Set(lines)].slice(0, 8);
}
