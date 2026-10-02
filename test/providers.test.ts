import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config, pickConfig } from '../src/config.js';
import { resolveSelection, saveSelection } from '../src/llm/selection.js';
import { codexSchema, normalizeCodexEvent, tomlValue } from '../src/llm/codex.js';

const adapters = vi.hoisted(() => ({ claude: vi.fn(), codex: vi.fn() }));
vi.mock('../src/llm/claude.js', async (original) => ({ ...await original<typeof import('../src/llm/claude.js')>(), runClaude: adapters.claude }));
vi.mock('../src/llm/codex.js', async (original) => ({ ...await original<typeof import('../src/llm/codex.js')>(), runCodex: adapters.codex }));
import { runAgent } from '../src/llm/runner.js';
const result = { ok: true, text: 'done', structured: null, numTurns: 1, toolCalls: 0, durationMs: 1, error: null };
function isolated() { const dir = mkdtempSync(join(tmpdir(), 'bb-providers-')); vi.stubEnv('BUGBASH_HOME', dir); vi.stubEnv('BUGBASH_MODEL_SELECTION', join(dir, 'job.json')); vi.stubEnv('BUGBASH_PROVIDER', ''); vi.stubEnv('BUGBASH_MODEL', ''); return dir; }
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('model selection and provider compatibility', () => {
  it('retains Claude defaults and accepts Codex presets', () => {
    isolated();
    expect(resolveSelection({})).toEqual({ provider: 'claude', model: null });
    expect(Config.parse({ model: 'sonnet' }).provider).toBe(null);
    expect(pickConfig({ provider: 'codex', model: 'custom-model' })).toMatchObject({ ok: true, config: { provider: 'codex', model: 'custom-model' } });
    expect(pickConfig({ provider: 'other' }).ok).toBe(false);
  });
  it('prioritizes live job selection over CLI/config/default without mixing model names', () => {
    const dir = isolated(); saveSelection(join(dir, 'models.json'), { provider: 'codex', model: 'account-model' });
    expect(resolveSelection({})).toEqual({ provider: 'codex', model: 'account-model' });
    expect(resolveSelection({ model: 'sonnet' })).toEqual({ provider: 'claude', model: 'sonnet' });
    vi.stubEnv('BUGBASH_PROVIDER', 'claude'); vi.stubEnv('BUGBASH_MODEL', 'opus');
    expect(resolveSelection({ provider: 'codex' }).model).toBe('opus');
    saveSelection(join(dir, 'job.json'), { provider: 'codex', model: null });
    expect(resolveSelection({ model: 'haiku' })).toEqual({ provider: 'codex', model: null });
  });
  it('adapts nested optional schemas without changing the original', () => {
    const source = { type: 'object', properties: { visible: { type: 'boolean' }, note: { type: 'string' }, groups: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } } }, required: ['visible'] };
    const converted = codexSchema(source);
    expect(converted.additionalProperties).toBe(false);
    expect(converted.required).toEqual(['visible', 'note', 'groups']);
    expect(converted.properties.note.anyOf[1]).toEqual({ type: 'null' });
    expect(converted.properties.groups.anyOf[0].items.additionalProperties).toBe(false);
    expect(source.required).toEqual(['visible']);
    expect(tomlValue({ command: 'node', env: { KEY: 'a"b' }, args: ['--import', 'tsx'] })).toBe('{ "command" = "node", "env" = { "KEY" = "a\\"b" }, "args" = ["--import", "tsx"] }');
  });
  it('normalizes MCP calls, image results, errors, and token usage', () => {
    expect(normalizeCodexEvent({ type: 'item.started', item: { id: 't1', type: 'mcp_tool_call', server: 'bugbash_tools', tool: 'bugbash__record_finding', arguments: { title: 'x' } } })[0].message?.content?.[0]).toMatchObject({ name: 'mcp__bugbash__record_finding', input: { title: 'x' } });
    expect(normalizeCodexEvent({ type: 'item.completed', item: { id: 't1', type: 'mcp_tool_call', status: 'failed', error: { message: 'blocked' } } })[0].message?.content?.[0]).toMatchObject({ type: 'tool_result', is_error: true, tool_use_id: 't1' });
    expect(normalizeCodexEvent({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 } })[0].usage).toEqual({ input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 10 });
  });
});

describe('active agent handoff', () => {
  it('interrupts the old process before starting the replacement with task, progress, tools, and remaining timeout', async () => {
    const dir = isolated(); const file = join(dir, 'job.json'); let stopped = false;
    saveSelection(file, { provider: 'claude', model: 'sonnet' });
    adapters.claude.mockImplementation(async (o) => {
      o.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Already opened /pricing' }, { type: 'tool_use', name: 'mcp__bugbash__click', input: { ref: 'buy' } }] } });
      saveSelection(file, { provider: 'codex', model: 'account-model' });
      await new Promise<void>((resolve) => o.signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
      throw new Error('cancelled');
    });
    adapters.codex.mockImplementation(async (o) => { expect(stopped).toBe(true); expect(o.prompt).toContain('Already opened /pricing'); expect(o.prompt).toContain('Inspect current state before repeating'); expect(o.model).toBe('account-model'); expect(o.systemPrompt).toBe('guardrails'); expect(o.tools).toEqual(['Read']); expect(o.timeoutMs).toBeLessThan(5000); return result; });
    const r = await runAgent({ prompt: 'Explore the site', systemPrompt: 'guardrails', tools: ['Read'], timeoutMs: 5000, transcriptPath: join(dir, 's-001.jsonl') });
    expect(r.ok).toBe(true); expect(r.toolCalls).toBe(1); expect(adapters.codex).toHaveBeenCalledOnce();
    expect(adapters.codex.mock.calls[0][0].agentName).toBe('s-001');
    const transcript = readFileSync(join(dir, 's-001.jsonl'), 'utf8'); expect(transcript).toContain('"subtype":"handoff"'); expect(transcript).toContain('Already opened');
  });
  it('returns provider errors without silently falling back', async () => {
    isolated(); adapters.codex.mockRejectedValue(new Error('codex not installed'));
    expect(await runAgent({ prompt: 'x', provider: 'codex' })).toMatchObject({ ok: false, error: 'codex not installed' }); expect(adapters.claude).not.toHaveBeenCalled();
  });
  it('does not start an agent when already cancelled', async () => {
    isolated(); const controller = new AbortController(); controller.abort();
    expect(await runAgent({ prompt: 'x', signal: controller.signal })).toMatchObject({ ok: false, error: 'cancelled' }); expect(adapters.claude).not.toHaveBeenCalled();
  });
});
