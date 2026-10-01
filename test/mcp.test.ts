import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveTarget, type ResolvedTarget } from '../src/target/resolve.js';
import { Config } from '../src/config.js';
import { tsxServer } from '../src/llm/claude.js';

// The explorer's MCP server, driven over stdio exactly like `claude -p` does.
const here = dirname(fileURLToPath(import.meta.url));
let lab: ResolvedTarget;
let client: Client;
let runDir: string;

beforeAll(async () => {
  lab = await resolveTarget('fixtures/detector-lab');
  runDir = mkdtempSync(join(tmpdir(), 'bb-mcp-'));
  writeFileSync(join(runDir, 'config.json'), JSON.stringify(Config.parse({})));
  const srv = tsxServer(join(here, '..', 'src', 'mcp', 'browserServer.ts'), { BUGBASH_CONFIG: join(runDir, 'config.json'), BUGBASH_RUN_DIR: runDir, BUGBASH_BASE_URL: lab.baseUrl, BUGBASH_SESSION: 's-001', BUGBASH_BROWSER: 'chromium', BUGBASH_START_PATH: '/focus.html', BUGBASH_MAX_CALLS: '60' });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: srv.command, args: srv.args, env: { ...(process.env as Record<string, string>), ...srv.env } }));
}, 60_000);
afterAll(async () => {
  await client?.close();
  await lab?.stop();
});

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: !!r.isError };
};

describe('explorer MCP server process rules', () => {
  it('requires a hypothesis and a known strategy on record_finding', async () => {
    const base = { type: 'other', title: 'x', description: 'x', severity: 'minor', confidence: 0.5 };
    expect((await call('record_finding', base)).isError).toBe(true);
    expect((await call('record_finding', { ...base, hypothesis: 'a long enough guess', strategy: 'not.a.strategy' })).isError).toBe(true);
  });

  it('refuses probes after 8 without a log_hypothesis, and resumes once one is logged', async () => {
    for (let i = 0; i < 8; i++) expect((await call('check_focus', { steps: 1 })).isError).toBe(false);
    const refused = await call('check_focus', { steps: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Log a hypothesis first/);
    expect((await call('observe', { screenshot: false })).isError).toBe(false); // non-probe tools still work
    expect((await call('log_hypothesis', { hypothesis: 'buttons lose their focus ring', strategy: 'chaos.keyboard', outcome: 'confirmed' })).isError).toBe(false);
    expect((await call('check_focus', { steps: 1 })).isError).toBe(false);
    const log = readFileSync(join(runDir, 'sessions', 's-001.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log.some((e) => e.kind === 'tool' && e.name === 'check_focus' && e.blocked === 'process')).toBe(true);
  }, 120_000);
});
