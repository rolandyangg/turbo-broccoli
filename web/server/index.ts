import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app as api } from './app.ts';
import { mountFrontend } from './frontend.ts';
import { initWorkspaces, workspaces } from './workspaces.ts';

initWorkspaces(process.argv.slice(2));

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const prod = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? (prod ? 4317 : (process.env.BUGBASH_WEB_API_PORT ?? 4318)));

const root = new Hono();
root.route('/', api);
if (prod) {
  if (!existsSync(dist)) throw new Error('web/dist not found; run `npm run build` in web/ first.');
  mountFrontend(root, dist);
}

serve({ fetch: root.fetch, port, hostname: '127.0.0.1' }, (info) => {
  const ws = workspaces();
  console.log(`bugbash web ${prod ? '' : 'API '}on http://127.0.0.1:${info.port} — ${ws.length} workspace(s), ${ws.reduce((a, w) => a + w.runs.length, 0)} run(s)`);
  if (!prod) console.log('UI: http://127.0.0.1:4317');
});
