import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { mountFrontend } from '../server/frontend.ts';

let dist: string;
let app: Hono;
beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'broccoli-frontend-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<script src="/assets/old.js"></script>');
  writeFileSync(join(dist, 'assets', 'old.js'), 'console.log("old")');
  app = new Hono();
  mountFrontend(app, dist);
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

describe('production frontend', () => {
  it('serves the latest build on a job deep link after rebuilding', async () => {
    expect(await (await app.request('/jobs/fix-123')).text()).toContain('/assets/old.js');
    rmSync(join(dist, 'assets', 'old.js'));
    writeFileSync(join(dist, 'assets', 'new.js'), 'console.log("new")');
    writeFileSync(join(dist, 'index.html'), '<script src="/assets/new.js"></script>');
    const page = await app.request('/jobs/fix-123');
    expect(await page.text()).toContain('/assets/new.js');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const asset = await app.request('/assets/new.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
  });

  it('returns 404 for missing build assets instead of HTML', async () => {
    expect((await app.request('/assets/missing.js')).status).toBe(404);
  });
});
