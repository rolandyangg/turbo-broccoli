import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import handler from 'serve-handler';
import getPort from 'get-port';
import { execa, type ResultPromise } from 'execa';

export interface ResolvedTarget {
  /** What the user passed in. */
  input: string;
  kind: 'url' | 'static' | 'dev-server';
  baseUrl: string;
  /** Local source directory when known (enables code intel, source hints and fixing). */
  repoPath: string | null;
  stop(): Promise<void>;
}

export interface ResolveOptions {
  devCommand?: string | null;
  devPort?: number | null;
  /** When the target is a URL but the source lives locally. */
  repo?: string | null;
  log?: (msg: string) => void;
}

export async function resolveTarget(input: string, opts: ResolveOptions = {}): Promise<ResolvedTarget> {
  const log = opts.log ?? (() => {});
  if (/^https?:\/\//i.test(input)) {
    return { input, kind: 'url', baseUrl: stripSlash(input), repoPath: opts.repo ? resolvePath(opts.repo) : null, stop: async () => {} };
  }
  const dir = resolvePath(input);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Target not found: ${input}`);

  const pkgPath = join(dir, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
  const script = opts.devCommand ? null : pkg?.scripts?.dev ? 'dev' : pkg?.scripts?.start ? 'start' : null;

  if (opts.devCommand || script) {
    const port = opts.devPort ?? (await getPort({ port: [5173, 3000, 3001, 4321, 8080] }));
    const cmd = opts.devCommand ?? `npm run ${script}`;
    const swept = await stopLeftoverServers(dir);
    if (swept.length) log(`Stopped a dev server left running in this folder by an earlier job (pid ${swept.join(', ')})`);
    log(`Starting dev server: ${cmd} (PORT=${port})`);
    const child = execa(cmd, {
      cwd: dir,
      shell: true,
      env: { PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' },
      reject: false,
      detached: true,
    });
    track(child, dir, cmd);
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    const baseUrl = await waitForServer(child, () => output, port, opts.devPort != null);
    log(`Dev server ready at ${baseUrl}`);
    return {
      input,
      kind: 'dev-server',
      baseUrl,
      repoPath: dir,
      stop: async () => {
        killTree(child);
        untrack(child, dir);
      },
    };
  }

  const root = findStaticRoot(dir);
  const port = await getPort();
  const server: Server = createServer((req, res) => {
    req.url = cleanHtmlUrl(req.url ?? '/');
    return handler(req, res, { public: root, directoryListing: false });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  log(`Serving ${root} at http://127.0.0.1:${port}`);
  return {
    input,
    kind: 'static',
    baseUrl: `http://127.0.0.1:${port}`,
    repoPath: dir,
    stop: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

function findStaticRoot(dir: string): string {
  for (const c of ['', 'dist', 'build', 'public', 'out', '_site']) {
    if (existsSync(join(dir, c, 'index.html'))) return join(dir, c);
  }
  return dir;
}

async function waitForServer(child: ResultPromise, output: () => string, port: number, portFixed: boolean): Promise<string> {
  const deadline = Date.now() + 120_000;
  let exited = false;
  child.then(() => (exited = true), () => (exited = true));
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Dev server exited early:\n${output().slice(-2000)}`);
    // Frameworks often ignore PORT; prefer a URL printed in the log.
    const printed = portFixed ? null : output().match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)/);
    const candidates = printed ? [Number(printed[1]), port] : [port];
    for (const p of candidates) {
      const url = `http://localhost:${p}`;
      try {
        const res = await fetch(url, { redirect: 'manual' });
        if (res.status < 500) return url;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for dev server:\n${output().slice(-2000)}`);
}

function killTree(child: ResultPromise) {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/*
 * Dev servers run detached (their own process group), so they outlive a job that is cancelled or crashes unless we
 * stop them. Every one started here is stopped when this process exits, and recorded under ~/.bugbash/dev-servers so
 * the next start in the same folder can stop one whose owner died without cleaning up (a held .next/dev/lock, a
 * taken port...).
 */
const running = new Set<ResultPromise>();
let exitHook = false;
const recordDir = () => join(process.env.BUGBASH_HOME || join(homedir(), '.bugbash'), 'dev-servers');
const recordOf = (dir: string) => join(recordDir(), `${createHash('sha1').update(dir).digest('hex').slice(0, 16)}.json`);

function track(child: ResultPromise, dir: string, cmd: string) {
  running.add(child);
  try {
    mkdirSync(recordDir(), { recursive: true });
    writeFileSync(recordOf(dir), JSON.stringify({ pgid: child.pid, owner: process.pid, dir, cmd, at: new Date().toISOString() }));
  } catch {}
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const c of running) killTree(c);
    });
  }
}

function untrack(child: ResultPromise, dir: string) {
  running.delete(child);
  try {
    const r = JSON.parse(readFileSync(recordOf(dir), 'utf8'));
    if (r.pgid === child.pid) rmSync(recordOf(dir), { force: true });
  } catch {}
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops dev servers still running in `dir` whose owner is gone: the one on record, and (in bugbash's own worktrees
 * only) any orphaned process group working there. Never touches a server you started yourself in your checkout.
 */
export async function stopLeftoverServers(dir: string): Promise<number[]> {
  const groups = new Set<number>();
  try {
    const r = JSON.parse(readFileSync(recordOf(dir), 'utf8')) as { pgid?: number; owner?: number };
    if (r.pgid && !(r.owner && isAlive(r.owner)) && isAlive(r.pgid)) groups.add(r.pgid);
    if (r.pgid && !isAlive(r.pgid)) rmSync(recordOf(dir), { force: true });
  } catch {}
  if (/-(bugbash|improve)-worktrees\//.test(dir + '/')) {
    // Processes whose working directory is in `dir` (lsof prints "p<pid>" then "n<path>" per process).
    const cwd = await execa('lsof', ['-a', '-d', 'cwd', '-Fpn'], { reject: false, timeout: 15_000 }).catch(() => null);
    const pids: number[] = [];
    let pid = 0;
    for (const l of (cwd?.stdout ?? '').split('\n')) {
      if (l.startsWith('p')) pid = Number(l.slice(1));
      else if (l.startsWith('n') && (l.slice(1) === dir || l.slice(1).startsWith(dir + '/'))) pids.push(pid);
    }
    if (pids.length) {
      const ps = await execa('ps', ['-o', 'pid=,ppid=,pgid=', '-p', pids.join(',')], { reject: false }).catch(() => null);
      const rows = (ps?.stdout ?? '').trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
      for (const [, , pgid] of rows) {
        // An orphaned group: its leader was re-parented to launchd/init (its job is gone).
        const lead = await execa('ps', ['-o', 'ppid=', '-p', String(pgid)], { reject: false }).catch(() => null);
        if (pgid && pgid !== process.pid && Number(lead?.stdout.trim()) === 1) groups.add(pgid);
      }
    }
  }
  for (const g of groups) {
    try {
      process.kill(-g, 'SIGTERM');
    } catch {}
  }
  if (groups.size) {
    const until = Date.now() + 8000;
    while ([...groups].some(isAlive) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    for (const g of groups) {
      try {
        if (isAlive(g)) process.kill(-g, 'SIGKILL');
      } catch {}
    }
    rmSync(recordOf(dir), { force: true });
  }
  return [...groups];
}

function stripSlash(u: string) {
  return u.replace(/\/+$/, '');
}

/**
 * serve-handler answers `/page.html?x=1` with a 301 to `/page` and drops the query (and with it any state a test page
 * reads from it). Rewrite to the clean URL internally instead, so the page is served as requested.
 */
export function cleanHtmlUrl(url: string): string {
  const i = url.search(/[?#]/);
  const path = i < 0 ? url : url.slice(0, i);
  const rest = i < 0 ? '' : url.slice(i);
  if (/(^|\/)index\.html$/.test(path)) return path.replace(/index\.html$/, '') + rest;
  if (path.endsWith('.html')) return path.slice(0, -5) + rest;
  return url;
}
