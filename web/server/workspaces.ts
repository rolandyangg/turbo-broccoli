import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registeredWorkspaces, registerWorkspace, listRuns } from '../../src/store/store.ts';

/** Workspaces come from the CLI's registry (~/.bugbash/workspaces.json), --workspace args and BUGBASH_WORKSPACES. */
const extra = new Set<string>();

export function addWorkspace(path: string) {
  const ws = resolve(path);
  if (!existsSync(join(ws, 'runs'))) throw new Error(`${ws} is not a bugbash workspace (no runs/ folder)`);
  extra.add(ws);
  registerWorkspace(ws);
  return ws;
}

export function initWorkspaces(argv: string[]) {
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--workspace' && argv[i + 1]) extra.add(resolve(argv[++i]));
  for (const w of (process.env.BUGBASH_WORKSPACES ?? '').split(':').filter(Boolean)) extra.add(resolve(w));
  const local = resolve('.bugbash');
  if (existsSync(join(local, 'runs'))) extra.add(local);
}

export const wsId = (path: string) => createHash('sha1').update(path).digest('hex').slice(0, 10);

export interface Workspace {
  id: string;
  path: string;
  runs: string[];
}

export function workspaces(): Workspace[] {
  const all = [...new Set([...registeredWorkspaces(), ...extra])].filter((w) => existsSync(join(w, 'runs')));
  return all.map((path) => ({ id: wsId(path), path, runs: listRuns(path) }));
}

export function workspaceById(id: string): Workspace {
  const w = workspaces().find((x) => x.id === id);
  if (!w) throw new HttpError(404, `Unknown workspace ${id}`);
  return w;
}

export function runDirOf(wsIdParam: string, runId: string): string {
  const w = workspaceById(wsIdParam);
  if (!/^[\w.-]+$/.test(runId)) throw new HttpError(400, 'Bad run id');
  const dir = join(w.path, 'runs', runId);
  if (!existsSync(join(dir, 'run.json'))) throw new HttpError(404, `Unknown run ${runId}`);
  return dir;
}

/** Finds which workspace/run a run directory belongs to (for links from job records). */
/** Real on-disk spelling of a path (macOS is case-insensitive and /var is a symlink), cached; unchanged if missing. */
const canonCache = new Map<string, string>();
export function canon(p: string): string {
  let c = canonCache.get(p);
  if (c === undefined) {
    try {
      c = realpathSync.native(p);
    } catch {
      c = p;
    }
    canonCache.set(p, c);
  }
  return c;
}
export const samePath = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && (a === b || canon(a) === canon(b));

export function locateRunDir(runDir: string | null): { ws: string; run: string } | null {
  if (!runDir) return null;
  const real = canon(runDir);
  for (const w of workspaces()) {
    for (const base of [w.path, canon(w.path)]) {
      const prefix = join(base, 'runs') + '/';
      const hit = runDir.startsWith(prefix) ? runDir : real.startsWith(prefix) ? real : null;
      if (hit) return { ws: w.id, run: hit.slice(prefix.length).split('/')[0] };
    }
  }
  return null;
}

export class HttpError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 500,
    msg: string,
  ) {
    super(msg);
  }
}

export function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
