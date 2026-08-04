/**
 * Event Mapper — Claude SDKMessage → A2A Sideband
 *
 * Translates @anthropic-ai/claude-agent-sdk messages into A2A sideband events
 * published via AgentEventEmitter.
 *
 * Sanitization rules (applied to all emitted data):
 * - Redact fields matching SENSITIVE_KEYS
 * - Truncate tool output to MAX_OUTPUT_LENGTH characters
 * - Never emit file contents (only path + operation kind)
 * - Never emit raw environment variable values
 */

import type { AgentEventEmitter } from "@a2a-wrapper/core";
import type { AgentConfig } from "../config/types.js";
import type { SDKMessageLike } from "./client-factory.js";
import { logger } from "../utils/logger.js";

const log = logger.child("event-mapper");

const MAX_OUTPUT_LENGTH = 10_000;
const MAX_COMMAND_LENGTH = 500;
const MAX_THINKING_LENGTH = 10_000;
const MAX_MESSAGE_LENGTH = 2_000;

const SENSITIVE_KEYS = new Set([
  "token", "access_token", "authorization", "api_key", "apikey",
  "password", "secret", "credential", "private_key", "client_secret",
]);

const FILE_TOOLS: Record<string, string> = {
  Edit: "edit",
  Write: "write",
  NotebookEdit: "edit",
};

// ─── Sanitization Helpers ─────────────────────────────────────────────────────

function redactSecrets(text: string): string {
  // Negative lookbehind (rather than \b) so compound, underscore-joined names like
  // DB_PASSWORD or API_KEY still match — "_" is a \w char and would otherwise block \b.
  return text.replace(
    /(?<![A-Za-z0-9])(api_?key|access_?token|private_?key|client_?secret|token|key|password|secret|credential|authorization)s?\s*[:=]\s*(?:Bearer\s+|Basic\s+)?\S+/gi,
    "$1=<redacted>",
  );
}

export function sanitizeMessage(msg: unknown): string {
  if (typeof msg !== "string") return "An error occurred.";
  return redactSecrets(msg).substring(0, MAX_MESSAGE_LENGTH);
}

function sanitizeData(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(sanitizeData);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "<redacted>" : sanitizeData(val);
  }
  return out;
}

function truncateOutput(output: unknown): string {
  const raw =
    typeof output === "string"
      ? output
      : output === undefined || output === null
        ? ""
        : JSON.stringify(sanitizeData(output));
  const text = redactSecrets(raw);
  if (text.length > MAX_OUTPUT_LENGTH) {
    return text.substring(0, MAX_OUTPUT_LENGTH) + `\n... [truncated, ${text.length} total chars]`;
  }
  return text;
}

// ─── EventMapper ─────────────────────────────────────────────────────────────

export class EventMapper {
  private readonly emitter: AgentEventEmitter;
  private readonly config: Required<AgentConfig>;
  /**
   * Warn at most once per EventMapper — i.e. once per A2A task, since the executor
   * constructs one per execute(). Deliberately not process-wide: a misconfigured
   * deployment should resurface on every affected task rather than going quiet.
   */
  private warnedEmptyThinking = false;
  /**
   * Stream ids of thinking blocks whose deltas have been seen, queued per SDK
   * message id. A FIFO — not an index lookup — because the SDK's assistant
   * content-array position does not match the stream content_block index.
   */
  private readonly pendingThinkingStreams = new Map<string, string[]>();
  /** Characters already emitted per thinking stream id, for the truncation budget. */
  private readonly thinkingStreamLength = new Map<string, number>();
  /** Message id of the in-flight streamed message, from the last message_start. */
  private currentStreamMessageId: string | null = null;

  constructor(emitter: AgentEventEmitter, config: Required<AgentConfig>) {
    this.emitter = emitter;
    this.config = config;
  }

  handleMessage(msg: SDKMessageLike): void {
    try {
      switch (msg.type) {
        case "system":
          this.handleSystem(msg);
          break;
        case "assistant":
          if (msg.parent_tool_use_id == null) this.handleAssistant(msg);
          break;
        case "user":
          if (msg.parent_tool_use_id == null) this.handleUser(msg);
          break;
        case "result":
          this.handleResult(msg);
          break;
        case "stream_event":
          this.handleStreamEvent(msg);
          break;
        default:
          log.debug("Unhandled SDK message type", { type: msg.type });
      }
    } catch (err) {
      log.warn("EventMapper.handleMessage error", { error: (err as Error).message, type: msg.type });
    }
  }

  private handleSystem(msg: SDKMessageLike): void {
    if (msg.subtype === "init") {
      this.emitter.emit("agent_started", {
        backend: "claude",
        model: typeof msg.model === "string" ? msg.model : "",
      });
    } else if (msg.subtype === "permission_denied") {
      this.emitter.emit("decision", {
        backend: "claude",
        kind: "permission_denied",
        tool: typeof msg.tool_name === "string" ? msg.tool_name : "<tool>",
        message: sanitizeMessage(msg.message),
      });
    }
  }

  private handleAssistant(msg: SDKMessageLike): void {
    const features = this.config.features;
    const inner = msg.message as Record<string, unknown> | undefined;
    const content = inner?.content;
    if (!Array.isArray(content)) return;

    for (const rawBlock of content) {
      const block = rawBlock as Record<string, unknown>;

      if (block.type === "thinking") {
        if (features.emitThinkingEvents) this.handleThinkingBlock(msg, block);
        continue;
      }

      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      const input = (block.input ?? {}) as Record<string, unknown>;
      const itemId = typeof block.id === "string" ? block.id : "";

      // File changes and todos are decisions, not tool_call events.
      if (name in FILE_TOOLS) {
        if (features.emitFileChangeEvents) {
          const path = typeof input.file_path === "string"
            ? input.file_path
            : typeof input.notebook_path === "string" ? input.notebook_path : "<unknown>";
          this.emitter.emit("decision", {
            backend: "claude",
            kind: "file_change",
            changes: [{ path, kind: FILE_TOOLS[name] }],
          });
        }
        continue;
      }

      if (name === "TodoWrite") {
        if (features.emitTodoEvents) {
          const todos = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
          this.emitter.emit("decision", {
            backend: "claude",
            kind: "todo_list",
            items: todos.map((t) => ({
              text: typeof t.content === "string" ? t.content : String(t.content ?? ""),
              completed: t.status === "completed",
            })),
          });
        }
        continue;
      }

      if (!features.emitToolEvents) continue;

      if (name === "Bash") {
        this.emitter.emit("tool_call_start", {
          backend: "claude",
          toolKind: "shell",
          command: typeof input.command === "string" ? redactSecrets(input.command).substring(0, MAX_COMMAND_LENGTH) : "<command>",
          itemId,
        });
      } else if (name.startsWith("mcp__")) {
        const rest = name.slice("mcp__".length);
        const sep = rest.indexOf("__");
        const server = sep >= 0 ? rest.slice(0, sep) : rest;
        const tool = sep >= 0 ? rest.slice(sep + 2) : "";
        const isDelegation = server === "a2a-subagents";
        this.emitter.emit("tool_call_start", {
          backend: "claude",
          toolKind: isDelegation ? "a2a_subagent" : "mcp",
          server,
          tool,
          itemId,
          ...(isDelegation ? { delegation: true } : {}),
        });
      } else {
        this.emitter.emit("tool_call_start", {
          backend: "claude",
          toolKind: "builtin",
          tool: name,
          itemId,
        });
      }
    }
  }

  /**
   * Publish one complete thinking block.
   *
   * An empty `thinking` string means the SDK returned the block with
   * `display: "omitted"` — the default on current models. That is a config
   * problem, not a model problem, so say so rather than dropping it silently.
   */
  private handleThinkingBlock(msg: SDKMessageLike, block: Record<string, unknown>): void {
    const raw = typeof block.thinking === "string" ? block.thinking : "";

    // Claim this block's FIFO slot before the empty-block guard. Every thinking
    // block that opened in the stream must consume its own id, or an empty block
    // leaves a stale entry for the next block to pop — closing the wrong artifact
    // and leaving the one that received the deltas open forever.
    const inner = msg.message as Record<string, unknown> | undefined;
    const messageId = typeof inner?.id === "string" ? inner.id : null;
    const streamId = messageId ? this.takePendingThinkingStream(messageId) : null;
    if (streamId) this.thinkingStreamLength.delete(streamId);

    if (!raw) {
      if (!this.warnedEmptyThinking) {
        this.warnedEmptyThinking = true;
        log.warn(
          'Received a thinking block with no content, which means the SDK returned display: "omitted". ' +
          'If claude.thinking is set below, that setting is the cause — change its display to "summarized". ' +
          "If it is null, the wrapper already requested summarized thinking and the model or SDK version did not honour it.",
          { configuredThinking: this.config.claude.thinking ?? null },
        );
      }
      return;
    }

    const content = redactSecrets(raw).substring(0, MAX_THINKING_LENGTH);

    // Mirrors publishLastChunkMarker for response text: the complete block is
    // re-sent as the closing chunk so a consumer that missed deltas still gets
    // the whole thought. With no deltas, it is a standalone artifact as before.
    if (streamId) {
      this.emitter.emit("thinking", { content }, { id: streamId, lastChunk: true });
      return;
    }
    this.emitter.emit("thinking", { content });
  }

  /**
   * Emit incremental thinking from raw stream events.
   *
   * Only runs when artifact streaming is on, because `includePartialMessages`
   * is itself derived from that flag. Each thinking block is registered on a
   * per-message FIFO at `content_block_start` and consumed by the matching
   * complete block in `handleAssistant`.
   */
  private handleStreamEvent(msg: SDKMessageLike): void {
    const features = this.config.features;
    if (!features.emitThinkingEvents) return;
    if (features.streamArtifactChunks !== true) return;
    if (msg.parent_tool_use_id != null) return;

    const event = msg.event as Record<string, unknown> | undefined;
    if (!event) return;

    if (event.type === "message_start") {
      const message = event.message as Record<string, unknown> | undefined;
      this.currentStreamMessageId = typeof message?.id === "string" ? message.id : null;
      return;
    }

    const messageId = this.currentStreamMessageId;
    if (!messageId) return;
    const streamId = `${messageId}-${String(event.index ?? 0)}`;

    if (event.type === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type !== "thinking") return;
      const queue = this.pendingThinkingStreams.get(messageId) ?? [];
      queue.push(streamId);
      this.pendingThinkingStreams.set(messageId, queue);
      this.thinkingStreamLength.set(streamId, 0);
      return;
    }

    if (event.type !== "content_block_delta") return;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type !== "thinking_delta" || typeof delta.thinking !== "string") return;

    // Unknown stream id means this block never opened as a thinking block.
    const used = this.thinkingStreamLength.get(streamId);
    if (used === undefined || used >= MAX_THINKING_LENGTH) return;

    const text = redactSecrets(delta.thinking).substring(0, MAX_THINKING_LENGTH - used);
    if (!text) return;
    this.thinkingStreamLength.set(streamId, used + text.length);
    this.emitter.emit("thinking", { content: text }, { id: streamId, lastChunk: false });
  }

  /** Pop the next unmatched streamed thinking block for this message, if any. */
  private takePendingThinkingStream(messageId: string): string | null {
    const queue = this.pendingThinkingStreams.get(messageId);
    if (!queue || queue.length === 0) return null;
    const streamId = queue.shift() as string;
    if (queue.length === 0) this.pendingThinkingStreams.delete(messageId);
    return streamId;
  }

  private handleUser(msg: SDKMessageLike): void {
    if (!this.config.features.emitToolEvents) return;
    const inner = msg.message as Record<string, unknown> | undefined;
    const content = inner?.content;
    if (!Array.isArray(content)) return;

    for (const rawBlock of content) {
      const block = rawBlock as Record<string, unknown>;
      if (block.type !== "tool_result") continue;
      this.emitter.emit("tool_call_end", {
        backend: "claude",
        itemId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        output: truncateOutput(block.content),
        status: block.is_error === true ? "error" : "completed",
      });
    }
  }

  private handleResult(msg: SDKMessageLike): void {
    if (msg.subtype === "success") {
      this.emitter.emit("agent_finished", {
        backend: "claude",
        usage: sanitizeData(msg.usage) ?? null,
        totalCostUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
        numTurns: typeof msg.num_turns === "number" ? msg.num_turns : null,
      });
      return;
    }

    const reasons: Record<string, string> = {
      error_max_turns: "Turn limit reached (max_turns).",
      error_max_budget_usd: "Budget limit reached (max_budget_usd).",
      error_during_execution: "Error during execution.",
      error_max_structured_output_retries: "Structured output retries exhausted.",
    };
    const errs = Array.isArray(msg.errors) ? (msg.errors as unknown[]).map((e) => sanitizeMessage(String(e))) : [];
    this.emitter.emit("agent_error", {
      backend: "claude",
      message: reasons[String(msg.subtype)] ?? `Execution failed (${String(msg.subtype)}).`,
      ...(errs.length > 0 ? { errors: errs } : {}),
    });
  }
}
