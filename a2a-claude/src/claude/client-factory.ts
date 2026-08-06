/**
 * Claude Client Factory
 *
 * The single file that imports @anthropic-ai/claude-agent-sdk. The narrow
 * ClaudeClientLike/QueryLike interfaces let unit tests inject fakes and
 * insulate the rest of the wrapper from SDK surface changes.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/types.js";
import { buildMcpServers } from "./mcp-adapter.js";

// ─── Narrow Interfaces (for testability) ────────────────────────────────────

export interface SDKMessageLike {
  type: string;
  [key: string]: unknown;
}

export interface QueryLike extends AsyncIterable<SDKMessageLike> {
  interrupt(): Promise<void>;
}

export interface QueryOptionsLike {
  cwd?: string;
  model?: string;
  fallbackModel?: string;
  effort?: string;
  thinking?: { type: string; budgetTokens?: number; display?: string };
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  settingSources?: Array<"user" | "project" | "local">;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  additionalDirectories?: string[];
  sandbox?: Record<string, unknown>;
  pathToClaudeCodeExecutable?: string;
  allowDangerouslySkipPermissions?: boolean;
  strictMcpConfig?: boolean;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  mcpServers?: Record<string, unknown>;
  resume?: string;
  abortController?: AbortController;
}

export interface ClaudeClientLike {
  runQuery(prompt: string, options: QueryOptionsLike): QueryLike;
}

// ─── Option Mapping ──────────────────────────────────────────────────────────

/**
 * Marketplace plugins are installed lazily and, by default, *asynchronously* —
 * with this flag unset the SDK installs nothing at all, reports no error, and
 * loads zero plugins on every subsequent run too. Setting it makes the install
 * complete before the session's init message, which is what makes the startup
 * preflight able to see (and fail on) a plugin that did not load.
 */
function syncPluginInstallEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env["CLAUDE_CODE_SYNC_PLUGIN_INSTALL"] = "1";
  return env;
}

/**
 * Build SDK query options from the resolved agent config plus per-turn state.
 * Hardening flags (strictMcpConfig, persistSession) are always set here and
 * are not user-configurable.
 */
export function buildQueryOptions(
  config: Required<AgentConfig>,
  turn: { resume?: string; abortController?: AbortController },
): QueryOptionsLike {
  const claude = config.claude;

  let systemPrompt: QueryOptionsLike["systemPrompt"];
  if (claude.customSystemPrompt) {
    systemPrompt = claude.customSystemPrompt;
  } else if (claude.systemPromptAppend) {
    systemPrompt = { type: "preset", preset: "claude_code", append: claude.systemPromptAppend };
  }

  const mcpServers = buildMcpServers(config.mcp ?? {});

  // `settings` is the SDK's flag-tier settings object, so marketplace plugins
  // compose with settingSources rather than competing with it — callers keeping
  // full isolation (settingSources: []) still get their plugins.
  const marketplaces = claude.marketplaces ?? {};
  const usesMarketplaces = Object.keys(marketplaces).length > 0;

  const opts: QueryOptionsLike = {
    cwd: claude.workingDirectory || undefined,
    model: claude.model || undefined,
    fallbackModel: claude.fallbackModel || undefined,
    effort: claude.effort,
    thinking: claude.thinking,
    permissionMode: claude.permissionMode ?? "acceptEdits",
    allowedTools: claude.allowedTools && claude.allowedTools.length > 0 ? claude.allowedTools : undefined,
    disallowedTools: claude.disallowedTools && claude.disallowedTools.length > 0 ? claude.disallowedTools : undefined,
    systemPrompt,
    settingSources: claude.settingSources ?? [],
    settings: usesMarketplaces
      ? {
          extraKnownMarketplaces: marketplaces as unknown as Record<string, unknown>,
          enabledPlugins: claude.enabledPlugins ?? {},
        }
      : undefined,
    env: usesMarketplaces ? syncPluginInstallEnv() : undefined,
    maxTurns: claude.maxTurns,
    maxBudgetUsd: claude.maxBudgetUsd,
    additionalDirectories:
      claude.additionalDirectories && claude.additionalDirectories.length > 0
        ? claude.additionalDirectories
        : undefined,
    sandbox: claude.sandbox,
    pathToClaudeCodeExecutable: claude.executablePathOverride || undefined,
    allowDangerouslySkipPermissions: claude.dangerouslyAllowBypassPermissions === true ? true : undefined,
    strictMcpConfig: true,
    persistSession: true,
    includePartialMessages: config.features.streamArtifactChunks === true,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    resume: turn.resume,
    abortController: turn.abortController,
  };

  return opts;
}

// ─── Real Factory ────────────────────────────────────────────────────────────

/**
 * Create a real Claude client. ANTHROPIC_API_KEY (or Bedrock/Vertex/OAuth env
 * vars) are read from the environment by the SDK — never passed via config.
 */
export function createClaudeClient(_config: Required<AgentConfig>): ClaudeClientLike {
  return {
    runQuery(prompt: string, options: QueryOptionsLike): QueryLike {
      return query({ prompt, options: options as unknown as Options }) as unknown as QueryLike;
    },
  };
}
