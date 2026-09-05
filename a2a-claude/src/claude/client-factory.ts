/**
 * Claude Client Factory
 *
 * The single file that imports @anthropic-ai/claude-agent-sdk. The narrow
 * ClaudeClientLike/QueryLike interfaces let unit tests inject fakes and
 * insulate the rest of the wrapper from SDK surface changes.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig, ClaudeThinkingConfig } from "../config/types.js";
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
/**
 * Resolve the `thinking` option actually sent to the SDK.
 *
 * The SDK leaves `display` at "omitted", which makes the model emit thinking
 * blocks whose text is an empty string — so `features.emitThinkingEvents` has
 * nothing to publish and the sideband stays silent. Whenever those events are
 * enabled, ask for summaries: supply a full adaptive config when the caller set
 * no thinking at all, and fill in `display` when they set one without it.
 *
 * An explicit `display` is always honoured, including "omitted", and
 * `type: "disabled"` is left untouched — both are deliberate opt-outs.
 */
function resolveThinking(
  thinking: ClaudeThinkingConfig | undefined,
  emitThinkingEvents: boolean | undefined,
): ClaudeThinkingConfig | undefined {
  if (!emitThinkingEvents) return thinking;
  if (!thinking) return { type: "adaptive", display: "summarized" };
  if (thinking.type === "disabled" || thinking.display !== undefined) return thinking;
  return { ...thinking, display: "summarized" };
}

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
    thinking: resolveThinking(claude.thinking, config.features.emitThinkingEvents),
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
 *
 * The prompt is delivered in **streaming-input mode** (an `AsyncIterable` of one
 * user message) rather than as a plain string. This is what makes `query.interrupt()`
 * available: the SDK only accepts control requests — interrupt among them — when
 * the input is a stream. A graceful interrupt lets the turn stop and the Claude
 * subprocess exit cleanly, so the session persists intact and the next turn can
 * resume it; aborting the process instead truncates the session mid-write, which
 * makes the following resume return an empty turn.
 */
export function createClaudeClient(_config: Required<AgentConfig>): ClaudeClientLike {
  return {
    runQuery(prompt: string, options: QueryOptionsLike): QueryLike {
      return runStreamingQuery(prompt, options);
    },
  };
}

/** The subset of the SDK's `Query` this module drives — an async message stream
 *  plus `interrupt()`. Injectable so the streaming-input wiring can be tested
 *  without spawning the real Claude CLI. */
export interface StreamingQuery extends AsyncIterable<SDKMessageLike> {
  interrupt(): Promise<unknown>;
}

export type StreamingQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => StreamingQuery;

const defaultQueryFn: StreamingQueryFn = (params) =>
  query(params) as unknown as StreamingQuery;

/**
 * Drive a single-turn query through streaming input. One user message is yielded,
 * then the input is held open — the control channel interrupt() rides on shares
 * the input stream, so closing it early would disable interrupt. Once the turn's
 * terminal `result` arrives the input is closed, letting the CLI shut the session
 * down cleanly and the output iterator complete.
 */
export function runStreamingQuery(
  prompt: string,
  options: QueryOptionsLike,
  queryFn: StreamingQueryFn = defaultQueryFn,
): QueryLike {
  let closeInput!: () => void;
  const inputClosed = new Promise<void>((resolve) => {
    closeInput = resolve;
  });

  async function* inputStream(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    } as SDKUserMessage;
    await inputClosed;
  }

  const q = queryFn({ prompt: inputStream(), options: options as unknown as Options });

  async function* output(): AsyncGenerator<SDKMessageLike> {
    try {
      for await (const msg of q) {
        yield msg;
        // A single turn ends at its terminal result. Closing the input lets the
        // query complete so this loop — and the caller's — ends rather than
        // blocking for a next turn that will never be sent.
        if (msg.type === "result") closeInput();
      }
    } finally {
      // The caller broke out early (cancel/timeout teardown) — release the input
      // so the query cannot leak a hung subprocess.
      closeInput();
    }
  }

  return {
    [Symbol.asyncIterator]: () => output(),
    interrupt: () => q.interrupt().then(() => undefined),
  };
}
