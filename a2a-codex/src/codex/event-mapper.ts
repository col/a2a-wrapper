/**
 * Event Mapper — Codex ThreadEvent → A2A Sideband
 *
 * Translates @openai/codex-sdk ThreadEvent and ThreadItem instances into
 * A2A sideband events published via AgentEventEmitter.
 *
 * Sanitization rules (applied to all emitted data):
 * - Redact fields matching SENSITIVE_KEYS
 * - Truncate command output to MAX_OUTPUT_LENGTH characters
 * - Never emit file contents (only path + operation kind)
 * - Never emit raw reasoning text (only summaries)
 * - Never emit raw environment variable values
 */

import type { AgentEventEmitter } from "@a2a-wrapper/core";
import type { AgentConfig } from "../config/types.js";
import type { ThreadEventLike, ThreadItemLike } from "./client-factory.js";
import { logger } from "../utils/logger.js";

const log = logger.child("event-mapper");

const MAX_OUTPUT_LENGTH = 10_000;

const SENSITIVE_KEYS = new Set([
  "token",
  "access_token",
  "authorization",
  "api_key",
  "apikey",
  "password",
  "secret",
  "credential",
  "private_key",
  "client_secret",
]);

// ─── Sanitization Helpers ─────────────────────────────────────────────────────

function sanitizeMessage(msg: unknown): string {
  if (typeof msg !== "string") return "An error occurred.";
  // Remove anything that looks like a secret value (key=value patterns)
  return msg
    .replace(/\b(token|key|password|secret|credential)s?\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .substring(0, 2000);
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
  if (typeof output !== "string") return "";
  // JSON consumers such as Postgres jsonb reject \u0000, so replace NUL with U+FFFD.
  const text = output.replaceAll("\u0000", "\uFFFD");
  if (text.length > MAX_OUTPUT_LENGTH) {
    return text.substring(0, MAX_OUTPUT_LENGTH) + `\n... [truncated, ${text.length} total chars]`;
  }
  return text;
}

// ─── EventMapper ─────────────────────────────────────────────────────────────

export class EventMapper {
  private readonly emitter: AgentEventEmitter;
  private readonly config: Required<AgentConfig>;

  constructor(emitter: AgentEventEmitter, config: Required<AgentConfig>) {
    this.emitter = emitter;
    this.config = config;
  }

  /**
   * Handle a top-level ThreadEvent.
   * Returns the thread_id if this is a thread.started event (for session capture).
   */
  handleEvent(event: ThreadEventLike): string | undefined {
    try {
      switch (event.type) {
        case "thread.started":
          log.debug("Thread started", { thread_id: event.thread_id });
          return event.thread_id as string | undefined;

        case "turn.started":
          log.debug("Turn started");
          this.emitter.emit("agent_started", { backend: "codex" });
          break;

        case "turn.completed":
          log.debug("Turn completed", { usage: event.usage });
          this.emitter.emit("agent_finished", {
            backend: "codex",
            usage: sanitizeData(event.usage) ?? null,
          });
          break;

        case "turn.failed": {
          const errMsg = sanitizeMessage((event.error as Record<string, unknown>)?.message);
          log.warn("Turn failed", { message: errMsg });
          this.emitter.emit("agent_error", { backend: "codex", message: errMsg });
          break;
        }

        case "item.started":
          this.handleItem(event.item as ThreadItemLike, "started");
          break;

        case "item.updated":
          this.handleItem(event.item as ThreadItemLike, "updated");
          break;

        case "item.completed":
          this.handleItem(event.item as ThreadItemLike, "completed");
          break;

        case "error": {
          const errMsg = sanitizeMessage(event.message);
          log.error("Stream error", { message: errMsg });
          this.emitter.emit("agent_error", { backend: "codex", message: errMsg });
          break;
        }

        default:
          log.debug("Unknown thread event type", { type: event.type });
      }
    } catch (err) {
      log.warn("EventMapper.handleEvent error", { error: (err as Error).message, type: event.type });
    }
    return undefined;
  }

  /**
   * Handle a ThreadItem embedded in an item.* event.
   */
  handleItem(item: ThreadItemLike, phase: "started" | "updated" | "completed"): void {
    if (!item) return;
    const features = this.config.features;

    try {
      switch (item.type) {
        case "reasoning":
          if (features.emitReasoningSummaries && phase === "completed") {
            const summary = typeof item.text === "string" ? item.text : "";
            if (summary) {
              this.emitter.emit("thinking", { content: summary });
            }
          }
          break;

        case "command_execution":
          if (features.emitCommandEvents) {
            if (phase === "started") {
              this.emitter.emit("tool_call_start", {
                backend: "codex",
                toolKind: "shell",
                command: typeof item.command === "string"
                  ? item.command.substring(0, 500)
                  : "<command>",
                itemId: item.id,
              });
            } else if (phase === "completed") {
              this.emitter.emit("tool_call_end", {
                backend: "codex",
                toolKind: "shell",
                itemId: item.id,
                exitCode: item.exit_code ?? null,
                output: truncateOutput(item.aggregated_output),
                status: item.status ?? "completed",
              });
            }
          }
          break;

        case "mcp_tool_call": {
          const isDelegation = item.server === "a2a-subagents";
          const toolKind = isDelegation ? "a2a_subagent" : "mcp";

          if (phase === "started") {
            this.emitter.emit("tool_call_start", {
              backend: "codex",
              toolKind,
              server: item.server,
              tool: item.tool,
              itemId: item.id,
              ...(isDelegation ? { delegation: true } : {}),
            });
          } else if (phase === "completed") {
            const errMsg = (item.error as Record<string, unknown>)?.message;
            this.emitter.emit("tool_call_end", {
              backend: "codex",
              toolKind,
              server: item.server,
              tool: item.tool,
              itemId: item.id,
              status: item.status ?? "completed",
              ...(errMsg ? { error: sanitizeMessage(errMsg) } : {}),
              ...(isDelegation ? { delegation: true } : {}),
            });
          }
          break;
        }

        case "file_change":
          if (features.emitFileChangeEvents && phase === "completed") {
            const changes = Array.isArray(item.changes)
              ? (item.changes as Array<Record<string, unknown>>).map((c) => ({
                  path: typeof c.path === "string" ? c.path : String(c.path),
                  kind: typeof c.kind === "string" ? c.kind : "update",
                }))
              : [];
            this.emitter.emit("decision", {
              backend: "codex",
              kind: "file_change",
              changes,
            });
          }
          break;

        case "todo_list":
          if (phase === "completed" || phase === "updated") {
            const items = Array.isArray(item.items)
              ? (item.items as Array<Record<string, unknown>>).map((i) => ({
                  text: typeof i.text === "string" ? i.text : String(i.text),
                  completed: Boolean(i.completed),
                }))
              : [];
            this.emitter.emit("decision", {
              backend: "codex",
              kind: "todo_list",
              items,
            });
          }
          break;

        case "web_search":
          // Only emit if web search is enabled (not disabled)
          if (
            this.config.codex.webSearchMode !== "disabled" &&
            phase === "started"
          ) {
            this.emitter.emit("tool_call_start", {
              backend: "codex",
              toolKind: "web_search",
              query: typeof item.query === "string" ? item.query : "",
              itemId: item.id,
            });
          }
          break;

        case "error": {
          const errMsg = sanitizeMessage(item.message);
          this.emitter.emit("agent_error", { backend: "codex", message: errMsg, itemId: item.id });
          break;
        }

        default:
          log.debug("Unknown item type", { type: item.type, phase });
      }
    } catch (err) {
      log.warn("EventMapper.handleItem error", {
        error: (err as Error).message,
        itemType: item.type,
        phase,
      });
    }
  }
}

export { sanitizeMessage };
