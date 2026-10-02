import { execa } from 'execa';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { inboxSettings } from '../jobs/inbox.js';

/**
 * Runs headless Claude Code (`claude -p`) under the user's existing login (subscription auth).
 * Every agent in bugbash — lead, explorers, triage, reviewer, fixer — goes through here.
 */
export interface ClaudeRunOptions {
  prompt: string;
  systemPrompt?: string;
  /** MCP servers: name -> {command, args, env}. */
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  mcpConfigPath?: string;
  /** Built-in tools to enable ("" = none), e.g. ["Read", "Grep", "Glob", "Edit"]. */
  tools?: string[];
  /** Tool permission allowlist, e.g. ["mcp__bugbash", "Read"]. */
  allowedTools?: string[];
  cwd?: string;
  addDirs?: string[];
  model?: string | null;
  jsonSchema?: object;
  timeoutMs?: number;
  /** Streams each JSON event line here (for session transcripts). */
  transcriptPath?: string;
  onEvent?: (e: StreamEvent) => void;
  signal?: AbortSignal;
  /** Name this agent goes by for messages from the person watching the job (default: from transcriptPath). */
  agentName?: string;
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
  result?: string;
  structured_output?: unknown;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  [k: string]: unknown;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  structured: unknown;
  numTurns: number | null;
  toolCalls: number;
  durationMs: number;
  error: string | null;
}

export async function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--no-session-persistence'];
  args.push('--tools', (o.tools ?? []).join(',') || '');
  if (o.mcpConfigPath || o.mcpServers) {
    let path = o.mcpConfigPath;
    if (!path && o.mcpServers) {
      path = `${o.transcriptPath ?? '/tmp/bugbash'}.mcp.json`;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ mcpServers: o.mcpServers }, null, 2));
    }
    args.push('--mcp-config', path!, '--strict-mcp-config');
  } else args.push('--strict-mcp-config');
  if (o.allowedTools?.length) args.push('--allowedTools', ...o.allowedTools);
  if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
  if (o.model) args.push('--model', o.model);
  if (o.jsonSchema) args.push('--json-schema', JSON.stringify(o.jsonSchema));
  for (const d of o.addDirs ?? []) args.push('--add-dir', d);
  // Messages from the person watching the job reach the agent at its next tool call (see jobs/inbox.ts).
  const inbox = process.env.BUGBASH_INBOX;
  const agentName = o.agentName ?? (o.transcriptPath ? basename(o.transcriptPath).replace(/\.jsonl$/, '').replace(/-attempt-\d+$/, '') : 'agent');
  if (inbox) args.push('--settings', inboxSettings(dirname(inbox)));

  if (o.transcriptPath) {
    mkdirSync(dirname(o.transcriptPath), { recursive: true });
    writeFileSync(o.transcriptPath, '');
  }
  const started = Date.now();
  const child = execa('claude', args, {
    cwd: o.cwd,
    input: o.prompt,
    reject: false,
    timeout: o.timeoutMs,
    cancelSignal: o.signal,
    forceKillAfterDelay: 5000,
    buffer: { stdout: false, stderr: true },
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1', ...(inbox ? { BUGBASH_INBOX: inbox, BUGBASH_AGENT: agentName } : {}) },
  });

  let final: StreamEvent | null = null;
  let lastText = '';
  let toolCalls = 0;
  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (o.transcriptPath) appendFileSync(o.transcriptPath, line + '\n');
      let e: StreamEvent;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === 'assistant') {
        for (const c of e.message?.content ?? []) {
          if (c.type === 'tool_use') toolCalls++;
          if (c.type === 'text' && c.text) lastText = c.text;
        }
      }
      if (e.type === 'result') final = e;
      o.onEvent?.(e);
    }
  });
  const res = await child;
  const durationMs = Date.now() - started;
  if (!final) {
    return { ok: false, text: lastText, structured: null, numTurns: null, toolCalls, durationMs, error: res.timedOut ? `timed out after ${o.timeoutMs}ms` : `claude exited ${res.exitCode}: ${String(res.stderr ?? '').slice(-800)}` };
  }
  const f = final as StreamEvent;
  return {
    ok: !f.is_error,
    text: (f.result as string) ?? lastText,
    structured: f.structured_output ?? tryParseJson(f.result as string),
    numTurns: f.num_turns ?? null,
    toolCalls,
    durationMs,
    error: f.is_error ? String(f.result ?? f.subtype) : null,
  };
}

/** Extracts the first JSON object/array from model text (fenced or bare). */
export function tryParseJson(text: string | undefined | null): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  for (let end = body.length; end > start; end--) {
    const ch = body[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try {
      return JSON.parse(body.slice(start, end));
    } catch {}
  }
  return null;
}

/** Command to launch one of our TS MCP servers through tsx (no build step). */
export function tsxServer(entry: string, env: Record<string, string>) {
  return { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), entry], env };
}
