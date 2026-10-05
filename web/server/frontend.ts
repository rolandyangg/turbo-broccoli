import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Hono } from 'hono';

export function mountFrontend(app: Hono, dist: string) {
  app.use('/*', async (c, next) => {
    if (!c.req.path.startsWith('/assets/')) c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/*', serveStatic({ root: relative(process.cwd(), dist) }));
  app.get('/assets/*', (c) => c.notFound());
  // Builds replace hashed assets. Read the matching HTML for every new navigation.
  app.get('*', (c) => c.html(readFileSync(join(dist, 'index.html'), 'utf8')));
}
