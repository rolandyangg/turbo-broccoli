import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

export interface ReproCapture {
  path: string;
  at: string;
  url: string;
  viewport: { width: number; height: number } | null;
}

/** Process requests sequentially in the process that owns the live reproduction page. */
export function listenForCaptures(page: Page, runDir: string, jobDir: string, jobId: string) {
  const requests = join(jobDir, 'captures');
  mkdirSync(requests, { recursive: true });
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const name of readdirSync(requests).filter((n) => /^[a-f0-9-]+\.request$/.test(n))) {
        const id = name.slice(0, -8);
        renameSync(join(requests, name), join(requests, `${id}.working`));
        let result: ReproCapture | { error: string };
        try {
          const path = `shots/manual-${jobId}-${id}.png`;
          mkdirSync(join(runDir, 'shots'), { recursive: true });
          await page.screenshot({ path: join(runDir, path), type: 'png', timeout: 10_000, style: '[data-bugbash-overlay] { visibility: hidden !important; }' });
          result = { path, at: new Date().toISOString(), url: page.url(), viewport: page.viewportSize() };
        } catch (e) {
          result = { error: (e as Error).message };
        }
        const file = join(requests, `${id}.json`);
        writeFileSync(`${file}.tmp`, JSON.stringify(result));
        renameSync(`${file}.tmp`, file);
      }
    } finally {
      busy = false;
    }
  }, 200);
  return () => clearInterval(timer);
}

export function readCapture(jobDir: string, id: string): ReproCapture | { error: string } | null {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid capture id');
  const file = join(jobDir, 'captures', `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
