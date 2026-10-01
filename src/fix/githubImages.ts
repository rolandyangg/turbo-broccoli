import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { execa } from 'execa';
import { home } from '../notify/notify.js';

/**
 * Before/after pictures for PRs, hosted by GitHub itself (the same `github.com/user-attachments/assets/…` storage
 * used when you drag an image into a PR): nothing is committed to the repo, and only people who can see the repo can
 * see the images. GitHub has no public API for these uploads, so this drives a browser with a GitHub session the user
 * signs into once (`bugbash github-login`), kept in a private profile under ~/.bugbash.
 */
export const sessionDir = () => join(home(), 'github-session');

async function openContext(headless: boolean): Promise<BrowserContext> {
  mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
  try {
    chmodSync(sessionDir(), 0o700);
  } catch {}
  return chromium.launchPersistentContext(sessionDir(), { headless, viewport: { width: 1280, height: 900 } });
}

const loginOf = (page: Page) => page.evaluate(() => document.querySelector('meta[name="user-login"]')?.getAttribute('content') || null).catch(() => null);

/** Who the saved session is signed in as (null when signed out or never connected). */
export async function githubSession(): Promise<string | null> {
  if (!existsSync(sessionDir())) return null;
  const ctx = await openContext(true);
  try {
    const page = await ctx.newPage();
    await page.goto('https://github.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return await loginOf(page);
  } catch {
    return null;
  } finally {
    await ctx.close();
  }
}

/** Opens a visible browser on GitHub's sign-in page and waits (up to `timeoutMs`) until the user has signed in. */
export async function githubLogin(timeoutMs = 10 * 60_000, log: (m: string) => void = () => {}): Promise<string> {
  const ctx = await openContext(false);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
    log('Sign in to GitHub in the browser window that just opened (two-factor works as usual).');
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (page.isClosed()) throw new Error('The sign-in window was closed before signing in');
      const login = await loginOf(page);
      if (login) return login;
      await page.waitForTimeout(1500);
    }
    throw new Error('Timed out waiting for GitHub sign-in');
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function githubLogout() {
  rmSync(sessionDir(), { recursive: true, force: true });
}

/** Scales a copy of a large screenshot down (macOS sips) so uploads stay small; the original is untouched. */
async function shrunkCopy(file: string, dir: string, name: string) {
  const out = join(dir, name);
  copyFileSync(file, out);
  if (process.platform === 'darwin' && out.endsWith('.png')) {
    const w = Number((await execa('sips', ['-g', 'pixelWidth', out], { reject: false })).stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0);
    if (w > 1400) await execa('sips', ['--resampleWidth', '1400', out], { reject: false });
  }
  return out;
}

/**
 * Uploads images through a GitHub comment box on `pageUrl` (e.g. the repo's compare page for the PR, or the PR
 * itself) without submitting anything, and returns their hosted URLs keyed by file name. The box is cleared again.
 */
export async function uploadToGitHub(pageUrl: string, files: { path: string; name: string }[], opts: { timeoutMs?: number } = {}): Promise<Map<string, string>> {
  const existing = files.filter((f) => existsSync(f.path));
  const out = new Map<string, string>();
  if (!existing.length) return out;
  if (!existsSync(sessionDir())) throw new Error('GitHub is not connected (Settings → Connect GitHub, or `bugbash github-login`)');
  const tmp = mkdtempSync(join(tmpdir(), 'bb-upload-'));
  const ctx = await openContext(true);
  try {
    const page = await ctx.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!(await loginOf(page))) throw new Error('The saved GitHub session is signed out; connect GitHub again');
    // The description/comment box with GitHub's attachment support (classic and React UIs both use a file input).
    const textarea = page.locator('textarea[name="pull_request[body]"], textarea#new_comment_field, textarea[name="comment[body]"], textarea[aria-label*="arkdown"], textarea').first();
    await textarea.waitFor({ state: 'attached', timeout: 20_000 });
    const before = await textarea.inputValue().catch(() => '');
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 20_000 });
    const copies = await Promise.all(existing.map((f) => shrunkCopy(f.path, tmp, f.name)));
    await input.setInputFiles(copies);
    const end = Date.now() + (opts.timeoutMs ?? 90_000);
    let value = '';
    while (Date.now() < end) {
      value = await textarea.inputValue().catch(() => '');
      const done = (value.match(/https:\/\/github\.com\/user-attachments\/(assets|files)\/[\w-]+/g) ?? []).length >= copies.length && !/Uploading/i.test(value);
      if (done) break;
      await page.waitForTimeout(800);
    }
    // Inserted as ![name](url) or <img ... alt="name" src="url" />, in upload order.
    const urls: { name: string | null; url: string }[] = [];
    for (const m of value.matchAll(/!\[([^\]]*)\]\((https:\/\/github\.com\/user-attachments\/[^)\s]+)\)/g)) urls.push({ name: m[1], url: m[2] });
    for (const m of value.matchAll(/<img[^>]*?(?:alt="([^"]*)")?[^>]*?src="(https:\/\/github\.com\/user-attachments\/[^"]+)"/g)) urls.push({ name: m[1] ?? null, url: m[2] });
    copies.forEach((c, i) => {
      const stem = basename(c).replace(/\.[^.]+$/, '');
      const hit = urls.find((u) => u.name && (u.name === basename(c) || u.name === stem)) ?? urls[i];
      if (hit) out.set(basename(c), hit.url);
    });
    if (out.size < copies.length) throw new Error(`GitHub accepted ${out.size} of ${copies.length} images`);
    // Leave the box as it was so no draft is kept.
    await textarea.fill(before).catch(() => {});
    return out;
  } finally {
    await ctx.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}
