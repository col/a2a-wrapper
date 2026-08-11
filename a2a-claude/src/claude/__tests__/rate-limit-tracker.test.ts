import { describe, it, expect } from "vitest";
import { RateLimitTracker, renderRateLimitMessage, rateLimitMetadata } from "../rate-limit-tracker.js";
import type { SDKMessageLike } from "../client-factory.js";

function limitEvent(info: Record<string, unknown>): SDKMessageLike {
  return { type: "rate_limit_event", rate_limit_info: info, session_id: "s", uuid: "u" };
}

/**
 * The tracker drops a reset time that is not in the future, so fixtures must be
 * expressed relative to now rather than as a frozen literal that eventually
 * ages into the past.
 */
const FUTURE = Date.now() + 3_600_000;

describe("RateLimitTracker", () => {
  it("returns rejected with the full snapshot for a rejected limit", () => {
    const t = new RateLimitTracker();
    const v = t.observe(limitEvent({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: FUTURE,
      utilization: 1,
    }));
    expect(v.kind).toBe("rejected");
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.rateLimitType).toBe("five_hour");
    expect(v.snapshot.resetsAt).toBe(FUTURE);
    expect(v.snapshot.utilization).toBe(1);
    expect(v.snapshot.source).toBe("rate_limit_event");
  });

  it("downgrades a rejection to a warning when overage may still carry the request", () => {
    for (const overageStatus of ["allowed", "allowed_warning"]) {
      const t = new RateLimitTracker();
      const v = t.observe(limitEvent({
        status: "rejected", overageStatus, rateLimitType: "five_hour", resetsAt: FUTURE,
      }));
      expect(v.kind).toBe("warning");
      if (v.kind !== "warning") throw new Error("unreachable");
      // The snapshot still reports what the SDK said; only the verdict softens.
      expect(v.snapshot.status).toBe("rejected");
      expect(t.snapshot?.status).toBe("rejected");
    }
  });

  it("keeps the rejection when overage is rejected too", () => {
    const t = new RateLimitTracker();
    expect(t.observe(limitEvent({ status: "rejected", overageStatus: "rejected" })).kind)
      .toBe("rejected");
  });

  it("keeps the rejection when no overage status is reported", () => {
    const t = new RateLimitTracker();
    expect(t.observe(limitEvent({ status: "rejected" })).kind).toBe("rejected");
    expect(t.observe(limitEvent({ status: "rejected", overageStatus: "sideways" })).kind)
      .toBe("rejected");
  });

  it("records errorCode and canPurchaseCredits when the SDK reports them", () => {
    const t = new RateLimitTracker();
    const v = t.observe(limitEvent({
      status: "rejected", errorCode: "credits_required", canUserPurchaseCredits: true,
    }));
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.errorCode).toBe("credits_required");
    expect(v.snapshot.canPurchaseCredits).toBe(true);
  });

  it("captures the SDK retry counters on an api_retry warning", () => {
    const t = new RateLimitTracker();
    const v = t.observe({
      type: "system", subtype: "api_retry", error: "rate_limit",
      attempt: 2, max_retries: 5, retry_delay_ms: 4000,
    });
    if (v.kind !== "warning") throw new Error("unreachable");
    expect(v.snapshot.retry).toEqual({ attempt: 2, maxRetries: 5, delayMs: 4000 });
  });

  it("leaves retry undefined for signals that are not api_retry", () => {
    const t = new RateLimitTracker();
    const v = t.observe(limitEvent({ status: "rejected" }));
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.retry).toBeUndefined();
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
    // A stale utilization next to a rejection would contradict itself.
    expect(v.snapshot.utilization).toBeUndefined();
  });

  it("carries nothing forward from a snapshot that reported plenty of headroom", () => {
    const t = new RateLimitTracker();
    t.observe(limitEvent({
      status: "allowed", rateLimitType: "five_hour", resetsAt: FUTURE, utilization: 0.2,
    }));
    const v = t.observe({ type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: {} });
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.rateLimitType).toBeUndefined();
    expect(v.snapshot.resetsAt).toBeUndefined();
    expect(v.snapshot.utilization).toBeUndefined();
  });

  it("does not let a derived snapshot become the basis for the next one", () => {
    const t = new RateLimitTracker();
    t.observe(limitEvent({ status: "allowed", rateLimitType: "five_hour", resetsAt: FUTURE }));
    const retry = { type: "system", subtype: "api_retry", error: "rate_limit" } as SDKMessageLike;
    t.observe(retry);
    t.observe(retry);
    const v = t.observe({ type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: {} });
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.rateLimitType).toBeUndefined();
    expect(v.snapshot.resetsAt).toBeUndefined();
    // The last real observation is still the one the SDK reported.
    expect(t.snapshot?.status).toBe("allowed");
    expect(t.snapshot?.source).toBe("rate_limit_event");
  });

  it("normalizes resetsAt from seconds to milliseconds", () => {
    const t = new RateLimitTracker();
    const seconds = Math.floor(FUTURE / 1000);
    const v = t.observe(limitEvent({ status: "rejected", resetsAt: seconds }));
    if (v.kind !== "rejected") throw new Error("unreachable");
    expect(v.snapshot.resetsAt).toBe(seconds * 1000);
  });

  it("leaves resetsAt undefined for unusable values", () => {
    const t = new RateLimitTracker();
    for (const bad of [undefined, null, 0, -5, NaN, "soon"]) {
      const v = t.observe(limitEvent({ status: "rejected", resetsAt: bad }));
      if (v.kind !== "rejected") throw new Error("unreachable");
      expect(v.snapshot.resetsAt).toBeUndefined();
    }
  });

  it("drops a reset time that is not in the future", () => {
    const t = new RateLimitTracker();
    for (const stale of [Date.now() - 60_000, Math.floor(Date.now() / 1000) - 60]) {
      const v = t.observe(limitEvent({ status: "rejected", resetsAt: stale }));
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

  // The task is always terminal, so every message ends by pointing the client
  // at the contextId rather than at the (now closed) task.
  const CONTINUE = "Retry on the same contextId to continue this conversation.";

  it("names the limit type and the reset time", () => {
    const msg = renderRateLimitMessage({
      ...base, rateLimitType: "five_hour", resetsAt: Date.UTC(2026, 7, 11, 18, 0, 0),
    });
    expect(msg).toBe(`Rate limit reached (5-hour limit). Resets at 2026-08-11T18:00:00.000Z. ${CONTINUE}`);
  });

  it("omits the reset clause when no reset time is known", () => {
    expect(renderRateLimitMessage({ ...base, rateLimitType: "seven_day" }))
      .toBe(`Rate limit reached (7-day limit). ${CONTINUE}`);
  });

  it("omits the parenthetical for an unknown or absent limit type", () => {
    expect(renderRateLimitMessage(base)).toBe(`Rate limit reached. ${CONTINUE}`);
    expect(renderRateLimitMessage({ ...base, rateLimitType: "novel_limit" }))
      .toBe(`Rate limit reached. ${CONTINUE}`);
  });

  it("asks for credits instead of a reset time when credits are required", () => {
    // Waiting for the reset cannot help here, so the clause is omitted entirely.
    const msg = renderRateLimitMessage({
      ...base, errorCode: "credits_required", canPurchaseCredits: true,
      rateLimitType: "five_hour", resetsAt: Date.UTC(2026, 7, 11, 18, 0, 0),
    });
    expect(msg).toBe(`Rate limit reached — additional credits are required to continue. ${CONTINUE}`);
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

  it("carries the credits fields when the SDK reports them", () => {
    const meta = rateLimitMetadata({
      status: "rejected", source: "rate_limit_event",
      errorCode: "credits_required", canPurchaseCredits: false,
    });
    expect(meta).toEqual({
      reason: "rate_limit",
      source: "rate_limit_event",
      errorCode: "credits_required",
      canPurchaseCredits: false,
    });
  });

  it("omits absent fields rather than emitting undefined keys", () => {
    const meta = rateLimitMetadata({ status: "rejected", source: "assistant_error" });
    expect(meta).toEqual({ reason: "rate_limit", source: "assistant_error" });
    expect(Object.keys(meta)).not.toContain("resetsAt");
  });
});
