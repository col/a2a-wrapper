import { describe, it, expect } from "vitest";
import { usageRecordsFromResult } from "../usage-mapper.js";

describe("usageRecordsFromResult", () => {
  it("maps modelUsage entries to OTel-aligned UsageCallRecords", () => {
    const records = usageRecordsFromResult({
      type: "result", subtype: "success",
      duration_api_ms: 1200, ttft_ms: 300,
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 100, outputTokens: 50,
          cacheReadInputTokens: 20, cacheCreationInputTokens: 10,
          costUSD: 0.05,
        },
        "claude-haiku-4-5": { inputTokens: 5, outputTokens: 2, costUSD: 0.001 },
      },
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      model: "claude-sonnet-5",
      inputTokens: 100, outputTokens: 50,
      cacheReadTokens: 20, cacheWriteTokens: 10,
      reasoningTokens: 0,
      durationMs: 1200,            // whole-turn duration attributed to the first record only
      timeToFirstTokenMs: 300,
      cost: 0.05,
      apiEndpoint: null, initiator: null,
    });
    expect(records[1].durationMs).toBe(0);   // no double-counting in the accumulator sum
    expect(records[1].timeToFirstTokenMs).toBeNull();
    expect(records[1].cacheReadTokens).toBe(0); // unreported → 0
  });

  it("returns [] when modelUsage is absent or empty", () => {
    expect(usageRecordsFromResult({ type: "result", subtype: "success" })).toEqual([]);
    expect(usageRecordsFromResult({ type: "result", subtype: "success", modelUsage: {} })).toEqual([]);
  });

  it("maps missing costUSD to null", () => {
    const [r] = usageRecordsFromResult({
      type: "result", subtype: "error_max_turns",
      modelUsage: { m: { inputTokens: 1, outputTokens: 1 } },
    });
    expect(r.cost).toBeNull();
  });
});
