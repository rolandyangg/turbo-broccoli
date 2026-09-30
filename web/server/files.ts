import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { HttpError } from './workspaces.ts';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8', // never render run files as HTML in our origin
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolves `rel` inside `root`, refusing anything that escapes it. */
export function safePath(root: string, rel: string): string {
  const base = resolve(root);
  const p = resolve(base, rel);
  if (p !== base && !p.startsWith(base + sep)) throw new HttpError(403, 'Path escapes the run directory');
  if (rel.split(/[\\/]/).includes('node_modules')) throw new HttpError(403, 'Not served');
  if (!existsSync(p) || !statSync(p).isFile()) throw new HttpError(404, 'Not found');
  return p;
}

/** Streams a file, honoring HTTP Range (needed for video seeking). */
export function fileResponse(path: string, rangeHeader: string | undefined, download = false): Response {
  const size = statSync(path).size;
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
  if (download) headers['content-disposition'] = `attachment; filename="${path.split(sep).pop()}"`;
  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
    headers['content-length'] = String(end - start + 1);
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, { status: 206, headers });
  }
  headers['content-length'] = String(size);
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers });
}
