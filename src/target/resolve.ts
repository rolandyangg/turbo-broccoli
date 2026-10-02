import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
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
    log(`Starting dev server: ${cmd} (PORT=${port})`);
    const child = execa(cmd, {
      cwd: dir,
      shell: true,
      env: { PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' },
      reject: false,
      detached: true,
    });
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
      stop: async () => killTree(child),
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
