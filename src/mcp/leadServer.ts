/**
 * stdio MCP server for the lead agent. A thin proxy to the campaign control API running in the CLI process,
 * so explorer jobs keep running (and budgets stay enforced) independently of the lead agent's process.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CONTROL = process.env.BUGBASH_CONTROL!;
const TOKEN = process.env.BUGBASH_TOKEN!;

async function call(path: string, body: unknown = {}) {
  const res = await fetch(CONTROL + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bugbash-token': TOKEN }, body: JSON.stringify(body) });
  const json = await res.json();
  return { content: [{ type: 'text' as const, text: typeof json?.text === 'string' ? json.text : JSON.stringify(json, null, 1) }], isError: !!json?.error };
}

const server = new McpServer({ name: 'bugbash-lead', version: '0.1.0' });

server.registerTool('memory', { description: 'Read durable memory from past runs (site model, known bugs, false-positive patterns, lessons) or write lessons for future runs.', inputSchema: { action: z.enum(['read', 'write']), text: z.string().optional() } }, (a) => call('/memory', a));
server.registerTool('code_intel', { description: 'White-box analysis of the source repo: breakpoints, risky CSS with file:line, shared components, routes, long i18n strings, changed files, and hypothesis seeds.', inputSchema: {} }, () => call('/code_intel'));
server.registerTool('site_map', { description: 'Pages known so far (from source routes, memory, and explorer coverage).', inputSchema: {} }, () => call('/site_map'));
server.registerTool(
  'spawn_explorer',
  {
    description: 'Start an explorer agent session (asynchronous). Returns its id. Give a concrete goal, the pages to cover, a persona, a browser, and hypotheses to test first.',
    inputSchema: {
      goal: z.string(),
      pages: z.array(z.string()).describe('Paths, first is the start page'),
      persona: z.enum(['phone-user', 'keyboard-user', 'german-user', 'impatient-user', 'power-user', 'low-vision-user']).optional(),
      browser: z.enum(['chromium', 'webkit', 'firefox']).optional(),
      viewport: z.object({ width: z.number().int(), height: z.number().int() }).optional(),
      hypotheses: z.array(z.string()).optional(),
      max_tool_calls: z.number().int().optional(),
    },
  },
  (a) => call('/spawn', { ...a, maxToolCalls: a.max_tool_calls }),
);
server.registerTool('await_explorers', { description: 'Block until at least one running explorer finishes, then return findings_summary.', inputSchema: { timeout_ms: z.number().int().optional() } }, (a) => call('/await', a));
server.registerTool('findings_summary', { description: 'Findings so far (by page, hot components, per-session new-finding counts), saturation signal, and remaining budget.', inputSchema: {} }, () => call('/findings'));
server.registerTool('coverage', { description: 'Per-page coverage: states, untried elements, untested widths/browsers, untried strategies.', inputSchema: {} }, () => call('/coverage'));
server.registerTool('hunt_siblings', { description: 'Spawn a focused explorer that checks every other instance of the component behind a finding (by findings_summary index).', inputSchema: { finding_index: z.number().int() } }, (a) => call('/hunt', a));
server.registerTool('log_decision', { description: 'Record a planning decision and its reason (shown in the report).', inputSchema: { text: z.string() } }, (a) => call('/note', a));
server.registerTool('stop', { description: 'End the campaign (no new explorers). Give the reason: saturation evidence, coverage, budget.', inputSchema: { reason: z.string() } }, (a) => call('/stop', a));

await server.connect(new StdioServerTransport());
