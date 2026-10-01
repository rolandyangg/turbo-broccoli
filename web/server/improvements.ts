import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listImprovementRuns, backlog, priors, rejected, decide, type Decision } from '../../src/learn/proposals.ts';
import { benchHistory } from '../../src/bench.ts';
import { readRun } from '../../src/store/store.ts';
import { workspaces, workspaceById, HttpError } from './workspaces.ts';
import { listJobs, launchJob } from './jobs.ts';

/** Everything the Improvements page shows: proposals per run, the backlog, approved priors and the bench gate. */
export function improvementsOverview() {
  const runs = [];
  const items = [];
  let pending = 0;
  for (const w of workspaces()) {
    for (const f of listImprovementRuns(w.path)) {
      let name: string | null = null;
      let target = '';
      try {
        const info = readRun(join(w.path, 'runs', f.run));
        name = info.name ?? null;
        target = info.target;
      } catch {}
      pending += f.proposals.filter((p) => p.status === 'pending').length;
      runs.push({ ws: w.id, run: f.run, name, target, retro: f.retro, proposals: f.proposals });
    }
    for (const b of backlog(w.path)) items.push({ ws: w.id, ...b });
  }
  runs.sort((a, b) => b.run.localeCompare(a.run));
  const ws = workspaces();
  const jobs = listJobs().filter((j) => j.kind === 'retro' || j.kind === 'improve');
  return {
    pending,
    runs,
    backlog: items,
    priors: ws.flatMap((w) => priors(w.path).map((p) => ({ ws: w.id, ...p }))),
    rejected: ws.reduce((a, w) => a + rejected(w.path).length, 0),
    lessons: ws.map((w) => ({ ws: w.id, path: w.path, text: lessonsOf(w.path) })).filter((x) => x.text),
    bench: benchHistory(),
    jobs: jobs.slice(0, 20),
  };
}

const lessonsOf = (wsPath: string) => {
  const f = join(wsPath, 'memory', 'lessons.md');
  return existsSync(f) ? readFileSync(f, 'utf8').slice(-6000) : '';
};

export function decideProposal(wsParam: string, run: string, id: string, d: Decision) {
  if (!['approve', 'reject'].includes(d.action)) throw new HttpError(400, 'action must be approve or reject');
  if (!/^P-[\w-]+$/.test(id)) throw new HttpError(400, 'Bad proposal id');
  const w = workspaceById(wsParam);
  try {
    return decide(w.path, run, id, { action: d.action, title: d.title?.slice(0, 300), body: d.body?.slice(0, 4000), note: d.note?.slice(0, 500) ?? null });
  } catch (e) {
    throw new HttpError(/No proposal/.test((e as Error).message) ? 404 : 409, (e as Error).message);
  }
}

export function launchRetro(wsParam: string, run: string, runDir: string) {
  const busy = listJobs({ runDir }).find((j) => j.kind === 'retro' && j.alive);
  if (busy) throw new HttpError(409, `A retrospective (${busy.id}) is already running for this run`);
  void wsParam;
  return launchJob('retro', ['retro', '--run', runDir], { run_dir: runDir, scope: run });
}

/** Several backlog items (or every open/failed one) on one branch, one commit each. */
export function launchImplementBatch(wsParam: string, b: { ids?: string[]; all?: boolean; pr?: boolean; confirmPush?: boolean }) {
  if (b.pr && !b.confirmPush) throw new HttpError(400, 'Opening a PR pushes to GitHub: confirmPush must be true');
  const w = workspaceById(wsParam);
  const items = backlog(w.path);
  const ids = b.all ? items.filter((x) => x.status === 'open' || x.status === 'failed').map((x) => x.id) : (b.ids ?? []).map((x) => String(x).toUpperCase());
  if (!ids.length) throw new HttpError(400, b.all ? 'Nothing open on the backlog' : 'Pick at least one backlog item');
  if (ids.length > 30 || !ids.every((x) => /^B-\d+$/.test(x))) throw new HttpError(400, 'Bad backlog ids');
  for (const id of ids) if (!items.some((x) => x.id === id)) throw new HttpError(404, `No backlog item ${id}`);
  const busy = listJobs().find((j) => j.kind === 'improve' && j.alive && ((j.options as { backlog_ids?: string[] }).backlog_ids ?? [(j.options as { backlog_id?: string }).backlog_id]).some((x) => x && ids.includes(x)));
  if (busy) throw new HttpError(409, `Some of these are already being implemented (${busy.id})`);
  const args = ['improve', ...ids, '--out', w.path];
  if (b.pr) args.push('--pr');
  return launchJob('improve', args, { scope: ids.length === 1 ? ids[0] : `${ids.length} items: ${ids.join(', ')}`, options: { pr: !!b.pr, backlog_ids: ids, ws: w.id } });
}

export function launchImplement(wsParam: string, id: string, b: { pr?: boolean; confirmPush?: boolean }) {
  if (!/^B-\d+$/.test(id)) throw new HttpError(400, 'Bad backlog id');
  if (b.pr && !b.confirmPush) throw new HttpError(400, 'Opening a PR pushes to GitHub: confirmPush must be true');
  const w = workspaceById(wsParam);
  const item = backlog(w.path).find((x) => x.id === id);
  if (!item) throw new HttpError(404, `No backlog item ${id}`);
  const busy = listJobs().find((j) => j.kind === 'improve' && j.alive && ((j.options as { backlog_ids?: string[] }).backlog_ids ?? [(j.options as { backlog_id?: string }).backlog_id]).includes(id));
  if (busy) throw new HttpError(409, `${id} is already being implemented (${busy.id})`);
  const args = ['improve', id, '--out', w.path];
  if (b.pr) args.push('--pr');
  return launchJob('improve', args, { scope: `${id}: ${item.title}`, options: { pr: !!b.pr, backlog_id: id, ws: w.id } });
}
