import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobEvent, JobKind, JobStatus } from '../../src/jobs/events.ts';
import { workspaces, HttpError, readJsonSafe, locateRunDir, samePath } from './workspaces.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
const CLI = join(REPO_ROOT, 'bin', 'bugbash.js');
/** Every job the web app launches writes its status/events here (BUGBASH_JOB_DIR). */
export const WEB_JOBS = process.env.BUGBASH_WEB_JOBS ?? join(homedir(), '.bugbash', 'web-jobs');

export interface JobView extends JobStatus {
  alive: boolean;
  dir: string;
  run: { ws: string; run: string } | null;
  log_tail: string | null;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every jobs/ folder we know about: web-launched, per-workspace (explore), per-run (fix/triage from the CLI). */
function jobRoots(): string[] {
  const roots = [WEB_JOBS];
  for (const w of workspaces()) {
    roots.push(join(w.path, 'jobs'));
    for (const r of w.runs) roots.push(join(w.path, 'runs', r, 'jobs'));
  }
  return roots.filter((r) => existsSync(r));
}

function view(dir: string): JobView | null {
  const st = readJsonSafe<JobStatus | null>(join(dir, 'status.json'), null);
  if (!st) return null;
  const isAlive = st.state === 'running' && alive(st.pid);
  const logFile = join(dir, 'log.txt');
  let tail: string | null = null;
  if (existsSync(logFile)) {
    const txt = readFileSync(logFile, 'utf8');
    tail = txt.slice(-4000);
  }
  // A "running" job whose process is gone crashed (or was killed) without writing a final state.
  const state = st.state === 'running' && !isAlive ? 'failed' : st.state;
  return { ...st, state, error: state === 'failed' && !st.error ? 'Process exited unexpectedly (see log)' : st.error, alive: isAlive, dir, run: locateRunDir(st.run_dir), log_tail: tail };
}

export function listJobs(filter: { runDir?: string; findingId?: string } = {}): JobView[] {
  const out: JobView[] = [];
  const seen = new Set<string>();
  for (const root of jobRoots()) {
    for (const d of readdirSync(root)) {
      if (seen.has(d)) continue;
      const v = view(join(root, d));
      if (!v) continue;
      seen.add(d);
      if (filter.runDir && !samePath(v.run_dir, filter.runDir)) continue;
      if (filter.findingId && !v.finding_ids.includes(filter.findingId)) continue;
      out.push(v);
    }
  }
  return out.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function getJob(id: string): JobView {
  if (!/^[\w.-]+$/.test(id)) throw new HttpError(400, 'Bad job id');
  for (const root of jobRoots()) {
    const d = join(root, id);
    if (existsSync(join(d, 'status.json'))) return view(d)!;
  }
  throw new HttpError(404, `Unknown job ${id}`);
}

export function readEvents(dir: string, fromByte = 0): { events: JobEvent[]; next: number } {
  const f = join(dir, 'events.jsonl');
  if (!existsSync(f)) return { events: [], next: fromByte };
  const size = statSync(f).size;
  if (size <= fromByte) return { events: [], next: fromByte };
  const buf = Buffer.alloc(size - fromByte);
  const fd = openSync(f, 'r');
  try {
    readSync(fd, buf, 0, buf.length, fromByte);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return { events: [], next: fromByte };
  const events = text
    .slice(0, lastNl)
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as JobEvent];
      } catch {
        return [];
      }
    });
  return { events, next: fromByte + Buffer.byteLength(text.slice(0, lastNl + 1)) };
}

/** Launch a CLI job detached (survives server restarts); returns its id immediately. */
export function launchJob(kind: JobKind, args: string[], init: Partial<JobStatus> = {}): JobView {
  const id = `${kind}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = join(WEB_JOBS, id);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  // Placeholder until the CLI's reporter takes over (it rewrites status.json with the same id).
  const placeholder: JobStatus = { id, kind, state: 'running', stage: 'queued', pid: 0, run_dir: null, finding_ids: [], scope: null, branch: null, base: null, worktree: null, pr_url: null, verified: null, also_fixed: [], options: {}, started_at: now, updated_at: now, ended_at: null, error: null, summary: null, ...init };
  const logFd = openSync(join(dir, 'log.txt'), 'a');
  const child = spawn(process.execPath, [CLI, ...args, '--job', id], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, BUGBASH_JOB_DIR: WEB_JOBS, BUGBASH_MODEL_SELECTION: join(dir, 'model-selection.json'), FORCE_COLOR: '0' },
  });
  closeSync(logFd);
  placeholder.pid = child.pid ?? 0;
  if (!existsSync(join(dir, 'status.json'))) writeFileSync(join(dir, 'status.json'), JSON.stringify(placeholder, null, 2));
  writeFileSync(join(dir, 'command.json'), JSON.stringify({ args, cwd: REPO_ROOT, pid: child.pid, at: now }, null, 2));
  child.unref();
  return view(dir)!;
}

export function cancelJob(id: string) {
  const j = getJob(id);
  if (!j.alive) throw new HttpError(409, 'Job is not running');
  try {
    process.kill(-j.pid, 'SIGTERM');
  } catch {
    process.kill(j.pid, 'SIGTERM');
  }
  return { ok: true };
}

export { CLI };
