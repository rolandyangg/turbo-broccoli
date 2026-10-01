import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A stand-in for GitHub's comment box: a signed-in marker, a textarea, and a file input that (like GitHub) inserts
// image markdown pointing at user-attachments a moment after files are chosen.
const PAGE = (variant: 'markdown' | 'img') => `<!doctype html><html><head><meta name="user-login" content="octo"></head><body>
<textarea name="pull_request[body]">draft text</textarea><input type="file" multiple>
<script>
document.querySelector('input').addEventListener('change', (e) => {
  const ta = document.querySelector('textarea');
  const files = [...e.target.files];
  ta.value += files.map((f) => '[Uploading ' + f.name + '…]').join('\\n');
  setTimeout(() => {
    ta.value = 'draft text' + files.map((f, i) => ${variant === 'markdown' ? "'\\n![' + f.name.replace(/\\.[^.]+$/, '') + '](https://github.com/user-attachments/assets/00000000-0000-0000-0000-00000000000' + i + ')'" : "'\\n<img width=\"300\" alt=\"' + f.name.replace(/\\.[^.]+$/, '') + '\" src=\"https://github.com/user-attachments/assets/aaaaaaaa-0000-0000-0000-00000000000' + i + '\" />'"}).join('');
  }, 400);
});
</script></body></html>`;

let server: Server;
let base = '';
let dir = '';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bb-gh-'));
  process.env.BUGBASH_HOME = join(dir, 'home');
  mkdirSync(join(dir, 'home', 'github-session'), { recursive: true });
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE(req.url?.includes('img') ? 'img' : 'markdown'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server?.close());

const png = (name: string) => {
  const p = join(dir, name);
  // 1×1 transparent PNG
  writeFileSync(p, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  return p;
};

describe("PR pictures via GitHub's image hosting", () => {
  it('uploads through the comment box, maps URLs to file names, and restores the draft', async () => {
    const { uploadToGitHub } = await import('../src/fix/githubImages.js');
    const urls = await uploadToGitHub(`${base}/compare`, [
      { path: png('a.png'), name: 'BB-0001-before.png' },
      { path: png('b.png'), name: 'BB-0001-after.png' },
      { path: join(dir, 'missing.png'), name: 'BB-0002-before.png' }, // skipped
    ]);
    expect(Object.fromEntries(urls)).toEqual({
      'BB-0001-before.png': 'https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000',
      'BB-0001-after.png': 'https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001',
    });
  }, 60_000);

  it('also reads the <img> form GitHub uses for sized images', async () => {
    const { uploadToGitHub } = await import('../src/fix/githubImages.js');
    const urls = await uploadToGitHub(`${base}/img`, [{ path: png('c.png'), name: 'BB-0003-after.png' }]);
    expect(urls.get('BB-0003-after.png')).toMatch(/user-attachments\/assets\/aaaaaaaa/);
  }, 60_000);
});
