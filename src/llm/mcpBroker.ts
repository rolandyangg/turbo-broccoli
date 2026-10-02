/** Own MCP processes outside the provider subprocess so browser state and budgets survive handoffs. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsxServer, type ClaudeRunOptions } from './claude.js';

export async function createMcpBroker(servers: NonNullable<ClaudeRunOptions['mcpServers']>) {
  const clients = new Map<string, Client>();
  const pending = new Set<string>();
  const progress: string[] = [];
  const token = randomBytes(24).toString('hex');
  const http = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${token}`) { send(403, { error: 'Forbidden' }); return; }
    try {
      const path = req.url?.split('/') ?? [];
      const client = clients.get(decodeURIComponent(path[1] ?? ''));
      if (!client) { send(404, { error: 'Unknown server' }); return; }
      if (req.method === 'GET' && path[2] === 'tools') { send(200, await client.listTools()); return; }
      if (req.method !== 'POST' || path[2] !== 'call') { send(404, { error: 'Unknown endpoint' }); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 2 * 1024 * 1024) throw new Error('Request too large'); }
      const call = JSON.parse(body);
      const task = client.callTool(call, undefined, { timeout: 30 * 60_000 });
      const pendingCall = JSON.stringify({ server: path[1], tool: call.name, arguments: call.arguments, status: 'in flight; inspect state before repeating' });
      pending.add(pendingCall);
      try {
        const result = await task;
        progress.push(JSON.stringify({ server: path[1], tool: call.name, arguments: call.arguments, result }, (key, value) => key === 'data' && typeof value === 'string' && value.length > 2000 ? '[image omitted]' : value).slice(0, 8000));
        while (progress.length > 20) progress.shift();
        send(200, result);
      } finally { pending.delete(pendingCall); }
    } catch (e) { send(500, { error: (e as Error).message }); }
  });
  const close = async () => { http.close(); http.closeAllConnections(); await Promise.allSettled([...clients.values()].map((c) => c.close())); };
  try {
    for (const [name, d] of Object.entries(servers)) {
      const client = new Client({ name: 'bugbash-handoff', version: '0.1.0' });
      clients.set(name, client);
      await client.connect(new StdioClientTransport({ command: d.command, args: d.args, env: { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), ...d.env } }));
    }
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing MCP broker port');
    const proxy = join(dirname(fileURLToPath(import.meta.url)), 'mcpProxy.ts');
    return {
      servers: Object.fromEntries([...clients.keys()].map((name) => [name, tsxServer(proxy, { BUGBASH_MCP_BROKER: `http://127.0.0.1:${address.port}/${encodeURIComponent(name)}`, BUGBASH_MCP_TOKEN: token })])),
      progress: () => [...progress, ...pending].join('\n'),
      close,
    };
  } catch (e) { await close(); throw e; }
}
