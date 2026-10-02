import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCodex } from '../src/llm/codex.js';
afterEach(() => vi.unstubAllEnvs());
describe('Codex subprocess protocol', () => {
  it('passes permissions, model, stdin and output schema; consumes the final line without a newline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-fake-codex-')); const log = join(dir, 'args.json');
    writeFileSync(join(dir, 'codex'), `#!${process.execPath}\nconst fs = require('node:fs'); let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const args=process.argv.slice(2); fs.writeFileSync(process.env.BB_ARGS, JSON.stringify({args,input,schema:JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'))})); process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"visible":true}'}})+'\\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:3,output_tokens:4}})); });`, { mode: 0o755 });
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`); vi.stubEnv('BB_ARGS', log);
    const events: any[] = [];
    const r = await runCodex({ prompt: 'Inspect the image', systemPrompt: 'Be skeptical', model: 'custom', cwd: dir, jsonSchema: { type: 'object', properties: { visible: { type: 'boolean' } }, required: ['visible'] }, onEvent: (e) => events.push(e) });
    expect(r).toMatchObject({ ok: true, text: '{"visible":true}', structured: { visible: true } });
    const captured = JSON.parse(readFileSync(log, 'utf8'));
    expect(captured.args.find((arg: string) => arg.startsWith('mcp_servers='))).toContain('\"default_tools_approval_mode\" = \"approve\"');
    expect(captured.args).toContain('--ignore-user-config'); expect(captured.args).toContain('read-only'); expect(captured.args).toContain('approval_policy="never"'); expect(captured.args).toContain('features.shell_tool=false'); expect(captured.args).toContain('web_search="disabled"');
    expect(captured.input).toContain('Be skeptical'); expect(captured.input).toContain('Inspect the image'); expect(captured.schema.additionalProperties).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', result: '{"visible":true}', is_error: false });
  });
  it('does not treat text from a nonzero process exit as success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-fake-codex-'));
    writeFileSync(join(dir, 'codex'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'partial'}})+'\\n'); process.stderr.write('login required'); process.exit(1);`, { mode: 0o755 });
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    expect(await runCodex({ prompt: 'x', cwd: dir })).toMatchObject({ ok: false, text: 'partial', structured: null, error: expect.stringContaining('login required') });
  });
  it('records actionable spawn errors even when there is no exit code or stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-broken-codex-'));
    const file = join(dir, 'codex');
    writeFileSync(file, '#!/missing/codex-interpreter\n', { mode: 0o755 });
    vi.stubEnv('BUGBASH_CODEX_BIN', file);
    const events: any[] = [];
    const r = await runCodex({ prompt: 'x', cwd: dir, onEvent: e => events.push(e) });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('ENOENT') });
    expect(r.error).not.toContain('undefined');
    expect(events.at(-1)).toMatchObject({ type: 'result', is_error: true, result: expect.stringContaining('ENOENT') });
  });

  it('fails the run when MCP approval blocks tools even if the model reports a successful turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-denied-codex-'));
    const file = join(dir, 'codex');
    writeFileSync(file, `#!${process.execPath}\nfor(const e of [{type:'item.completed',item:{id:'blocked',type:'mcp_tool_call',status:'failed',error:{message:'MCP tool call requires approval, but approval policy is never'}}},{type:'item.completed',item:{type:'agent_message',text:'No findings'}},{type:'turn.completed'}]) process.stdout.write(JSON.stringify(e)+'\\n');`, { mode: 0o755 });
    vi.stubEnv('BUGBASH_CODEX_BIN', file);
    expect(await runCodex({ prompt: 'x', cwd: dir })).toMatchObject({ ok: false, error: expect.stringContaining('could not use its configured MCP tools') });
  });

});
