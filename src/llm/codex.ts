import { resolveCodexExecutable, codexProcessError } from './executable.js';
import { execa } from 'execa';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryParseJson, tsxServer, type ClaudeRunOptions, type ClaudeRunResult, type StreamEvent } from './claude.js';

export function tomlValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)} = ${tomlValue(x)}`).join(', ')} }`;
  throw new Error('Unsupported Codex configuration value');
}

/** Codex strict output schemas require every object property; optional fields become nullable. */
export function codexSchema(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(codexSchema);
  const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, codexSchema(v)])) as any;
  if (out.type === 'object' && out.properties) {
    const required = new Set(value.required ?? []);
    for (const [k, v] of Object.entries(out.properties)) if (!required.has(k)) out.properties[k] = { anyOf: [v, { type: 'null' }] };
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

export function normalizeCodexEvent(e: any): StreamEvent[] {
  const item = e.item;
  if (e.type === 'item.completed' && item?.type === 'agent_message') return [{ type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } }];
  if (e.type === 'item.started' && item?.type === 'mcp_tool_call') return [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: item.server === 'bugbash_tools' && item.tool.includes('__') ? `mcp__${item.tool}` : `mcp__${item.server}__${item.tool}`, input: item.arguments }] } }];
  if (e.type === 'item.completed' && item?.type === 'mcp_tool_call') return [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: item.result?.content ?? [{ type: 'text', text: JSON.stringify(item.error ?? item.result) }], is_error: item.status === 'failed' || !!item.result?.isError } as any] } }];
  if (e.type === 'turn.completed') return [{ type: 'result', result: '', is_error: false, usage: { input_tokens: Math.max(0, (e.usage?.input_tokens ?? 0) - (e.usage?.cached_input_tokens ?? 0)), cache_read_input_tokens: e.usage?.cached_input_tokens ?? 0, output_tokens: e.usage?.output_tokens ?? 0 }, provider: 'codex' }];
  if (e.type === 'turn.failed' || e.type === 'error') return [{ type: 'result', result: e.error?.message ?? e.message ?? 'Codex failed', is_error: true, provider: 'codex' }];
  return [];
}

export async function runCodex(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'bugbash-codex-'));
  try {
    const downstream = o.mcpServers ?? (o.mcpConfigPath ? JSON.parse(readFileSync(o.mcpConfigPath, 'utf8')).mcpServers : {});
    const agentName = o.agentName ?? (o.transcriptPath ? basename(o.transcriptPath).replace(/\.jsonl$/, '') : 'agent');
    const bridgeConfig = join(dir, 'tools.json');
    writeFileSync(bridgeConfig, JSON.stringify({ servers: downstream, tools: o.tools ?? [], allowedTools: o.allowedTools ?? [], roots: [o.cwd ?? process.cwd(), ...(o.addDirs ?? [])], inbox: process.env.BUGBASH_INBOX, agentName }));
    const server = tsxServer(join(dirname(fileURLToPath(import.meta.url)), 'codexTools.ts'), { BUGBASH_CODEX_TOOLS: bridgeConfig });
    const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never'];
    for (const [k, v] of Object.entries({ approval_policy: 'never', 'features.shell_tool': false, 'features.unified_exec': false, web_search: 'disabled', mcp_servers: { bugbash_tools: { ...server, required: true, default_tools_approval_mode: 'approve' } } })) args.push('-c', `${k}=${tomlValue(v)}`);
    if (o.model) args.push('--model', o.model);
    if (o.jsonSchema) { const schema = join(dir, 'schema.json'); writeFileSync(schema, JSON.stringify(codexSchema(o.jsonSchema))); args.push('--output-schema', schema); }
    args.push('-');
    const child = execa(resolveCodexExecutable(), args, { cwd: o.cwd, input: [o.systemPrompt, 'Use only the bugbash_tools MCP tools. Native shell and filesystem mutation tools are unavailable. Check inbox between actions. The MCP Read tool can view images.', o.prompt].filter(Boolean).join('\n\n'), reject: false, timeout: o.timeoutMs, cancelSignal: o.signal, forceKillAfterDelay: 5000, buffer: { stdout: false, stderr: true } });
    let buf = '', text = '', toolCalls = 0;
    let final: StreamEvent | null = null;
    let infrastructureError: string | null = null;
    const line = (s: string) => {
      let raw;
      try { raw = JSON.parse(s); } catch { return; }
      const toolError = raw.type === 'item.completed' && raw.item?.type === 'mcp_tool_call' ? raw.item.error?.message : null;
      if (typeof toolError === 'string' && /requires approval.*approval policy is never/i.test(toolError)) infrastructureError = `Codex could not use its configured MCP tools: ${toolError}`;
      for (const e of normalizeCodexEvent(raw)) {
        if (e.type === 'assistant') for (const c of e.message?.content ?? []) { if (c.type === 'text') text = c.text ?? text; if (c.type === 'tool_use') toolCalls++; }
        if (e.type === 'result') { if (!e.is_error) e.result = text; e.duration_ms = Date.now() - started; e.num_turns = 1; final = e; }
        o.onEvent?.(e);
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => { buf += chunk.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    const res = await child;
    if (buf.trim()) line(buf);
    const f = final as StreamEvent | null;
    const ok = !!f && !f.is_error && res.exitCode === 0 && !res.timedOut && !infrastructureError;
    const error = ok ? null : infrastructureError ?? (f?.is_error ? String(f.result) : codexProcessError(res, o.timeoutMs));
    if (!ok && !f?.is_error) o.onEvent?.({ type: 'result', is_error: true, result: error ?? undefined, provider: 'codex', duration_ms: Date.now() - started });
    return { ok, text, structured: ok ? tryParseJson(text) : null, numTurns: f ? 1 : null, toolCalls, durationMs: Date.now() - started, error };

  } catch (e) {
    const error = (e as Error).message;
    o.onEvent?.({ type: 'result', is_error: true, result: error, provider: 'codex', duration_ms: Date.now() - started });
    return { ok: false, text: '', structured: null, numTurns: null, toolCalls: 0, durationMs: Date.now() - started, error };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
