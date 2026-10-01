import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { runClaude } from '../llm/claude.js';
import { JobReporter, newJobId, describeAgentEvent, type JobEvent } from '../jobs/events.js';
import { backlog, updateBacklogItem, type BacklogItem } from './proposals.js';

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

/** Implements a backlog item on `improve/<id>-<slug>`; never touches the current checkout. */
export async function implementBacklogItem(o: ImplementOptions) {
  const item = backlog(o.ws).find((b) => b.id === o.id);
  if (!item) throw new Error(`No backlog item ${o.id}`);
  const repo = o.repoRoot ?? ROOT;
  const rep = new JobReporter(join(o.ws, 'improvements', 'jobs'), o.jobId ?? newJobId('improve'), 'improve', { scope: `${item.id}: ${item.title}`, options: { pr: o.pr, backlog_id: item.id, ws: o.ws } });
  const say = (stage: string, msg: string, level: JobEvent['level'] = 'info', data?: Record<string, unknown>) => {
    if (level !== 'agent') o.log(msg);
    rep.event(stage, msg, level, data);
  };
  const branch = `improve/${item.id.toLowerCase()}-${slug(item.title)}`;
  const worktree = join(dirname(repo), `${basename(repo)}-improve-worktrees`, branch.replace(/\//g, '__'));
  let base = 'main';
  updateBacklogItem(o.ws, item.id, { status: 'implementing', branch, job_id: rep.status.id, error: null });
  try {
    base = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
    if (existsSync(worktree)) throw new Error(`Worktree already exists: ${worktree}`);
    if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0) throw new Error(`Branch ${branch} already exists`);
    const wt = await git(repo, ['worktree', 'add', '-b', branch, worktree, base]);
    if (wt.exitCode !== 0) throw new Error(`git worktree add failed: ${wt.stderr}`);
    rep.update({ branch, base, worktree });
    say('worktree', `Created ${branch} from ${base}`, 'success', { branch, worktree });
    for (const nm of ['node_modules', 'web/node_modules']) if (existsSync(join(repo, nm)) && !existsSync(join(worktree, nm))) symlinkSync(join(repo, nm), join(worktree, nm), 'dir');

    let feedback = '';
    let verified = false;
    let summary = '';
    for (let attempt = 1; attempt <= o.maxAttempts && !verified; attempt++) {
      say('agent', `Attempt ${attempt}: implementing`);
      const r = await runClaude({
        prompt: prompt(item, feedback),
        systemPrompt: SYSTEM,
        tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
        cwd: worktree,
        timeoutMs: 20 * 60_000,
        transcriptPath: join(o.ws, 'improvements', 'transcripts', `${item.id}-attempt-${attempt}.jsonl`),
        onEvent: (e) => {
          for (const d of describeAgentEvent(e)) rep.event('agent', d.msg, 'agent', d.data);
        },
      });
      summary = r.text;
      if (!r.ok) throw new Error(r.error ?? 'Agent failed');
      const diff = (await git(worktree, ['status', '--porcelain'])).stdout.trim();
      if (!diff) {
        feedback = 'You made no changes. Implement the item.';
        continue;
      }
      say('verify', 'Running typecheck and tests');
      const failures: string[] = [];
      for (const cmd of o.checks ?? DEFAULT_CHECKS) {
        const res = await execa(cmd[0], cmd.slice(1), { cwd: worktree, reject: false, all: true, timeout: 15 * 60_000 });
        if (res.exitCode !== 0) failures.push(`$ ${cmd.join(' ')} (exit ${res.exitCode})\n${String(res.all ?? '').slice(-4000)}`);
      }
      verified = failures.length === 0;
      say('verify', verified ? 'Typecheck and tests pass' : `Verification failed (${failures.length} check(s))`, verified ? 'success' : 'warn');
      feedback = failures.join('\n\n');
    }
    const changed = (await git(worktree, ['status', '--porcelain'])).stdout.trim();
    if (!changed) throw new Error('No changes were made');
    await git(worktree, ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude)web/node_modules']);
    const type = item.kind === 'detector' ? 'feat(detect)' : 'feat(learn)';
    const msg = `${type}: ${item.title.replace(/\.$/, '').slice(0, 72)}\n\nImplements approved backlog item ${item.id} (proposal ${item.proposal_id}, run ${item.run}).\n${verified ? 'Typecheck and tests pass.' : 'Verification did NOT pass; review before merging.'}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
    const c = await git(worktree, ['commit', '-m', msg]);
    if (c.exitCode !== 0) throw new Error(`git commit failed: ${c.stderr}`);
    say('commit', `Committed on ${branch}`, 'success');
    let prUrl: string | null = null;
    if (o.pr) {
      const push = await git(worktree, ['push', '-u', 'origin', branch]);
      if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr}`);
      const bodyFile = join(worktree, '..', `${basename(worktree)}-pr.md`);
      mkdirSync(dirname(bodyFile), { recursive: true });
      writeFileSync(bodyFile, `## Summary\n\n${summary.slice(0, 3000)}\n\n## Backlog item\n\n${item.id}: ${item.title}\n\n${item.body}\n\n## Verification\n\n${verified ? '✅ Typecheck and tests pass.' : '⚠️ Typecheck/tests did not pass.'}\n\nConsider running \`bugbash bench\` on this branch to check recall before merging.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`);
      const pr = await execa('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', `${type}: ${item.title.slice(0, 80)}`, '--body-file', bodyFile], { cwd: worktree, reject: false });
      if (pr.exitCode !== 0) throw new Error(`gh pr create failed: ${pr.stderr}`);
      prUrl = pr.stdout.trim().split('\n').pop() ?? null;
      say('pr', `Opened ${prUrl}`, 'success', { pr_url: prUrl });
    }
    updateBacklogItem(o.ws, item.id, { status: verified ? 'implemented' : 'failed', pr_url: prUrl, error: verified ? null : 'Typecheck/tests failed; the branch has the last attempt' });
    rep.finish(verified ? 'succeeded' : 'failed', { verified, pr_url: prUrl, summary: verified ? `Implemented on ${branch}` : undefined, error: verified ? null : 'Typecheck/tests failed' });
    return { branch, verified, prUrl, worktree };
  } catch (e) {
    const msg = (e as Error).message;
    updateBacklogItem(o.ws, item.id, { status: 'failed', error: msg.slice(0, 500) });
    rep.finish('failed', { error: msg });
    throw e;
  } finally {
    if (!o.keepWorktree && existsSync(worktree)) await git(repo, ['worktree', 'remove', '--force', worktree]);
  }
}
