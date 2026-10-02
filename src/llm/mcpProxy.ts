import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const base = process.env.BUGBASH_MCP_BROKER!;
async function request(path: string, body?: unknown) {
  const res = await fetch(`${base}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${process.env.BUGBASH_MCP_TOKEN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error); return result;
}
const server = new Server({ name: 'bugbash-handoff-proxy', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => request('tools'));
server.setRequestHandler(CallToolRequestSchema, (req) => request('call', req.params));
await server.connect(new StdioServerTransport());
