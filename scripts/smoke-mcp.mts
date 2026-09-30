// Early risk check: can `claude -p` drive our MCP server and see its screenshots?
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveTarget } from '../src/target/resolve.ts';
import { runClaude, tsxServer } from '../src/llm/claude.ts';
import { Config } from '../src/config.ts';
const t = await resolveTarget('fixtures/buggy-site');
const runDir = mkdtempSync(join(tmpdir(), 'bb-smoke-'));
const cfgPath = join(runDir, 'config.json');
writeFileSync(cfgPath, JSON.stringify(Config.parse({})));
const r = await runClaude({
  prompt: 'Call the observe tool exactly once. Then answer in one line: what is the background color of the "Add to cart" button in the SCREENSHOT, and what color is the small number bubble next to it? Answer only from the image.',
  mcpServers: { bugbash: tsxServer(resolve('src/mcp/browserServer.ts'), { BUGBASH_CONFIG: cfgPath, BUGBASH_RUN_DIR: runDir, BUGBASH_BASE_URL: t.baseUrl, BUGBASH_SESSION: 'smoke' }) },
  allowedTools: ['mcp__bugbash'],
  transcriptPath: join(runDir, 'transcript.jsonl'),
  timeoutMs: 180000,
});
console.log(JSON.stringify(r, null, 1));
console.log('transcript:', join(runDir, 'transcript.jsonl'));
await t.stop();
