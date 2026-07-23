/**
 * Agent Configuration — Type Definitions
 *
 * All configurable aspects of an A2A Claude agent deployment.
 * A single JSON file (or programmatic object) drives the entire wrapper.
 */

import type {
  EventsConfig,
  MemoryConfig,
  SubAgentsConfig,
} from "@a2a-wrapper/core";

// ─── Agent Card Config ──────────────────────────────────────────────────────

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

export interface AgentCardConfig {
  name: string;
  description: string;
  protocolVersion?: string;
  version?: string;
  skills?: SkillConfig[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  streaming?: boolean;
  pushNotifications?: boolean;
  /** @deprecated Kept for backward compatibility. Ignored by the agent card builder. */
  stateTransitionHistory?: boolean;
  provider?: { organization: string; url?: string };
}

// ─── Server Config ──────────────────────────────────────────────────────────

export interface ServerConfig {
  port?: number;
  hostname?: string;
  /**
   * Hostname advertised in agent card URLs (default: "localhost").
   * Set to machine IP or "host.containers.internal" for Docker.
   */
  advertiseHost?: string;
  /**
   * Protocol used in advertised URLs (default: "http").
   * Set to "https" when deployed behind TLS or a TLS-terminating reverse proxy.
   */
  advertiseProtocol?: "http" | "https";
}

// ─── Claude Backend Config ──────────────────────────────────────────────────

export type ClaudePermissionMode = "acceptEdits" | "dontAsk" | "plan" | "bypassPermissions";

/**
 * Claude Agent SDK connection and execution settings.
 * Fields map 1:1 onto @anthropic-ai/claude-agent-sdk Options (see spec §3.1).
 */
export interface ClaudeModelConfig {
  /** Model (e.g. "claude-sonnet-5"). Supports ${CLAUDE_MODEL}. SDK default when omitted. */
  name?: string;
  /** Fallback model when the primary is overloaded/unavailable. */
  fallback?: string;
  /** Extended thinking behavior. */
  thinking?: { type: "adaptive" } | { type: "disabled" } | { type: "enabled"; budgetTokens: number };
  /** Reasoning effort level. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ClaudeAgentDefinitionConfig {
  /** What this agent does — surfaced to the orchestrating model for delegation decisions. */
  description: string;
  /** The subagent's system prompt. */
  prompt: string;
  /** Tools auto-allowed without prompting, scoped to this subagent. */
  tools?: string[];
  /** Tools removed from this subagent's context entirely. */
  disallowedTools?: string[];
  /** Model override for this subagent. Falls back to the top-level model when omitted. */
  model?: string;
  // Forward-compatible passthrough for future SDK Options.agents fields.
  [key: string]: unknown;
}

export interface ClaudePluginConfig {
  /** Only local plugins are supported. */
  type: "local";
  /** Filesystem path to the plugin. Resolves against configDir; supports ${ENV_VAR}. */
  path: string;
}

export interface ClaudeMarketplaceSourceConfig {
  /** Source kind — e.g. "github", "git", "url", "npm", "directory". */
  source: string;
  // Forward-compatible passthrough for source-specific fields (repo, url, ref,
  // sha, path, package, headers, …). Every string value supports ${ENV_VAR}.
  [key: string]: unknown;
}

export interface ClaudeMarketplaceConfig {
  /** Where to fetch the marketplace from. */
  source: ClaudeMarketplaceSourceConfig;
  // Forward-compatible passthrough for installLocation, autoUpdate, …
  [key: string]: unknown;
}

export interface StructuredOutputFormatConfig {
  /** Only JSON Schema structured output is supported. */
  type: "json_schema";
  /** The JSON Schema every task's DataPart artifact must conform to. */
  schema: Record<string, unknown>;
}

export interface ClaudeConfig {
  /** Absolute path to the workspace Claude operates on. Required at runtime. Supports ${ENV_VAR}. */
  workingDirectory?: string;
  /** Model selection and reasoning behavior. */
  model?: ClaudeModelConfig;
  /** Native Claude subagents, keyed by agent name → SDK Options.agents. */
  agents?: Record<string, ClaudeAgentDefinitionConfig>;
  /** Skills to enable: "all" or a list of skill names. */
  skills?: "all" | string[];
  /** Local plugins to load. Paths resolve against configDir; ${ENV_VAR} supported. */
  plugins?: ClaudePluginConfig[];
  /**
   * Plugin marketplaces to register for the session, keyed by marketplace id.
   * Maps to the SDK's `settings.extraKnownMarketplaces`, so the SDK fetches and
   * installs the plugins itself — no pre-baked plugin directories required.
   * Pin every marketplace by `ref` or `sha`: plugin hooks and bundled MCP
   * servers execute at the session's permission mode.
   */
  marketplaces?: Record<string, ClaudeMarketplaceConfig>;
  /**
   * Plugins to enable, keyed `"<plugin-id>@<marketplace-id>"`, where the
   * marketplace id must appear in `marketplaces`. Maps to the SDK's
   * `settings.enabledPlugins`. Startup fails if an enabled plugin does not
   * load — see the plugin preflight in the executor.
   */
  enabledPlugins?: Record<string, boolean>;
  /** Per-agent structured output schema. Every task returns a DataPart artifact matching it. */
  outputFormat?: StructuredOutputFormatConfig;
  /**
   * Permission mode. "default" and "auto" are rejected — they require an
   * interactive approver / classifier, incompatible with headless A2A.
   * @default "acceptEdits"
   */
  permissionMode?: ClaudePermissionMode;
  /** Tools auto-allowed without prompting. */
  allowedTools?: string[];
  /** Tools removed from the model's context entirely. */
  disallowedTools?: string[];
  /** Appended to the claude_code preset system prompt (developerInstructions analog). */
  systemPromptAppend?: string;
  /** Full system prompt replacement. Mutually exclusive with systemPromptAppend. */
  customSystemPrompt?: string;
  /**
   * Filesystem settings sources to load. Default [] = full isolation from
   * host ~/.claude and project settings. Include "project" to load CLAUDE.md.
   */
  settingSources?: Array<"user" | "project" | "local">;
  /** Max conversation turns per query (runaway protection). */
  maxTurns?: number;
  /** Max budget in USD per query. */
  maxBudgetUsd?: number;
  /** Additional directories Claude can access. Supports ${ENV_VAR} per entry. */
  additionalDirectories?: string[];
  /** Opaque SDK sandbox settings passthrough (OS-level command sandboxing). */
  sandbox?: Record<string, unknown>;
  /** Override the path to the Claude Code executable. */
  executablePathOverride?: string;
  /** Must be true when permissionMode is "bypassPermissions". */
  dangerouslyAllowBypassPermissions?: boolean;
  /** Filename for the pre-built domain context file within workingDirectory. @default "context.md" */
  contextFile?: string;
  /** Default prompt used when buildContext() is called without an explicit prompt. */
  contextPrompt?: string;
}

// ─── Session Config ─────────────────────────────────────────────────────────

export interface SessionConfig {
  titlePrefix?: string;
  /** Reuse sessions by A2A contextId (default: true) */
  reuseByContext?: boolean;
  /** Session TTL in ms (default: 3_600_000 = 1 hour) */
  ttl?: number;
  /** Session cleanup interval in ms (default: 300_000 = 5 min) */
  cleanupInterval?: number;
}

// ─── Feature Flags ──────────────────────────────────────────────────────────

export interface FeatureFlags {
  /** Stream artifact chunks (A2A spec-correct) vs single buffered artifact. Default: false. */
  streamArtifactChunks?: boolean;
  /** Publish thinking summaries as sideband events. Default: true. */
  emitThinkingEvents?: boolean;
  /** Publish tool_call_start/end sideband events. Default: true. */
  emitToolEvents?: boolean;
  /** Publish file change metadata as sideband events. Default: true. */
  emitFileChangeEvents?: boolean;
  /** Publish todo-list updates as sideband events. Default: true. */
  emitTodoEvents?: boolean;
  /** Forward subagent text/thinking to the sideband, tagged with the parent tool_use id. Default: false. */
  forwardSubagentText?: boolean;
}

// ─── Timeout Config ─────────────────────────────────────────────────────────

export interface TimeoutConfig {
  /** Timeout for a single prompt in ms (default: 600_000 = 10 min) */
  prompt?: number;
}

// ─── Logging Config ─────────────────────────────────────────────────────────

export interface LoggingConfig {
  level?: string;
}

// ─── MCP Server Config ──────────────────────────────────────────────────────

export interface McpStdioServerConfig {
  type: "stdio";
  /** Command to launch the MCP server. */
  command: string;
  /** Arguments. Values support ${ENV_VAR} substitution. */
  args?: string[];
  /** Environment variables for the spawned process. Values support ${ENV_VAR} substitution. */
  env?: Record<string, string>;
  enabled?: boolean;
  /** MCP server startup timeout in seconds. */
  startupTimeoutSec?: number;
  /** Per-tool call timeout in seconds. */
  toolTimeoutSec?: number;
  /** Allowlist of tool names to expose. If set, only these tools are accessible. */
  enabledTools?: string[];
  /** Denylist of tool names to block. */
  disabledTools?: string[];
}

export interface McpHttpServerConfig {
  type: "http";
  /** URL of the Streamable HTTP MCP server. */
  url: string;
  /**
   * HTTP headers sent with every request.
   * Values support ${ENV_VAR} substitution.
   * Use for bearer tokens: { "Authorization": "Bearer ${TOKEN}" }
   */
  headers?: Record<string, string>;
  enabled?: boolean;
  toolTimeoutSec?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | { type: string; [k: string]: unknown };

// ─── Root Config ────────────────────────────────────────────────────────────

/**
 * Complete agent configuration.
 *
 * This is what a JSON config file (e.g. `agents/example/config.json`) maps to.
 * All fields except `agentCard` are optional — sensible secure defaults are applied.
 */
export interface AgentConfig {
  agentCard: AgentCardConfig;
  server?: ServerConfig;
  /** Claude Agent SDK settings. */
  claude?: ClaudeConfig;
  session?: SessionConfig;
  features?: FeatureFlags;
  timeouts?: TimeoutConfig;
  logging?: LoggingConfig;
  /** MCP servers. The key "a2a-subagents" is reserved for the sub-agent bridge. */
  mcp?: Record<string, McpServerConfig>;
  events?: EventsConfig;
  memory?: MemoryConfig;
  subAgents?: SubAgentsConfig;
  /** Populated automatically by the CLI loader. Do not set manually. */
  configDir?: string;
}
