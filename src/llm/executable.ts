import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const executable = (file: string) => {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
};

/** GUI-launched servers do not necessarily inherit the desktop app's CLI directory in PATH. */
export function resolveCodexExecutable(options: { path?: string; override?: string; bundledPaths?: string[]; platform?: NodeJS.Platform } = {}): string {
  const override = options.override ?? process.env.BUGBASH_CODEX_BIN;
  if (override) {
    const file = resolve(override);
    if (!executable(file)) throw new Error(`BUGBASH_CODEX_BIN is not an executable file: ${file}`);
    return file;
  }
  const platform = options.platform ?? process.platform;
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  for (const dir of (options.path ?? process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) { const file = resolve(dir, name); if (executable(file)) return file; }
  }
  const bundles = options.bundledPaths ?? (platform === 'darwin' ? [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    join(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
  ] : []);
  for (const file of bundles) if (executable(file)) return file;
  throw new Error('Codex CLI was not found in PATH or the desktop app. Install Codex and sign in with codex login, or set BUGBASH_CODEX_BIN to its executable path.');
}

export function codexProcessError(res: { exitCode?: number; code?: string; signal?: string; originalMessage?: string; shortMessage?: string; stderr?: string; timedOut?: boolean }, timeoutMs?: number): string {
  if (res.timedOut) return `Codex timed out after ${timeoutMs}ms`;
  const reason = res.code ?? res.signal ?? (res.exitCode == null ? 'failed to start' : `exit ${res.exitCode}`);
  const detail = res.stderr?.trim() || res.originalMessage || res.shortMessage || 'No diagnostic output';
  return `Codex ${reason}: ${detail.slice(-1600)}`;
}
