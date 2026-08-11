import { describe, it, expect } from "vitest";
import { RateLimitTracker, renderRateLimitMessage, rateLimitMetadata } from "../rate-limit-tracker.js";
import type { SDKMessageLike } from "../client-factory.js";

function limitEvent(info: Record<string, unknown>): SDKMessageLike {
  return { type: "rate_limit_event", rate_limit_info: info, session_id: "s", uuid: "u" };
}

describe("RateLimitTracker", () => {
  it("returns rejected with the full snapshot for a rejected limit", () => {
    const t = new RateLimitTracker();
    const v = t.observe(limitEvent({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: 1_775_000_000_000,
      utilization: 1,
    }));
    expect(v.kind).toBe("rejected");
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.rateLimitType).toBe("five_hour");
    expect(v.snapshot.resetsAt).toBe(1_775_000_000_000);
    expect(v.snapshot.utilization).toBe(1);
    expect(v.snapshot.source).toBe("rate_limit_event");
  });

  it("returns warning for allowed_warning", () => {
    const t = new RateLimitTracker();
    expect(t.observe(limitEvent({ status: "allowed_warning", utilization: 0.9 })).kind).toBe("warning");
  });

  it("returns none for allowed but still records the snapshot", () => {
    const t = new RateLimitTracker();
    expect(t.observe(limitEvent({ status: "allowed", utilization: 0.1 })).kind).toBe("none");
    expect(t.snapshot?.status).toBe("allowed");
    expect(t.snapshot?.utilization).toBe(0.1);
  });

  it("treats a rate-limit api_retry as a warning, never a rejection", () => {
    const t = new RateLimitTracker();
    const v = t.observe({
      type: "system", subtype: "api_retry", error: "rate_limit",
      attempt: 1, max_retries: 3, retry_delay_ms: 2000, error_status: 429,
    });
    expect(v.kind).toBe("warning");
    if (v.kind !== "warning") throw new Error("unreachable");
    expect(v.snapshot.source).toBe("api_retry");
  });

  it("ignores api_retry for non-rate-limit errors", () => {
    const t = new RateLimitTracker();
    expect(t.observe({ type: "system", subtype: "api_retry", error: "overloaded" }).kind).toBe("none");
  });

  it("treats an assistant rate_limit error as a rejection with no reset time", () => {
    const t = new RateLimitTracker();
    const v = t.observe({ type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: {} });
    expect(v.kind).toBe("rejected");
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.source).toBe("assistant_error");
    expect(v.snapshot.resetsAt).toBeUndefined();
  });

  it("carries the last known limit type forward onto an assistant rejection", () => {
    const t = new RateLimitTracker();
    t.observe(limitEvent({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.95 }));
    const v = t.observe({ type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: {} });
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.rateLimitType).toBe("seven_day");
  });

  it("normalizes resetsAt from seconds to milliseconds", () => {
    const t = new RateLimitTracker();
    const v = t.observe(limitEvent({ status: "rejected", resetsAt: 1_775_000_000 }));
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.resetsAt).toBe(1_775_000_000_000);
  });

  it("leaves resetsAt undefined for unusable values", () => {
    const t = new RateLimitTracker();
    for (const bad of [undefined, null, 0, -5, NaN, "soon"]) {
      const v = t.observe(limitEvent({ status: "rejected", resetsAt: bad }));
      if (v.kind !== "rejected") throw new Error("unreachable");
      expect(v.snapshot.resetsAt).toBeUndefined();
    }
  });

  it("ignores a rate_limit_event with an unrecognised status", () => {
    const t = new RateLimitTracker();
    expect(t.observe(limitEvent({ status: "sideways" })).kind).toBe("none");
    expect(t.observe({ type: "rate_limit_event" }).kind).toBe("none");
  });

  it("ignores unrelated messages", () => {
    const t = new RateLimitTracker();
    for (const msg of [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "result", subtype: "success", result: "ok" },
      { type: "stream_event", parent_tool_use_id: null },
      { type: "assistant", parent_tool_use_id: null, message: { content: [] } },
    ]) {
      expect(t.observe(msg).kind).toBe("none");
    }
  });
});

describe("renderRateLimitMessage", () => {
  const base = { status: "rejected", source: "rate_limit_event" } as const;

  it("names the limit type and the reset time", () => {
    const msg = renderRateLimitMessage(
      { ...base, rateLimitType: "five_hour", resetsAt: Date.UTC(2026, 7, 11, 18, 0, 0) },
      "input-required",
    );
    expect(msg).toBe(
      "Rate limit reached (5-hour limit). Resets at 2026-08-11T18:00:00.000Z. " +
      "Send another message on this task to continue.",
    );
  });

  it("omits the reset clause when no reset time is known", () => {
    const msg = renderRateLimitMessage({ ...base, rateLimitType: "seven_day" }, "input-required");
    expect(msg).toBe("Rate limit reached (7-day limit). Send another message on this task to continue.");
  });

  it("omits the parenthetical for an unknown or absent limit type", () => {
    expect(renderRateLimitMessage(base, "input-required")).toBe(
      "Rate limit reached. Send another message on this task to continue.",
    );
    expect(renderRateLimitMessage({ ...base, rateLimitType: "novel_limit" }, "input-required")).toBe(
      "Rate limit reached. Send another message on this task to continue.",
    );
  });

  it("tells the client to use the same contextId when the task state is terminal", () => {
    const msg = renderRateLimitMessage({ ...base, rateLimitType: "five_hour" }, "failed");
    expect(msg).toBe(
      "Rate limit reached (5-hour limit). Retry on the same contextId to continue this conversation.",
    );
  });
});

describe("rateLimitMetadata", () => {
  it("carries the structured fields plus both reset representations", () => {
    const meta = rateLimitMetadata({
      status: "rejected", source: "rate_limit_event",
      rateLimitType: "five_hour", resetsAt: Date.UTC(2026, 7, 11, 18, 0, 0), utilization: 1,
    });
    expect(meta).toEqual({
      reason: "rate_limit",
      source: "rate_limit_event",
      rateLimitType: "five_hour",
      resetsAt: Date.UTC(2026, 7, 11, 18, 0, 0),
      resetsAtIso: "2026-08-11T18:00:00.000Z",
      utilization: 1,
    });
  });

  it("omits absent fields rather than emitting undefined keys", () => {
    const meta = rateLimitMetadata({ status: "rejected", source: "assistant_error" });
    expect(meta).toEqual({ reason: "rate_limit", source: "assistant_error" });
    expect(Object.keys(meta)).not.toContain("resetsAt");
  });
});
