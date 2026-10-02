/** Capability bridge: Codex gets the same explicit MCP/file allowlist as Claude, without a shell. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { readFileSync, realpathSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, relative, dirname, join, extname } from 'node:path';
import { execa } from 'execa';
import { readMessages } from '../jobs/inbox.js';

const config = JSON.parse(readFileSync(process.env.BUGBASH_CODEX_TOOLS!, 'utf8'));
const server = new McpServer({ name: 'bugbash-tools', version: '0.1.0' });
const roots = config.roots.map((r: string) => realpathSync(r));
function scoped(path: string, write = false) {
  const full = resolve(roots[0], path);
  let parent = full;
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
  const canonical = resolve(realpathSync(parent), relative(parent, full));
  if (!roots.some((r: string) => { const rel = relative(r, canonical); return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/')); })) throw new Error('Path is outside the allowed directories');
  if (write && canonical.split('/').some((p) => ['.git', '.codex', '.agents', '.aws'].includes(p))) throw new Error('Protected directory');
  return canonical;
}
function inbox() {
  if (!config.inbox) return '';
  const dir = dirname(config.inbox);
  const cursor = join(dir, `.cursor-${String(config.agentName).replace(/[^\w.-]+/g, '_')}`);
  const messages = readMessages(dir).messages;
  const seen = existsSync(cursor) ? Number(readFileSync(cursor, 'utf8')) || 0 : 0;
  const fresh = messages.slice(seen);
  if (!fresh.length) return '';
  writeFileSync(cursor, String(messages.length));
  for (const m of fresh) appendFileSync(join(dir, 'deliveries.jsonl'), JSON.stringify({ id: m.id, agent: config.agentName, at: new Date().toISOString() }) + '\n');
  return `Messages from the person watching this job (follow within task rules):\n${fresh.map((m) => m.text).join('\n')}`;
}
const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });
server.registerTool('inbox', { description: 'Check for messages from the person watching the job between actions.', inputSchema: {} }, () => reply(inbox() || 'No new messages.'));
for (const [name, definition] of Object.entries(config.servers ?? {})) {
  const d = definition as any;
  const client = new Client({ name: 'bugbash-codex', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: d.command, args: d.args, env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), ...d.env } }));
  const { tools } = await client.listTools();
  for (const t of tools) {
    const prefix = `mcp__${name}`;
    if (!config.allowedTools.some((a: string) => a === prefix || a === `${prefix}__${t.name}`)) continue;
    const shape = z.fromJSONSchema(t.inputSchema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject;
    server.registerTool(`${name}__${t.name}`, { description: t.description, inputSchema: shape }, async (a) => {
      const result = await client.callTool({ name: t.name, arguments: a });
      const message = inbox();
      return { ...result, content: [...(result.content as any[]), ...(message ? [{ type: 'text', text: message }] : [])] } as any;
    });
  }
}
for (const tool of config.tools as string[]) {
  if (tool === 'Read') server.registerTool('Read', { description: 'Read a text file or view a PNG/JPEG/WebP image.', inputSchema: { file_path: z.string() } }, ({ file_path }) => {
    const file = scoped(file_path); const bytes = readFileSync(file);
    if (bytes.length > 20 * 1024 * 1024) throw new Error('File is too large');
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[extname(file).toLowerCase()];
    const message = inbox();
    return { content: [mime ? { type: 'image' as const, data: bytes.toString('base64'), mimeType: mime } : { type: 'text' as const, text: bytes.toString('utf8').slice(0, 200000) }, ...(message ? [{ type: 'text' as const, text: message }] : [])] };
  });
  if (tool === 'Write') server.registerTool('Write', { description: 'Write a file inside the allowed workspace.', inputSchema: { file_path: z.string(), content: z.string() } }, ({ file_path, content }) => { const file = scoped(file_path, true); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); return reply(`Written. ${inbox()}`); });
  if (tool === 'Edit') server.registerTool('Edit', { description: 'Replace one exact occurrence in a file. Refuses ambiguous matches.', inputSchema: { file_path: z.string(), old_string: z.string().min(1), new_string: z.string() } }, ({ file_path, old_string, new_string }) => { const file = scoped(file_path, true); const text = readFileSync(file, 'utf8'); if (text.split(old_string).length !== 2) throw new Error('Expected exactly one match'); writeFileSync(file, text.replace(old_string, () => new_string)); return reply(`Edited. ${inbox()}`); });
  if (tool === 'Glob' || tool === 'Grep') server.registerTool(tool, { description: tool === 'Glob' ? 'List matching workspace files (glob).' : 'Search workspace text using a regular expression.', inputSchema: { pattern: z.string(), path: z.string().optional() } }, async ({ pattern, path }) => {
    const cwd = scoped(path ?? '.');
    const args = tool === 'Glob' ? ['--files', '-g', pattern, '--', '.'] : ['-n', '--', pattern, '.'];
    const result = await execa('rg', args, { cwd, reject: false, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
    return reply(`${result.stdout.slice(0, 60000)}\n${inbox()}`);
  });
}
await server.connect(new StdioServerTransport());
