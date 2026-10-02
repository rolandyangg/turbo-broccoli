# Claude and Codex providers

All agents use `runAgent`: lead, explorers, reviewers, grouping, fixes, explanations,
retrospectives, investigations, and improvement implementation. Existing model-only
configs retain Claude semantics. With no explicit selection, Settings supplies the
machine default; its initial value is Claude with the CLI's default model.

## Controls

- Settings → Default agent provider selects Claude Code or Codex and an optional model name.
- The launcher can inherit that setting or explicitly select a provider and model.
  Saved presets and schedules retain these config fields.
- A running Job → Agent provider → Switch active agents interrupts every active
  agent in that job and starts the replacement provider. The task, recent messages,
  tool inputs/results, browser sessions, and files carry over. New agents use the
  job's selection. Switching also works between models of the same provider.
- CLI: `bugbash explore <target> --provider codex --model <model-name>`.
  `--provider` and `--model` are global options available for other agent commands.
- Config: `{ "provider": "codex", "model": null }` uses the Codex CLI's default.

Install the desired CLI and sign in (`claude` or `codex login`) before selecting it.
The app uses the CLI's existing auth; it does not read or copy credentials. Model
names are free text because availability depends on the installed CLI and account.

## Handoff contract

Selection changes are checked every 250 ms. The old subprocess must exit before
its replacement starts (forced kill after 5 seconds). This is a new model session
with a bounded 32 KB handoff context, not a transfer of hidden model reasoning.
The original task, system instructions, tool permissions, and remaining timeout
are preserved. Inspect existing state before repeating a mutation: a tool in
flight at interruption may already have changed a file or browser state.
Browser MCP processes are owned by the job, so agent interruption does not close
the browser or reset call budgets. In-flight browser operations remain serialized
by their existing server. Transcripts append across handoffs and record provider changes. An unavailable
provider fails visibly rather than falling back to another provider.

## Codex capabilities

`codex exec --json --ephemeral --ignore-user-config` runs read-only with approvals
set to never, native shell disabled, and web search disabled. Only the scoped bugbash MCP server's explicitly exposed
tools are configured for headless approval. One required MCP
bridge exposes only the explicitly permitted bugbash tools and requested
Read/Grep/Glob/Edit/Write capabilities. File operations are scoped to the working
and additional directories and resolve symlinks; writes to Git metadata and agent
configuration directories are denied. Read supports image evidence. Existing
browser guardrails and campaign budgets remain enforced by their original servers.
Messages from the person watching the job are attached to tool results and are
also available through the inbox tool.

JSON schemas are adapted to Codex's strict object format. Codex events are normalized
to the existing transcript format so live feeds, tool results, and usage remain
readable. Codex does not supply dollar cost in exec events, so the existing cost
view cannot estimate its subscription cost from these events.

## Verification

Provider tests use fake adapters/CLIs and real local MCP transports, without model
calls or account access. Live account/model availability and the full visual
exploration/fix loop require a signed-in CLI and an end-to-end run.

## Startup troubleshooting

GUI-launched web servers may have a different PATH from the Codex desktop app.
Bugbash checks PATH first, then the macOS ChatGPT app's bundled Codex executable.
For another installation, set `BUGBASH_CODEX_BIN` to the absolute executable path
in the web server environment. A configured path must exist and be executable.

Startup errors retain their OS error code, signal, and CLI diagnostics in the
transcript and job error. A run where every explorer fails is marked failed and
skips triage and the retrospective, rather than publishing an empty successful
report.
