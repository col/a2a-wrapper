/**
 * Usage Mapper — SDK result usage → core UsageCallRecords
 *
 * Maps @anthropic-ai/claude-agent-sdk result-message `modelUsage` entries
 * (camelCase, per-model) onto @a2a-wrapper/core's OTel-aligned
 * UsageCallRecord shape. Unreported values map to 0/null — never invented.
 *
 * duration_api_ms and ttft_ms are whole-turn values: they are attributed to
 * the FIRST record only so accumulator sums do not double-count.
 */

import type { UsageCallRecord } from "@a2a-wrapper/core";
import type { SDKMessageLike } from "./client-factory.js";

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export function usageRecordsFromResult(msg: SDKMessageLike): UsageCallRecord[] {
  const modelUsage = msg.modelUsage as Record<string, Record<string, unknown>> | undefined;
  if (!modelUsage) return [];

  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return [];

  const durationMs = num(msg.duration_api_ms);
  const ttftMs = typeof msg.ttft_ms === "number" ? msg.ttft_ms : null;

  return entries.map(([model, usage], index) => ({
    model,
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheReadTokens: num(usage.cacheReadInputTokens),
    cacheWriteTokens: num(usage.cacheCreationInputTokens),
    reasoningTokens: 0,
    durationMs: index === 0 ? durationMs : 0,
    timeToFirstTokenMs: index === 0 ? ttftMs : null,
    cost: typeof usage.costUSD === "number" ? usage.costUSD : null,
    apiEndpoint: null,
    initiator: null,
  }));
}
