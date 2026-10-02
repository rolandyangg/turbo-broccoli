import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { runClaude } from '../llm/claude.js';
import { JobReporter, newJobId, describeAgentEvent, type JobEvent } from '../jobs/events.js';
import { backlog, updateBacklogItem, type BacklogItem } from './proposals.js';
import { notifyDetached } from '../notify/notify.js';

/** The bugbash repo itself: approved detector suggestions and prompt/config tweaks are code changes here. */
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
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
- Don't run git. You can't run commands; the typecheck and tests are run for you after you finish, and failures come back to you.
- Finish with a short summary: what you changed (file:line) and how it implements the item.`;

function prompt(item: BacklogItem, feedback: string, earlier: BacklogItem[] = []) {
  return [
    `# Approved backlog item ${item.id} (${item.kind})`,
    `Title: ${item.title}`,
    `Why (approved by a person): ${item.body}`,
    item.detector ? `Detector: finding type "${item.detector.finding_type}". Sketch: ${item.detector.sketch}` : '',
    item.tweak ? `Tweak target: ${item.tweak.target}. Change: ${item.tweak.change}` : '',
    earlier.length ? `\nThis branch already has these approved items committed (keep them working): ${earlier.map((e) => `${e.id} ${e.title}`).join('; ')}` : '',
    feedback ? `\n# Verification of your previous attempt failed\n${feedback}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Implements one backlog item on `improve/<id>-<slug>`; never touches the current checkout. */
export async function implementBacklogItem(o: ImplementOptions) {
  const r = await implementBacklogItems({ ...o, ids: [o.id] });
  return { branch: r.branch, verified: r.done.length === 1, prUrl: r.prUrl, worktree: r.worktree };
}

export interface BatchOptions extends Omit<ImplementOptions, 'id'> {
  /** Backlog ids to implement on one branch, in order. */
  ids: string[];
}

/**
 * Implements several backlog items on ONE branch, one after another. Each item gets the agent (with typecheck/test
 * feedback, up to maxAttempts) and, when it passes, its own commit. An item that still fails is rolled back and
 * marked failed, and the batch carries on. Pushes and opens one PR at the end only with `pr`.
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
  const scope = single ? `${items[0].id}: ${items[0].title}` : `${items.length} items: ${items.map((i) => i.id).join(', ')}`;
  const rep = new JobReporter(join(o.ws, 'improvements', 'jobs'), o.jobId ?? newJobId('improve'), 'improve', { scope, options: { pr: o.pr, backlog_id: single ? items[0].id : null, backlog_ids: items.map((i) => i.id), ws: o.ws } });
  const say = (stage: string, msg: string, level: JobEvent['level'] = 'info', data?: Record<string, unknown>) => {
    if (level !== 'agent') o.log(msg);
    rep.event(stage, msg, level, data);
  };
  const stamp = new Date().toISOString().slice(0, 10);
  let branch = single ? `improve/${items[0].id.toLowerCase()}-${slug(items[0].title)}` : `improve/batch-${stamp}-${items.map((i) => i.id.toLowerCase()).join('-')}`.slice(0, 90);
  const branchExists = async (b: string) => (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])).exitCode === 0;
  for (let n = 2; await branchExists(branch); n++) branch = `${branch.replace(/-\d+$/, '')}-${n}`;
  const worktree = join(dirname(repo), `${basename(repo)}-improve-worktrees`, branch.replace(/\//g, '__'));
  for (const it of items) updateBacklogItem(o.ws, it.id, { status: 'implementing', branch, job_id: rep.status.id, error: null });
  const done: BacklogItem[] = [];
  const failed: { item: BacklogItem; error: string }[] = [];
  const summaries: { item: BacklogItem; summary: string }[] = [];
  let base = 'main';
  let prUrl: string | null = null;
  try {
    base = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
    if (existsSync(worktree)) throw new Error(`Worktree already exists: ${worktree}`);
    const wt = await git(repo, ['worktree', 'add', '-b', branch, worktree, base]);
    if (wt.exitCode !== 0) throw new Error(`git worktree add failed: ${wt.stderr}`);
    rep.update({ branch, base, worktree });
    say('worktree', `Created ${branch} from ${base}${single ? '' : ` for ${items.length} items`}`, 'success', { branch, worktree });
    for (const nm of ['node_modules', 'web/node_modules']) if (existsSync(join(repo, nm)) && !existsSync(join(worktree, nm))) symlinkSync(join(repo, nm), join(worktree, nm), 'dir');

    for (const [i, item] of items.entries()) {
      const stage = single ? 'agent' : `item:${i + 1}`;
      say(stage, `${single ? '' : `[${i + 1}/${items.length}] `}${item.id}: ${item.title}`);
      let feedback = '';
      let verified = false;
      let summary = '';
      let error: string | null = null;
      for (let attempt = 1; attempt <= o.maxAttempts && !verified; attempt++) {
        say(stage, `Attempt ${attempt}: implementing ${item.id}`);
        const r = await runClaude({
          prompt: (o.instructions?.trim() ? `# Instructions from the person (follow them within your rules)\n${o.instructions.trim()}\n\n` : '') + prompt(item, feedback, done),
          systemPrompt: SYSTEM,
          tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
          allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
          cwd: worktree,
          timeoutMs: 20 * 60_000,
          transcriptPath: join(o.ws, 'improvements', 'transcripts', `${item.id}-attempt-${attempt}.jsonl`),
          onEvent: (e) => {
            for (const d of describeAgentEvent(e)) rep.event(stage, d.msg, 'agent', d.data);
          },
        });
        summary = r.text;
        if (!r.ok) {
          error = r.error ?? 'Agent failed';
          break;
        }
        if (!(await git(worktree, ['status', '--porcelain'])).stdout.trim()) {
          feedback = 'You made no changes. Implement the item.';
          error = 'No changes were made';
          continue;
        }
        say(stage, 'Running typecheck and tests');
        const failures: string[] = [];
        for (const cmd of o.checks ?? DEFAULT_CHECKS) {
          // A clean environment: the job's own BUGBASH_* settings (job folder, inbox, home) must not leak into the
          // repo's tests, or they write into the real job folders and fail for reasons unrelated to the change.
          const res = await execa(cmd[0], cmd.slice(1), { cwd: worktree, reject: false, all: true, timeout: 15 * 60_000, extendEnv: false, env: cleanEnv() });
          if (res.exitCode !== 0) failures.push(`$ ${cmd.join(' ')} (exit ${res.exitCode})\n${String(res.all ?? '').slice(-4000)}`);
        }
        verified = failures.length === 0;
        error = verified ? null : 'Typecheck/tests failed';
        say(stage, verified ? 'Typecheck and tests pass' : `Verification failed (${failures.length} check(s)):\n${failures.map((x) => x.split('\n').slice(0, 1).concat(failingLines(x)).join('\n')).join('\n\n')}`, verified ? 'success' : 'warn', verified ? undefined : { output: failures.map((x) => x.slice(-3000)) });
        feedback = failures.join('\n\n');
      }
      if (verified) {
        await git(worktree, ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude)web/node_modules', ':(exclude).bugbash', ':(exclude)**/.bugbash']);
        const type = item.kind === 'detector' ? 'feat(detect)' : 'feat(learn)';
        const msg = `${type}: ${item.title.replace(/\.$/, '').slice(0, 72)}\n\nImplements approved backlog item ${item.id} (proposal ${item.proposal_id}, run ${item.run}).\nTypecheck and tests pass.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
        const c = await git(worktree, ['commit', '-m', msg]);
        if (c.exitCode !== 0) throw new Error(`git commit failed: ${c.stderr}`);
        done.push(item);
        summaries.push({ item, summary });
        updateBacklogItem(o.ws, item.id, { status: 'implemented', error: null });
        say(stage, `Committed ${item.id}`, 'success');
      } else {
        // Roll this item back so the next one starts from the last good commit.
        await git(worktree, ['reset', '-q', '--hard', 'HEAD']);
        await git(worktree, ['clean', '-fdq', '-e', 'node_modules', '-e', 'web/node_modules']);
        failed.push({ item, error: error ?? 'Failed' });
        updateBacklogItem(o.ws, item.id, { status: 'failed', branch: null, error: `${error ?? 'Failed'}${single ? '' : ` (in batch ${branch}; rolled back)`}` });
        say(stage, `${item.id} not implemented: ${error ?? 'failed'}${single ? '' : '. Rolled back; continuing with the next item.'}`, 'warn');
      }
    }

    if (o.pr && done.length) {
      const push = await git(worktree, ['-c', 'http.postBuffer=524288000', 'push', '-u', 'origin', branch]);
      if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`);
      const bodyFile = join(worktree, '..', `${basename(worktree)}-pr.md`);
      mkdirSync(dirname(bodyFile), { recursive: true });
      writeFileSync(bodyFile, prBodyFor(done, failed, summaries));
      const title = single ? `${done[0].kind === 'detector' ? 'feat(detect)' : 'feat(learn)'}: ${done[0].title.slice(0, 80)}` : `feat(learn): ${done.length} approved improvements (${done.map((d) => d.id).join(', ')})`;
      const pr = await execa('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title.slice(0, 120), '--body-file', bodyFile], { cwd: worktree, reject: false });
      if (pr.exitCode !== 0) throw new Error(`gh pr create failed: ${pr.stderr}`);
      prUrl = pr.stdout.trim().split('\n').pop() ?? null;
      for (const d of done) updateBacklogItem(o.ws, d.id, { pr_url: prUrl });
      say('pr', `Opened ${prUrl}`, 'success', { pr_url: prUrl });
    }
    if (!done.length) await git(repo, ['branch', '-D', branch]); // nothing landed: don't leave an empty branch
    const summary = `${done.length}/${items.length} implemented${done.length ? ` on ${branch}` : ''}${failed.length ? `; failed: ${failed.map((f) => f.item.id).join(', ')}` : ''}`;
    if (done.length) notifyDetached({ event: 'fix', level: failed.length ? 'warn' : 'success', title: single ? `Improvement implemented: ${done[0].id}` : `${done.length} improvement(s) implemented`, body: `${summary}${prUrl ? `\nPR: ${prUrl}` : ' (not pushed)'}. Typecheck and tests pass for each.`, path: '/improvements?tab=backlog' });
    rep.finish(done.length ? 'succeeded' : 'failed', { verified: failed.length === 0, pr_url: prUrl, summary, error: done.length ? (failed.length ? `Not implemented: ${failed.map((f) => `${f.item.id} (${f.error})`).join('; ')}` : null) : `Nothing implemented: ${failed.map((f) => `${f.item.id} (${f.error})`).join('; ')}` });
    return { branch, done, failed, prUrl, worktree };
  } catch (e) {
    const msg = (e as Error).message;
    for (const it of items) if (!done.includes(it) && !failed.some((f) => f.item === it)) updateBacklogItem(o.ws, it.id, { status: 'failed', error: msg.slice(0, 500) });
    rep.finish('failed', { error: msg });
    throw e;
  } finally {
    if (!o.keepWorktree && existsSync(worktree)) await git(repo, ['worktree', 'remove', '--force', worktree]);
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
