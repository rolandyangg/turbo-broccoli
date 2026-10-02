import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Config } from '../src/config.js';
import type { Finding } from '../src/store/schema.js';
import { fixBrowserTools } from '../src/fix/browser.js';
import { resolveTarget } from '../src/target/resolve.js';

it('gives the fixer live screenshots and detectors against its server, with scoped browser permissions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-fix-browser-'));
  const target = await resolveTarget('fixtures/detector-lab');
  const client = new Client({ name: 'fix-browser-test', version: '0' });
  try {
    const finding = { page: '/focus.html', browsers: ['chromium'], reproduction: { environment: { browser: 'chromium', viewport: { width: 320, height: 568 }, variant: { device: null } } } } as Finding;
    const tools = fixBrowserTools([finding], Config.parse({}), target.baseUrl, dir);
    expect(tools.allowedTools).toContain('mcp__fix_chromium__observe');
    expect(tools.allowedTools).toContain('mcp__fix_chromium__run_detectors');
    expect(tools.allowedTools.some((t) => /record_finding|mutate_text|notes/.test(t))).toBe(false);
    const server = tools.mcpServers.fix_chromium;
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...(process.env as Record<string, string>), ...server.env } }));
    const observed = await client.callTool({ name: 'observe', arguments: {} });
    expect(observed.isError).not.toBe(true);
    expect(observed.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: expect.stringMatching(/^image\//) })]));
    expect(JSON.stringify(observed.content)).toContain('/focus.html');
    const detectors = await client.callTool({ name: 'run_detectors', arguments: {} });
    expect(detectors.isError).not.toBe(true);
  } finally {
    await client.close();
    await target.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it('creates each affected engine and falls back to the reproduction browser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-fix-engines-'));
  try {
    const finding = { page: '/', browsers: [], reproduction: { environment: { browser: 'webkit', viewport: { width: 320, height: 568 }, variant: { device: 'iphone-se' } } } } as Finding;
    const tools = fixBrowserTools([finding, { ...finding, browsers: ['chromium', 'firefox'] }], Config.parse({}), 'http://localhost:8080', dir);
    expect(Object.keys(tools.mcpServers)).toEqual(['fix_webkit', 'fix_chromium', 'fix_firefox']);
    expect(tools.mcpServers.fix_webkit.env.BUGBASH_DEVICE).toBe('iphone-se');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
