import { githubSession, githubLogout } from '../../src/fix/githubImages.ts';
import { launchJob, listJobs } from './jobs.ts';
import { HttpError } from './workspaces.ts';

// Checking the session opens a headless browser (a few seconds): cache it briefly.
let cache: { at: number; login: string | null } | null = null;

export async function githubStatus(fresh = false) {
  if (fresh || !cache || Date.now() - cache.at > 60_000) cache = { at: Date.now(), login: await githubSession() };
  const connecting = listJobs().find((j) => j.kind === 'connect' && j.alive) ?? null;
  return { login: cache.login, connected: !!cache.login, connecting: connecting?.id ?? null };
}

export function connectGitHub() {
  const busy = listJobs().find((j) => j.kind === 'connect' && j.alive);
  if (busy) throw new HttpError(409, 'A GitHub sign-in window is already open');
  cache = null;
  return launchJob('connect', ['github-login'], { scope: 'GitHub' });
}

export async function disconnectGitHub() {
  await githubLogout();
  cache = { at: Date.now(), login: null };
  return { ok: true };
}
