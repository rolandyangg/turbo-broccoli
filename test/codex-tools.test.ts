import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tsxServer } from '../src/llm/claude.js';
import { createMcpBroker } from '../src/llm/mcpBroker.js';
import { Config } from '../src/config.js';
import { resolveTarget } from '../src/target/resolve.js';
import { postMessage, readMessages } from '../src/jobs/inbox.js';

const env = () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
const connect = async (d: { command: string; args: string[]; env?: Record<string, string> }) => { const client = new Client({ name: 'test', version: '1' }); await client.connect(new StdioClientTransport({ ...d, env: { ...env(), ...d.env } })); return client; };

describe('Codex capability bridge', () => {
  it('enforces file scope, symlink boundaries, exact edits, requested tools, images, and inbox delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-codex-tools-')); const root = join(dir, 'root'); mkdirSync(root);
    writeFileSync(join(dir, 'secret'), 'secret'); symlinkSync(dir, join(root, 'escape')); mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'test.txt'), 'hello'); writeFileSync(join(root, 'shot.png'), Buffer.from('png'));
    const config = join(dir, 'config.json'); postMessage(dir, 'Look at mobile');
    writeFileSync(config, JSON.stringify({ servers: {}, tools: ['Read', 'Edit'], allowedTools: [], roots: [root], inbox: join(dir, 'messages.jsonl'), agentName: 'reviewer' }));
    const client = await connect(tsxServer(resolve('src/llm/codexTools.ts'), { BUGBASH_CODEX_TOOLS: config }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['inbox', 'Read', 'Edit']);
      expect(await client.callTool({ name: 'Read', arguments: { file_path: 'test.txt' } })).toMatchObject({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: expect.stringContaining('Look at mobile') }] });
      expect(readMessages(dir).deliveries[0].agent).toBe('reviewer');
      expect(await client.callTool({ name: 'Read', arguments: { file_path: 'escape/secret' } })).toMatchObject({ isError: true });
      expect(await client.callTool({ name: 'Read', arguments: { file_path: '../secret' } })).toMatchObject({ isError: true });
      expect(await client.callTool({ name: 'Edit', arguments: { file_path: '.git/config', old_string: 'x', new_string: 'y' } })).toMatchObject({ isError: true });
      expect(await client.callTool({ name: 'Read', arguments: { file_path: 'shot.png' } })).toMatchObject({ content: [{ type: 'image', mimeType: 'image/png' }] });
      await client.callTool({ name: 'Edit', arguments: { file_path: 'test.txt', old_string: 'hello', new_string: '$&literal' } });
      expect(readFileSync(join(root, 'test.txt'), 'utf8')).toBe('$&literal');
      expect(await client.callTool({ name: 'Edit', arguments: { file_path: 'test.txt', old_string: 'missing', new_string: 'y' } })).toMatchObject({ isError: true });
    } finally { await client.close(); }
  });
  it('keeps upstream MCP state and tool schemas across provider proxy restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-broker-')); const root = join(dir, 'root'); mkdirSync(root); writeFileSync(join(root, 'state'), 'before');
    const config = join(dir, 'config.json'); writeFileSync(config, JSON.stringify({ servers: {}, tools: ['Read', 'Edit'], allowedTools: [], roots: [root], agentName: 'test' }));
    const broker = await createMcpBroker({ browser: tsxServer(resolve('src/llm/codexTools.ts'), { BUGBASH_CODEX_TOOLS: config }) });
    try {
      const first = await connect(broker.servers.browser);
      expect((await first.listTools()).tools.find((t) => t.name === 'Edit')?.inputSchema.required).toContain('old_string');
      await first.callTool({ name: 'Edit', arguments: { file_path: 'state', old_string: 'before', new_string: 'after' } });
      await first.close();
      const second = await connect(broker.servers.browser);
      try { expect(await second.callTool({ name: 'Read', arguments: { file_path: 'state' } })).toMatchObject({ content: [{ text: 'after' }] }); expect(broker.progress()).toContain('after'); }
      finally { await second.close(); }
    } finally { await broker.close(); }
  });
  it('preserves live browser state and its tool budget across a provider disconnect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-browser-handoff-'));
    const site = join(dir, 'site'); mkdirSync(site);
    writeFileSync(join(site, 'index.html'), '<title>initial</title><label>Name<input id="name" oninput="document.title=this.value"></label>');
    const target = await resolveTarget(site);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(Config.parse({})));
    const upstream = tsxServer(resolve('src/mcp/browserServer.ts'), { BUGBASH_CONFIG: join(dir, 'config.json'), BUGBASH_RUN_DIR: dir, BUGBASH_BASE_URL: target.baseUrl, BUGBASH_SESSION: 's-handoff', BUGBASH_BROWSER: 'chromium', BUGBASH_MAX_CALLS: '3' });
    const broker = await createMcpBroker({ bugbash: upstream });
    try {
      const first = await connect(broker.servers.bugbash);
      try {
        await first.callTool({ name: 'observe', arguments: { screenshot: false } });
        expect(await first.callTool({ name: 'type', arguments: { ref: '#name', text: 'preserved-state' } })).not.toMatchObject({ isError: true });
      } finally { await first.close(); }
      const second = await connect(broker.servers.bugbash);
      try {
        const state = await second.callTool({ name: 'observe', arguments: { screenshot: false } });
        expect(JSON.stringify(state)).toContain('title: preserved-state');
        const overBudget = await second.callTool({ name: 'observe', arguments: { screenshot: false } });
        expect(JSON.stringify(overBudget)).toContain('BUDGET EXHAUSTED');
      } finally { await second.close(); }
    } finally { await broker.close(); await target.stop(); }
  }, 60000);

});
