# a2a-claude

[![npm version](https://img.shields.io/npm/v/a2a-claude.svg)](https://www.npmjs.com/package/a2a-claude)
[![CI](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/shashikanth-gs/a2a-wrapper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Claude Code is Anthropic's production-grade software engineering agent. It handles repository navigation, multi-step planning, shell commands, file editing, and permission management — all the plumbing you'd spend months building from scratch.

**a2a-claude** exposes it as a standalone, interoperable agent via the [A2A protocol](https://github.com/google-deepmind/a2a), using the [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Drop a JSON config file in, get a fully spec-compliant A2A server out. Any orchestrator that speaks A2A can discover and call it — no Claude-specific integration code required.

> **The pattern:** MCP is the vertical rail — how agents access tools. A2A is the horizontal rail — how agents talk to each other. This library adds the horizontal rail to Claude Code.

**Features:**
- Full [A2A v0.3.0](https://github.com/google-deepmind/a2a) protocol — Agent Card, JSON-RPC, REST, streaming
- Powered by `@anthropic-ai/claude-agent-sdk` (pinned `0.3.202`) — `claude-sonnet-5`, `claude-opus-4-8`, and any SDK-compatible model
- Permission-mode guardrails — headless-safe modes only, with an explicit opt-in for unrestricted access
- MCP tool support — stdio and Streamable HTTP transports
- Multi-turn context continuity — each A2A `contextId` maps to a persistent Claude session (resumed via the SDK's `resume` option)
- AbortController-based cancellation
- Multi-agent delegation via A2A sub-agents
- Sideband observability events — thinking summaries, tool calls, file changes, todo lists, usage/cost
- JSON config file with layered overrides (JSON → env vars → CLI flags)
- Docker-ready
- TypeScript source with full type declarations

## Quick Start

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export WORKSPACE_DIR=/path/to/your/repo

npm install
npm run dev -w a2a-claude -- --config agents/example/config.json
```

Fetch the agent card:

```bash
curl -s http://localhost:3030/.well-known/agent-card.json | jq .
```

Once published, the CLI is also runnable directly:

```bash
npm install -g a2a-claude
export ANTHROPIC_API_KEY=sk-ant-... WORKSPACE_DIR=/path/to/your/repo
a2a-claude --config agents/example/config.json
```

## Authentication

`ANTHROPIC_API_KEY` is the primary and recommended authentication path — export it before starting the agent (or set it in `.env`, see `.env.example`).

Bedrock, Vertex, and Claude Code OAuth environment variables (e.g. `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and related credentials) pass through untouched to the Claude Agent SDK — the wrapper never reads, validates, or stores them. Set whichever auth environment your deployment needs; a2a-claude only cares that the SDK's `query()` call can authenticate when invoked.

The API key (or any other credential) is **never** placed in `config.json`. Config fields that need a secret use `${ENV_VAR}` substitution instead (see MCP servers below).

## Configuration Reference

All settings live in a single JSON config file. Priority order: **built-in defaults ← config file ← environment variables ← CLI flags**.

### `claude` block fields

Fields map 1:1 onto `@anthropic-ai/claude-agent-sdk` `Options` (source of truth: `src/config/types.ts`).

| Field | Type | Description |
|---|---|---|
| `workingDirectory` | `string` | Absolute path to the workspace Claude operates on. Required at runtime. Supports `${ENV_VAR}`. |
| `model.name` | `string` | Model (e.g. `claude-sonnet-5`). Supports `${CLAUDE_MODEL}`. SDK default when omitted. |
| `model.fallback` | `string` | Fallback model when the primary is overloaded/unavailable. |
| `model.thinking` | `{ type: "adaptive" \| "disabled" \| "enabled", budgetTokens?: number }` | Extended-thinking control. `budgetTokens` (minimum `1024`) is optional but recommended with `type: "enabled"`. |
| `model.effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | Reasoning-effort hint passed through to the SDK. |
| `agents` | `Record<string, { description, prompt, tools?, disallowedTools?, model? }>` | Native Claude subagents, keyed by agent name. `description` and `prompt` are required and must be non-empty. Passed through to the SDK's `agents` option so Claude can delegate to them as native subagents (distinct from the A2A `subAgents` bridge below). |
| `skills` | `"all" \| string[]` | Skills to enable. `"all"` enables every discovered skill; an array names specific skills. See the `settingSources` caveat under **Skills** below. |
| `plugins` | `Array<{ type: "local", path: string }>` | Local plugins to load. Only `type: "local"` is supported. `path` supports `${ENV_VAR}` substitution and resolves relative to `configDir`. |
| `marketplaces` | `Record<string, { source: { source: string, ... } }>` | Plugin marketplaces to register, keyed by marketplace id. The SDK fetches and installs the plugins itself — see **Marketplace plugins** below. Every string field in `source` supports `${ENV_VAR}` substitution. |
| `enabledPlugins` | `Record<string, boolean>` | Plugins to enable, keyed `"<plugin-id>@<marketplace-id>"`. The marketplace id must appear in `marketplaces`. Startup fails if an enabled plugin does not load. |
| `outputFormat` | `{ type: "json_schema", schema: object }` | Requests a schema-conforming structured response from the SDK for every task. When set and the SDK returns `structured_output`, the wrapper publishes a second `structured-output-<taskId>` artifact — see **Artifacts** below. |
| `permissionMode` | `"acceptEdits" \| "dontAsk" \| "plan" \| "bypassPermissions"` | Permission mode. `"default"` and `"auto"` are rejected — see **Permission modes** below. Default: `"acceptEdits"`. |
| `allowedTools` | `string[]` | Tools auto-allowed without prompting. |
| `disallowedTools` | `string[]` | Tools removed from the model's context entirely. |
| `systemPromptAppend` | `string` | Appended to the `claude_code` preset system prompt. |
| `customSystemPrompt` | `string` | Full system prompt replacement. Mutually exclusive with `systemPromptAppend`. |
| `settingSources` | `Array<"user" \| "project" \| "local">` | Filesystem settings sources to load. Default `[]` = full isolation from host `~/.claude` and project settings. Include `"project"` to load workspace `CLAUDE.md`. |
| `maxTurns` | `number` | Max conversation turns per query (runaway protection). |
| `maxBudgetUsd` | `number` | Max budget in USD per query. |
| `additionalDirectories` | `string[]` | Additional directories Claude can access. Supports `${ENV_VAR}` per entry. |
| `sandbox` | `object` | Opaque SDK sandbox settings passthrough (OS-level command sandboxing). |
| `executablePathOverride` | `string` | Override the path to the Claude Code executable. |
| `dangerouslyAllowBypassPermissions` | `boolean` | Must be `true` when `permissionMode` is `"bypassPermissions"`. |
| `contextFile` | `string` | Filename for the pre-built domain context file within `workingDirectory`. Default `"context.md"`. |
| `contextPrompt` | `string` | Default prompt used when `buildContext()` is called without an explicit prompt. |

Also relevant: `features.forwardSubagentText` (`boolean`, default `false`) — forwards native-subagent `thinking`/`assistant` text to the sideband, tagged with the parent tool_use id. See **Sideband Events** below.

**Migration from Phase 1 configs:** `claude.model` is now an object: `"model": "claude-sonnet-5"` → `"model": { "name": "claude-sonnet-5" }`, and `claude.fallbackModel` → `claude.model.fallback`. The loader fails with a pointed error if the old shape is used.

### Skills

Skill discovery may interact with `settingSources` isolation (workspace skills live under `.claude/skills`). The wrapper passes the `skills` option through unchanged; if a workspace skill isn't discovered with `settingSources: []`, add `"project"` to `settingSources`. Verified behavior is documented here after the manual E2E run.

### Marketplace plugins

`plugins` requires a plugin directory that already exists on disk. `marketplaces` + `enabledPlugins` instead let the SDK fetch and install plugins itself, so nothing has to be baked into the image:

```json
"claude": {
  "marketplaces": {
    "superpowers-marketplace": {
      "source": { "source": "github", "repo": "obra/superpowers-marketplace", "ref": "v6.1.1" }
    }
  },
  "enabledPlugins": { "superpowers@superpowers-marketplace": true }
}
```

`source` is passed through to the SDK unchanged, so every source kind it supports works — `github` (`repo`), `git` (`url`), `git-subdir` (`url` + `path`, for monorepos), `url` (direct `marketplace.json`), `npm` (`package`), and local `directory`. Each accepts `ref` or `sha`.

**Pin every marketplace by `ref` or `sha`.** Plugin hooks and bundled MCP servers execute as code at the session's permission mode, so an unpinned marketplace means two sessions of the same agent can run different code.

These map to the SDK's *flag-tier* `settings`, which composes with `settingSources` rather than competing with it — marketplace plugins load even under the default `settingSources: []` isolation, and combining them with `["project"]` for `CLAUDE.md` works as expected.

Private marketplaces are cloned by `git`, so credentials must be supplied through the process environment (e.g. `GIT_ASKPASS`, or a configured credential helper) rather than per-source config.

#### Startup preflight

The SDK installs marketplace plugins **asynchronously by default** — with `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` unset it installs nothing, reports no error, and loads zero plugins on every subsequent run too. The wrapper therefore sets that flag for sessions with marketplaces configured, and `initialize()` runs a preflight that verifies each enabled plugin actually loaded:

```
Configured plugin(s) did not load: superpowers@superpowers-marketplace. Check that each
marketplace source and ref/sha is correct and that the plugin name exists in that
marketplace's manifest.
```

The check diffs the session init message's plugin list, **not** the `plugin_install` events — those report per-marketplace status, so a marketplace that clones cleanly but contains no plugin by the configured name still reports `installed` and `completed`. The probe costs no tokens (the init message precedes any model call) and warms the plugin cache so the first task doesn't pay the clone.

The preflight has no timeout of its own: the SDK already bounds marketplace fetches (an unreachable host fails in ~75s), and the session still reaches init afterwards, so a fetch failure surfaces as the precise "did not load" error above rather than a generic timeout. Tune `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS` or `CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS` if you need different bounds.

### Full config reference

```json
{
  "agentCard": {
    "name": "Claude Workspace Engineer",
    "description": "...",
    "version": "1.0.0",
    "protocolVersion": "0.3.0",
    "streaming": true,
    "defaultInputModes": ["text"],
    "defaultOutputModes": ["text"],
    "skills": [
      {
        "id": "workspace-engineering",
        "name": "Workspace Engineering",
        "description": "Inspect, modify, and validate code within the configured workspace.",
        "tags": ["code", "repository", "tests", "refactoring"]
      }
    ]
  },

  "server": {
    "port": 3030,
    "hostname": "0.0.0.0",
    "advertiseHost": "localhost",
    "advertiseProtocol": "http"
  },

  "claude": {
    "workingDirectory": "${WORKSPACE_DIR}",
    "model": { "name": "${CLAUDE_MODEL}" },
    "permissionMode": "acceptEdits",
    "settingSources": [],
    "additionalDirectories": [],
    "systemPromptAppend": "Operate only within the configured workspace."
  },

  "session": {
    "reuseByContext": true,
    "ttl": 3600000,
    "cleanupInterval": 300000
  },

  "features": {
    "streamArtifactChunks": false,
    "emitThinkingEvents": true,
    "emitToolEvents": true,
    "emitFileChangeEvents": true,
    "emitTodoEvents": true
  },

  "timeouts": {
    "prompt": 600000
  },

  "logging": {
    "level": "info"
  }
}
```

### Permission modes

Claude Code's `permissionMode` controls whether tool calls are auto-approved. Headless A2A execution cannot show an interactive approval prompt to a human, so two of the SDK's four modes are rejected at startup:

| Mode | Behaviour | Headless-safe |
|---|---|---|
| `default` | Interactive approval per tool call | **Rejected** — no human in the loop |
| `auto` | Heuristic/classifier-based approval | **Rejected** — not supported for headless A2A |
| `acceptEdits` | Auto-approve file edits; other guardrails still apply | Yes (default) |
| `dontAsk` | Never prompt; broadest auto-approval short of bypass | Yes |
| `plan` | Read/analyze only — no mutating tool calls | Yes |
| `bypassPermissions` | Unrestricted tool access | Yes, **only** with `dangerouslyAllowBypassPermissions: true` |

Setting `permissionMode: "bypassPermissions"` without `dangerouslyAllowBypassPermissions: true` throws at startup. When bypass is enabled, the executor logs a loud warning on every startup as a reminder that Claude has unrestricted tool access — only use it inside an isolated container or VM.

### `settingSources` isolation

`settingSources` defaults to `[]`, meaning Claude Code loads **no** host `~/.claude` user settings and **no** project `CLAUDE.md` / `.claude/settings.json` — every session starts from a clean, isolated slate driven entirely by `config.json`. Add `"project"` to `settingSources` to let Claude read the workspace's `CLAUDE.md` and project-level settings (useful when the target repository already documents its own conventions). Add `"user"` to load the host user's `~/.claude` settings — only do this in trusted, single-tenant deployments, since it pulls in configuration outside the agent's config file.

`strictMcpConfig` is always enabled internally (not user-configurable) — Claude is only allowed to use MCP servers explicitly declared in `config.json`, never ones discovered from ambient settings.

## Example Agents

| Config | Port | Permission mode | Description |
|---|---|---|---|
| `agents/example/config.json` | `3030` | `acceptEdits` | Workspace engineer — read + write access |
| `agents/read-only-reviewer/config.json` | `3031` | `plan` (+ `Write`/`Edit`/`NotebookEdit`/`Bash` disallowed) | Code reviewer — never modifies files or runs commands |

Each agent directory bundles a `start.sh` lifecycle script and a `workspace/` placeholder directory:

```bash
# Start in the background
agents/example/start.sh start

# Check status / health
agents/example/start.sh status

# Tail logs
agents/example/start.sh logs

# Stop
agents/example/start.sh stop

# Run in the foreground (useful for debugging / Docker)
agents/example/start.sh foreground
```

Point either agent at a real repository by overriding `WORKSPACE_DIR` before calling `start.sh`:

```bash
WORKSPACE_DIR=/path/to/repo agents/read-only-reviewer/start.sh start
```

Copy a directory to create your own agent: `cp -r agents/example agents/my-agent`.

## MCP Servers

MCP configuration is baked at SDK construction time — all servers must be declared in `config.json` before the agent starts. Only `stdio` and Streamable `http` transports are supported (SSE-only servers are rejected at startup).

```json
{
  "mcp": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${WORKSPACE_DIR}"]
    },
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${LINEAR_API_KEY}" }
    }
  }
}
```

The key **`a2a-subagents`** is reserved for the sub-agent bridge described below — using it for a user-defined MCP server fails validation at startup.

## Sub-agents

Any `a2a-claude` agent can delegate to other A2A agents by declaring them under `subAgents` in `config.json`. The wrapper bootstraps [`a2a-mcp-skillmap`](https://www.npmjs.com/package/a2a-mcp-skillmap) as a stdio MCP server registered under the reserved `a2a-subagents` key, and each remote skill becomes a callable tool for Claude (`{name}__{skillId}`). MCP calls to `a2a-subagents` are enriched with `toolKind: "a2a_subagent"` and `delegation: true` in sideband events.

See the [root README's Sub-Agents section](../README.md#calling-other-a2a-agents-sub-agents) for the full `subAgents` schema, auth modes, and a runnable example.

## Sideband Events

Sideband events are published through `AgentEventEmitter` for every Claude Agent SDK message. Use them for observability, tracing, and orchestration. Secrets are redacted (API keys, tokens, passwords, etc.) and tool output is truncated at 10,000 characters; file contents are never emitted, only path + operation kind.

| Event | Emitted when | Notes |
|---|---|---|
| `agent_started` | SDK `system`/`init` message | Includes `backend: "claude"` and the resolved model |
| `thinking` | Assistant `thinking` content block | Controlled by `features.emitThinkingEvents` |
| `tool_call_start` / `tool_call_end` | Assistant `tool_use` block / matching `tool_result` | `toolKind` is `"shell"` (Bash), `"mcp"`, `"a2a_subagent"` (mcp server `a2a-subagents`), or `"builtin"`; controlled by `features.emitToolEvents` |
| `decision` (`kind: "file_change"`) | `Edit` / `Write` / `NotebookEdit` tool call | Path and change kind only — never file contents; controlled by `features.emitFileChangeEvents` |
| `decision` (`kind: "todo_list"`) | `TodoWrite` tool call | Controlled by `features.emitTodoEvents` |
| `decision` (`kind: "permission_denied"`) | SDK `system`/`permission_denied` message | Tool name + sanitized message |
| `decision` (`kind: "subagent_result"`) | SDK `system`/`task_notification` message | Native subagent completion summary — `taskId`, `status`, and a sanitized `summary`; never the raw `output_file` path or contents |
| `agent_finished` | SDK `result`/`success` message | Includes sanitized `usage`, `totalCostUsd`, `numTurns` |
| `agent_error` | SDK `result` failure subtypes / `error` message | Sanitized error message; reason mapped from the SDK's failure subtype (e.g. max turns, max budget) |

With `features.forwardSubagentText` enabled (default `false`), `thinking`, `tool_call_start`/`tool_call_end`, and `decision` events emitted while a native Claude subagent is running also carry a `subagent: <parent_tool_use_id>` field, so consumers can attribute events to the delegating tool call. When the flag is off (the default), subagent-scoped assistant/user messages are not forwarded to the sideband at all.

## Artifacts

Each task produces a text artifact (the assistant's final response). When `claude.outputFormat` is configured and the SDK returns a `structured_output` for that turn, the wrapper publishes a second artifact, `structured-output-<taskId>`, carrying the schema-conforming object as an A2A DataPart (`mimeType: "application/json"`). Every task also publishes a `usage` trace artifact — OTel-aligned token/cost telemetry accumulated per task — whenever at least one LLM call was made, on both successful and failed tasks.

## Docker

Build from the **monorepo root** (the image needs local `@a2a-wrapper/core` source):

```bash
docker build -f a2a-claude/Dockerfile -t a2a-claude:latest .
```

Run with an API key:

```bash
docker run -p 3030:3030 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e WORKSPACE_DIR=/workspace \
  -v /host/path/to/repo:/workspace \
  a2a-claude:latest
```

See the `Dockerfile` header comment for the alternative subscription-credential mount (`~/.claude:/home/node/.claude:ro`) and its OAuth-expiry caveat.

## Manual E2E Verification

The automated test suite (`npm test -w a2a-claude`) uses a fake SDK client and never calls the real Anthropic API. To validate the full stack against a real backend, run this one-shot check with a real `ANTHROPIC_API_KEY`:

```bash
export ANTHROPIC_API_KEY=sk-ant-... WORKSPACE_DIR=/path/to/scratch-repo
npm run dev -- --config agents/example/config.json &
curl -s -X POST http://localhost:3030/a2a/jsonrpc -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": "1", "method": "message/send",
  "params": { "message": { "kind": "message", "messageId": "m1", "role": "user",
    "parts": [{ "kind": "text", "text": "List the files in this repository and summarize what it does." }] } }
}'
```

This is a manual, documented step — it is **not** part of automated CI and requires a funded Anthropic API key.

To exercise native subagent delegation and structured outputs, run the reviewer example (its config already declares the `security-checker` subagent) and ask a question that should trigger delegation, then inspect the emitted artifacts:

```bash
export ANTHROPIC_API_KEY=sk-ant-... WORKSPACE_DIR=/path/to/scratch-repo
node a2a-claude/dist/cli.js --config a2a-claude/agents/read-only-reviewer/config.json &
curl -s -X POST http://localhost:3031/a2a/jsonrpc -H 'content-type: application/json' -d '{
  "jsonrpc": "2.0", "id": "1", "method": "message/send",
  "params": { "message": { "kind": "message", "messageId": "m1", "role": "user",
    "parts": [{ "kind": "text", "text": "Delegate to the security-checker subagent to review this repository for injection, auth, and secret-handling issues." }] } }
}'
```

Verify: a `decision` sideband event with `kind: "subagent_result"` appears once the subagent completes; a `usage` trace artifact is published for the task; and — if the config additionally sets `claude.outputFormat` — a `structured-output-*` DataPart artifact appears alongside the text response.

## Phase 3 Roadmap

The following are explicitly out of scope for this release and tracked as future work:

- hooks configuration
- session forking
- `canUseTool` policy engine
- file checkpointing/rewind
- plan-mode review workflows

## License

[MIT](LICENSE) © Shashi Kanth
