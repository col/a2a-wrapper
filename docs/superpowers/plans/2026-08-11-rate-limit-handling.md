# Rate Limit Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognise Claude Agent SDK rate-limit signals, end the turn deliberately with a reset time and structured metadata, and leave the Claude session resumable so the client continues the same conversation once the limit resets.

**Architecture:** A new `RateLimitTracker` owns all detection — it turns raw SDK messages into a `none | warning | rejected` verdict. The executor consults it once per message and, on `rejected`, breaks the loop, tears down the query, and publishes a non-terminal `input-required` status carrying the reset time. `EventMapper` gains a `handleRateLimit` method that emits a new `rate_limit` sideband event, but stays purely observational — it never influences control flow, because its exceptions are swallowed by design.

**Tech Stack:** TypeScript, Vitest (`vitest --run`), Turborepo, Changesets, `@anthropic-ai/claude-agent-sdk`.

**Spec:** `docs/superpowers/specs/2026-08-11-rate-limit-handling-design.md`

**Before you start:** `node`/`npm` are at `~/.local/bin` and may not be on the default PATH. Run `export PATH="$HOME/.local/bin:$PATH"` first. Test commands run from `a2a-claude/` unless stated otherwise.

**Hard constraint:** This plan must not modify `a2a-claude/src/claude/session-manager.ts` or any session TTL behaviour. That is a separate PR. If a task seems to need it, stop and report instead.

---

### Task 1: `RateLimitTracker` — detection

**Files:**
- Create: `a2a-claude/src/claude/rate-limit-tracker.ts`
- Test: `a2a-claude/src/claude/__tests__/rate-limit-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `a2a-claude/src/claude/__tests__/rate-limit-tracker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RateLimitTracker } from "../rate-limit-tracker.js";
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/rate-limit-tracker.test.ts
```

Expected: FAIL — `Failed to resolve import "../rate-limit-tracker.js"`.

- [ ] **Step 3: Write the implementation**

Create `a2a-claude/src/claude/rate-limit-tracker.ts`:

```ts
/**
 * Rate Limit Tracker — Claude SDK rate-limit signal detection
 *
 * Turns raw SDK messages into a verdict about whether the current turn can
 * continue. Detection lives here rather than in EventMapper on purpose: that
 * class is pure observability and swallows its own exceptions by design, so
 * turn-ending control flow must not depend on it.
 *
 * Rate limit info is only populated for claude.ai subscription auth. Under API
 * key, Bedrock, or Vertex the SDK never emits `rate_limit_event`, so the
 * assistant-message error is the only signal available and no reset time exists.
 */

import type { SDKMessageLike } from "./client-factory.js";

export type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";

export interface RateLimitSnapshot {
  status: RateLimitStatus;
  /** e.g. five_hour, seven_day, seven_day_opus. Absent when the SDK omits it. */
  rateLimitType?: string;
  /** Epoch milliseconds. Undefined when no reset time was reported. */
  resetsAt?: number;
  utilization?: number;
  source: "rate_limit_event" | "assistant_error" | "api_retry";
}

export type RateLimitVerdict =
  | { kind: "none" }
  | { kind: "warning"; snapshot: RateLimitSnapshot }
  | { kind: "rejected"; snapshot: RateLimitSnapshot };

const NONE: RateLimitVerdict = { kind: "none" };

/**
 * The SDK types `resetsAt` as a bare number with no unit, so discriminate by
 * magnitude: 1e12 ms is 2001-09-09, while a plausible reset expressed in
 * seconds is ~1.8e9. Anything below the threshold is therefore seconds.
 */
const MS_THRESHOLD = 1e12;

function normalizeResetsAt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < MS_THRESHOLD ? value * 1000 : value;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isStatus(value: unknown): value is RateLimitStatus {
  return value === "allowed" || value === "allowed_warning" || value === "rejected";
}

export class RateLimitTracker {
  private last: RateLimitSnapshot | null = null;

  /** Most recent known limit state, for metadata on a later rejection. */
  get snapshot(): RateLimitSnapshot | null {
    return this.last;
  }

  observe(msg: SDKMessageLike): RateLimitVerdict {
    if (msg.type === "rate_limit_event") return this.observeLimitEvent(msg);

    if (msg.type === "system" && msg.subtype === "api_retry" && msg.error === "rate_limit") {
      return { kind: "warning", snapshot: this.derive("allowed_warning", "api_retry") };
    }

    if (msg.type === "assistant" && msg.error === "rate_limit") {
      return { kind: "rejected", snapshot: this.derive("rejected", "assistant_error") };
    }

    return NONE;
  }

  private observeLimitEvent(msg: SDKMessageLike): RateLimitVerdict {
    const info = msg.rate_limit_info as Record<string, unknown> | undefined;
    if (!info || typeof info !== "object") return NONE;
    if (!isStatus(info.status)) return NONE;

    const snapshot: RateLimitSnapshot = {
      status: info.status,
      rateLimitType: readString(info.rateLimitType),
      resetsAt: normalizeResetsAt(info.resetsAt),
      utilization: readNumber(info.utilization),
      source: "rate_limit_event",
    };
    this.last = snapshot;

    if (snapshot.status === "rejected") return { kind: "rejected", snapshot };
    if (snapshot.status === "allowed_warning") return { kind: "warning", snapshot };
    return NONE;
  }

  /**
   * Build a snapshot for a signal that carries no limit details of its own,
   * inheriting whatever the last `rate_limit_event` told us.
   */
  private derive(status: RateLimitStatus, source: RateLimitSnapshot["source"]): RateLimitSnapshot {
    const snapshot: RateLimitSnapshot = {
      status,
      rateLimitType: this.last?.rateLimitType,
      resetsAt: this.last?.resetsAt,
      utilization: this.last?.utilization,
      source,
    };
    this.last = snapshot;
    return snapshot;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/rate-limit-tracker.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add a2a-claude/src/claude/rate-limit-tracker.ts a2a-claude/src/claude/__tests__/rate-limit-tracker.test.ts
git commit -m "feat(a2a-claude): add RateLimitTracker for SDK rate-limit detection"
```

---

### Task 2: Message and metadata rendering

**Files:**
- Modify: `a2a-claude/src/claude/rate-limit-tracker.ts`
- Test: `a2a-claude/src/claude/__tests__/rate-limit-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `rate-limit-tracker.test.ts` (and extend the import to
`import { RateLimitTracker, renderRateLimitMessage, rateLimitMetadata } from "../rate-limit-tracker.js";`):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/rate-limit-tracker.test.ts -t "renderRateLimitMessage"
```

Expected: FAIL — `renderRateLimitMessage is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `a2a-claude/src/claude/rate-limit-tracker.ts`:

```ts
/** A2A task states this wrapper is willing to publish for a rate limit. */
export type RateLimitTaskState = "input-required" | "failed" | "auth-required";

const RATE_LIMIT_TYPE_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "7-day limit",
  seven_day_opus: "7-day Opus limit",
  seven_day_sonnet: "7-day Sonnet limit",
  seven_day_overage_included: "7-day limit (overage included)",
  overage: "overage limit",
};

/**
 * Human-readable status text. An unknown limit type drops the parenthetical
 * rather than leaking a raw enum, and an unknown reset time drops the clause
 * rather than printing a fabricated one.
 */
export function renderRateLimitMessage(
  snapshot: RateLimitSnapshot,
  taskState: RateLimitTaskState,
): string {
  const label = snapshot.rateLimitType ? RATE_LIMIT_TYPE_LABELS[snapshot.rateLimitType] : undefined;
  const parts: string[] = [label ? `Rate limit reached (${label}).` : "Rate limit reached."];

  if (snapshot.resetsAt !== undefined) {
    parts.push(`Resets at ${new Date(snapshot.resetsAt).toISOString()}.`);
  }

  // A terminal task cannot accept another message, so the prose must not say it can.
  parts.push(
    taskState === "failed"
      ? "Retry on the same contextId to continue this conversation."
      : "Send another message on this task to continue.",
  );

  return parts.join(" ");
}

/** Machine-readable equivalent, for orchestrators that schedule their own retry. */
export function rateLimitMetadata(snapshot: RateLimitSnapshot): Record<string, unknown> {
  const meta: Record<string, unknown> = { reason: "rate_limit", source: snapshot.source };
  if (snapshot.rateLimitType !== undefined) meta.rateLimitType = snapshot.rateLimitType;
  if (snapshot.resetsAt !== undefined) {
    meta.resetsAt = snapshot.resetsAt;
    meta.resetsAtIso = new Date(snapshot.resetsAt).toISOString();
  }
  if (snapshot.utilization !== undefined) meta.utilization = snapshot.utilization;
  return meta;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/rate-limit-tracker.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add a2a-claude/src/claude/rate-limit-tracker.ts a2a-claude/src/claude/__tests__/rate-limit-tracker.test.ts
git commit -m "feat(a2a-claude): render rate-limit status text and metadata"
```

---

### Task 3: Config surface

**Files:**
- Modify: `a2a-claude/src/config/types.ts`
- Modify: `a2a-claude/src/config/defaults.ts`
- Modify: `a2a-claude/src/claude/executor.ts:44-46` and `executor.ts:436-521`
- Test: `a2a-claude/src/claude/__tests__/executor.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `a2a-claude/src/claude/__tests__/executor.test.ts`, as a new top-level `describe` block at the end of the file:

```ts
describe("rateLimit config validation", () => {
  it("accepts every supported task state", async () => {
    for (const state of ["input-required", "failed", "auth-required"] as const) {
      config.rateLimit = { taskState: state };
      const ex = new ClaudeExecutor(config, () => new FakeClaudeClient([happyTurn("s", "x")]));
      await expect(ex.initialize()).resolves.toBeUndefined();
    }
  });

  it("rejects an unsupported task state", async () => {
    config.rateLimit = { taskState: "working" as unknown as "failed" };
    const ex = new ClaudeExecutor(config, () => new FakeClaudeClient([happyTurn("s", "x")]));
    await expect(ex.initialize()).rejects.toThrow(/rateLimit\.taskState/);
  });

  it("defaults to input-required and enables rate-limit events", () => {
    expect(DEFAULTS.rateLimit.taskState).toBe("input-required");
    expect(DEFAULTS.features.emitRateLimitEvents).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/executor.test.ts -t "rateLimit config"
```

Expected: FAIL — TypeScript errors on `config.rateLimit` and `DEFAULTS.rateLimit` (properties do not exist), and the rejection test fails because nothing throws.

- [ ] **Step 3: Add the config types**

In `a2a-claude/src/config/types.ts`, add a new section immediately after the `SessionConfig` interface:

```ts
// ─── Rate Limit Config ──────────────────────────────────────────────────────

export interface RateLimitConfig {
  /**
   * A2A task state published when a rate limit ends a turn. Non-terminal
   * states ("input-required", "auth-required") leave the task open so the
   * client can continue the same task once the limit resets. Use "failed" for
   * A2A clients that cannot handle a non-terminal task.
   * @default "input-required"
   */
  taskState?: "input-required" | "failed" | "auth-required";
}
```

Add to `FeatureFlags`:

```ts
  /** Publish rate-limit status changes as sideband events. Default: true. */
  emitRateLimitEvents?: boolean;
```

Add to `AgentConfig`, after `timeouts`:

```ts
  /** Behaviour when a Claude rate limit ends a turn. */
  rateLimit?: RateLimitConfig;
```

- [ ] **Step 4: Add the defaults**

In `a2a-claude/src/config/defaults.ts`, add `emitRateLimitEvents: true` to the `features` block, and a new top-level block alongside `session`:

```ts
  rateLimit: {
    taskState: "input-required",
  },
```

- [ ] **Step 5: Add validation**

In `a2a-claude/src/claude/executor.ts`, add a constant next to the existing validation sets near line 46:

```ts
const VALID_RATE_LIMIT_TASK_STATES = new Set(["input-required", "failed", "auth-required"]);
```

and add this to the end of `validateConfig()`:

```ts
    const rateLimitState = this.config.rateLimit?.taskState;
    if (rateLimitState !== undefined && !VALID_RATE_LIMIT_TASK_STATES.has(rateLimitState)) {
      throw new Error(
        `rateLimit.taskState "${String(rateLimitState)}" is invalid. ` +
        "Use one of: input-required, failed, auth-required.",
      );
    }
```

- [ ] **Step 6: Run the tests and typecheck**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/executor.test.ts && npm run typecheck
```

Expected: PASS, and typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add a2a-claude/src/config/types.ts a2a-claude/src/config/defaults.ts a2a-claude/src/claude/executor.ts a2a-claude/src/claude/__tests__/executor.test.ts
git commit -m "feat(a2a-claude): add rateLimit.taskState and features.emitRateLimitEvents config"
```

---

### Task 4: `rate_limit` sideband event

**Files:**
- Modify: `packages/core/src/events/transport.ts:48-56`
- Modify: `a2a-claude/src/claude/event-mapper.ts`
- Test: `a2a-claude/src/claude/__tests__/event-mapper.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `a2a-claude/src/claude/__tests__/event-mapper.test.ts`. That file already has a `makeMapper(features?)` helper returning `{ mapper, emitted }`, where `emitted` is an array of `{ event: string; data: Record<string, unknown> }` — reuse it, do not add a new one.

```ts
describe("EventMapper.handleRateLimit", () => {
  it("emits ended_turn for a rejection", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleRateLimit({
      kind: "rejected",
      snapshot: {
        status: "rejected", source: "rate_limit_event",
        rateLimitType: "five_hour", resetsAt: 1_775_000_000_000, utilization: 1,
      },
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe("rate_limit");
    expect(emitted[0].data).toMatchObject({
      backend: "claude", status: "rejected", action: "ended_turn",
      rateLimitType: "five_hour", resetsAt: 1_775_000_000_000, utilization: 1,
    });
  });

  it("emits retrying for an api_retry warning and warning for a limit warning", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleRateLimit({
      kind: "warning",
      snapshot: { status: "allowed_warning", source: "api_retry" },
    });
    mapper.handleRateLimit({
      kind: "warning",
      snapshot: { status: "allowed_warning", source: "rate_limit_event", utilization: 0.9 },
    });
    expect(emitted.map((e) => e.data.action)).toEqual(["retrying", "warning"]);
  });

  it("emits nothing for a none verdict", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleRateLimit({ kind: "none" });
    expect(emitted).toHaveLength(0);
  });

  it("emits nothing when emitRateLimitEvents is disabled", () => {
    const { mapper, emitted } = makeMapper({ emitRateLimitEvents: false });
    mapper.handleRateLimit({
      kind: "rejected",
      snapshot: { status: "rejected", source: "rate_limit_event" },
    });
    expect(emitted).toHaveLength(0);
  });

  it("omits absent optional fields", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleRateLimit({
      kind: "rejected",
      snapshot: { status: "rejected", source: "assistant_error" },
    });
    expect(Object.keys(emitted[0].data)).toEqual(["backend", "status", "action"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/event-mapper.test.ts -t "handleRateLimit"
```

Expected: FAIL — `mapper.handleRateLimit is not a function`.

- [ ] **Step 3: Add the event type to core**

In `packages/core/src/events/transport.ts`, extend the `EventType` union:

```ts
export type EventType =
  | "tool_call_start"
  | "tool_call_end"
  | "thinking"
  | "decision"
  | "agent_started"
  | "agent_finished"
  | "agent_error"
  | "context_window"
  | "rate_limit";
```

- [ ] **Step 4: Add `handleRateLimit` to the mapper**

In `a2a-claude/src/claude/event-mapper.ts`, add the import:

```ts
import type { RateLimitVerdict } from "./rate-limit-tracker.js";
```

and add this public method to the `EventMapper` class, directly after `handleMessage`:

```ts
  /**
   * Emit a rate-limit sideband event. Called by the executor with the tracker's
   * verdict rather than re-parsing the message, so detection rules live in
   * exactly one place.
   */
  handleRateLimit(verdict: RateLimitVerdict): void {
    if (verdict.kind === "none") return;
    if (!this.config.features.emitRateLimitEvents) return;

    const { snapshot } = verdict;
    const action =
      verdict.kind === "rejected" ? "ended_turn"
        : snapshot.source === "api_retry" ? "retrying"
          : "warning";

    this.emitter.emit("rate_limit", {
      backend: "claude",
      status: snapshot.status,
      action,
      ...(snapshot.rateLimitType !== undefined ? { rateLimitType: snapshot.rateLimitType } : {}),
      ...(snapshot.resetsAt !== undefined ? { resetsAt: snapshot.resetsAt } : {}),
      ...(snapshot.utilization !== undefined ? { utilization: snapshot.utilization } : {}),
    });
  }
```

- [ ] **Step 5: Build core, then run the tests**

`a2a-claude` imports `@a2a-wrapper/core` from its build output, so core must be rebuilt before its new union member is visible.

```bash
export PATH="$HOME/.local/bin:$PATH" && npm run build --workspace=@a2a-wrapper/core
cd a2a-claude && npx vitest --run src/claude/__tests__/event-mapper.test.ts && npm run typecheck
```

Expected: PASS, and typecheck exits 0. If the workspace build command fails, fall back to `npm run build` from the repo root.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/events/transport.ts a2a-claude/src/claude/event-mapper.ts a2a-claude/src/claude/__tests__/event-mapper.test.ts
git commit -m "feat(core,a2a-claude): add rate_limit sideband event type"
```

---

### Task 5: Executor wiring — end the turn on a rejection

**Files:**
- Modify: `a2a-claude/src/claude/executor.ts:252-350`
- Create: `a2a-claude/src/claude/__tests__/executor-rate-limit.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `a2a-claude/src/claude/__tests__/executor-rate-limit.test.ts`. The helper block below is duplicated from `executor.test.ts`, matching this package's existing per-file test setup convention:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeExecutor } from "../executor.js";
import { FakeClaudeClient } from "./fake-client.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";
import type { SDKMessageLike } from "../client-factory.js";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";
import type { AgentEvent } from "@a2a-wrapper/core";

const STATE_NAME: Partial<Record<TaskState, string>> = {
  [TaskState.TASK_STATE_SUBMITTED]: "submitted",
  [TaskState.TASK_STATE_WORKING]: "working",
  [TaskState.TASK_STATE_INPUT_REQUIRED]: "input-required",
  [TaskState.TASK_STATE_COMPLETED]: "completed",
  [TaskState.TASK_STATE_FAILED]: "failed",
  [TaskState.TASK_STATE_AUTH_REQUIRED]: "auth-required",
};

interface PublishedEvent { kind?: string; data?: Record<string, unknown>; [k: string]: unknown }

function makeBus() {
  const events: PublishedEvent[] = [];
  let finishedCount = 0;
  const bus = {
    publish: (e: PublishedEvent) => { events.push(e); },
    finished: () => { finishedCount++; },
    on: () => bus, off: () => bus, once: () => bus, removeAllListeners: () => bus,
  } as unknown as ExecutionEventBus;
  return { bus, events, finished: () => finishedCount };
}

function makeCtx(taskId: string, contextId: string): RequestContext {
  return {
    taskId, contextId, task: undefined,
    userMessage: {
      messageId: "m1", contextId, taskId, role: 1,
      parts: [{ content: { $case: "text", value: "do the thing" }, metadata: undefined }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    },
  } as unknown as RequestContext;
}

function states(events: PublishedEvent[]): string[] {
  return events
    .filter((e) => e.kind === "statusUpdate")
    .map((e) => STATE_NAME[(e.data?.status as { state?: TaskState })?.state as TaskState] ?? "");
}

function terminalStatus(events: PublishedEvent[]): Record<string, unknown> {
  const updates = events.filter((e) => e.kind === "statusUpdate");
  return updates[updates.length - 1]!.data as Record<string, unknown>;
}

function statusText(events: PublishedEvent[]): string {
  const status = terminalStatus(events).status as { message?: { parts?: Array<{ text?: string }> } };
  return status?.message?.parts?.[0]?.text ?? "";
}

const REJECTED: SDKMessageLike = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected", rateLimitType: "five_hour",
    resetsAt: Date.UTC(2026, 7, 11, 18, 0, 0), utilization: 1,
  },
};

/** init → assistant text → rate limit rejection → then hangs until aborted. */
function rateLimitedTurn() {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-test" },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "partial" }] } },
      REJECTED,
    ] as SDKMessageLike[],
    hangAfter: true,
  };
}

let ws: string;
let config: Required<AgentConfig>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "a2a-claude-ws-"));
  config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ws })) as Required<AgentConfig>;
  config.claude.workingDirectory = ws;
  config.events = { enabled: false } as Required<AgentConfig>["events"];
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("ClaudeExecutor rate limit handling", () => {
  it("ends the turn as input-required with reset details", async () => {
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "input-required"]);
    expect(statusText(events)).toContain("Rate limit reached (5-hour limit)");
    expect(statusText(events)).toContain("2026-08-11T18:00:00.000Z");
    expect(terminalStatus(events).metadata).toMatchObject({
      reason: "rate_limit", rateLimitType: "five_hour", utilization: 1,
    });
    expect(finished()).toBe(1);
  });

  it("does not publish a response artifact for the interrupted turn", async () => {
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(events.filter((e) => e.kind === "artifactUpdate")).toHaveLength(0);
  });

  it("keeps the session resumable on the next turn", async () => {
    const client = new FakeClaudeClient([
      rateLimitedTurn(),
      {
        messages: [
          { type: "system", subtype: "init", session_id: "sess-1", model: "claude-test" },
          { type: "result", subtype: "success", result: "done", session_id: "sess-1" },
        ] as SDKMessageLike[],
      },
    ]);
    const ex = new ClaudeExecutor(config, () => client);

    await ex.execute(makeCtx("t1", "ctx-1"), makeBus().bus);
    await ex.execute(makeCtx("t2", "ctx-1"), makeBus().bus);

    expect(client.calls[1].options.resume).toBe("sess-1");
  });

  it("honours rateLimit.taskState: failed", async () => {
    config.rateLimit = { taskState: "failed" };
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "failed"]);
    expect(statusText(events)).toContain("same contextId");
  });

  it("omits the reset clause when the SDK reports no reset time", async () => {
    const client = new FakeClaudeClient([{
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        { type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: { content: [] } },
      ] as SDKMessageLike[],
      hangAfter: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "input-required"]);
    expect(statusText(events)).toBe(
      "Rate limit reached. Send another message on this task to continue.",
    );
    expect(terminalStatus(events).metadata).not.toHaveProperty("resetsAt");
  });

  it("lets a warning through without ending the turn", async () => {
    const client = new FakeClaudeClient([{
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.9 } },
        { type: "result", subtype: "success", result: "finished anyway", session_id: "s" },
      ] as SDKMessageLike[],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "completed"]);
    expect(JSON.stringify(events)).toContain("finished anyway");
  });

  it("emits a rate_limit sideband event", async () => {
    config.events = { enabled: true } as Required<AgentConfig>["events"];
    const captured: AgentEvent[] = [];
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    ex.customTransport = async (e: AgentEvent) => { captured.push(e); };

    await ex.execute(makeCtx("t1", "ctx-1"), makeBus().bus);

    const rl = captured.filter((e) => e.eventType === "rate_limit");
    expect(rl).toHaveLength(1);
    expect(rl[0].data).toMatchObject({ status: "rejected", action: "ended_turn" });
  });

  it("terminates a streaming artifact that was already in flight", async () => {
    config.features.streamArtifactChunks = true;
    const client = new FakeClaudeClient([{
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        {
          type: "stream_event", parent_tool_use_id: null,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial " } },
        },
        REJECTED,
      ] as SDKMessageLike[],
      hangAfter: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    const artifacts = events.filter((e) => e.kind === "artifactUpdate");
    expect(artifacts.length).toBeGreaterThan(1);
    expect(artifacts[artifacts.length - 1].data).toMatchObject({ lastChunk: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/executor-rate-limit.test.ts
```

Expected: FAIL. The rejection tests time out or end in `failed` rather than `input-required`, because nothing recognises the rate-limit message and the fake query hangs until the prompt timeout aborts it.

- [ ] **Step 3: Wire the tracker into the executor**

In `a2a-claude/src/claude/executor.ts`, add the import:

```ts
import {
  RateLimitTracker,
  renderRateLimitMessage,
  rateLimitMetadata,
} from "./rate-limit-tracker.js";
import type { RateLimitSnapshot } from "./rate-limit-tracker.js";
```

Inside `turnFn`, alongside the existing `finalText` / `resultError` declarations:

```ts
          const rateLimits = new RateLimitTracker();
          let rateLimited: RateLimitSnapshot | null = null;
```

At the very top of the `for await (const msg of q ...)` body, before the existing `init` handling:

```ts
            const verdict = rateLimits.observe(msg);
            if (verdict.kind !== "none") mapper.handleRateLimit(verdict);
            if (verdict.kind === "rejected") {
              rateLimited = verdict.snapshot;
              break;
            }
```

Immediately after the loop, **before** the existing `if (resultError)` block:

```ts
          if (rateLimited) {
            // Tear down the subprocess — same break-then-abort teardown the
            // plugin preflight uses. Waiting for a reset is never our call.
            abortController.abort();

            // Already-sent chunks would otherwise leave the client's artifact
            // open forever. This closes the stream; finalText is intentionally
            // "" here, since no success result arrives on this path.
            if (streaming && streamArtifactStarted) {
              publishLastChunkMarker(bus, taskId, contextId, streamArtifactId, finalText);
            }

            const taskState = this.config.rateLimit?.taskState ?? "input-required";
            publishStatus(
              bus, taskId, contextId, taskState,
              renderRateLimitMessage(rateLimited, taskState),
              true,
              rateLimitMetadata(rateLimited),
            );
            bus.finished();
            return;
          }
```

Do **not** accumulate the streamed deltas into a buffer to pass as `finalText` — republishing partial output is explicitly out of scope.

- [ ] **Step 4: Run the tests**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/executor-rate-limit.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole package suite and typecheck**

```bash
cd a2a-claude && npm test && npm run typecheck
```

Expected: PASS throughout. The pre-existing executor tests must be untouched — they are the regression check that a turn with no rate-limit messages behaves exactly as before.

- [ ] **Step 6: Commit**

```bash
git add a2a-claude/src/claude/executor.ts a2a-claude/src/claude/__tests__/executor-rate-limit.test.ts
git commit -m "feat(a2a-claude): end the turn as input-required on a rate limit"
```

---

### Task 6: Schema, docs, and changeset

**Files:**
- Modify: `a2a-claude/schemas/agent-config.schema.json`
- Modify: `a2a-claude/README.md`
- Create: `.changeset/claude-rate-limit-handling.md`

The schema declares `"additionalProperties": false` on `AgentConfig` and `FeatureFlags`, so a config using the new keys would be flagged by editors until the schema is updated.

- [ ] **Step 1: Add `RateLimitConfig` to the schema**

In `a2a-claude/schemas/agent-config.schema.json`, add a `RateLimitConfig` definition alongside the other `definitions` entries (keep them alphabetically ordered, as the file already is):

```json
    "RateLimitConfig": {
      "additionalProperties": false,
      "properties": {
        "taskState": {
          "description": "A2A task state published when a rate limit ends a turn. Non-terminal states leave the task open so the client can continue it after the reset (default: \"input-required\").",
          "enum": ["input-required", "failed", "auth-required"],
          "type": "string"
        }
      },
      "type": "object"
    },
```

Add the property to the `AgentConfig` properties block:

```json
        "rateLimit": {
          "$ref": "#/definitions/RateLimitConfig"
        },
```

And add to the `FeatureFlags` properties block:

```json
        "emitRateLimitEvents": {
          "description": "Publish rate-limit status changes as sideband events. Default: true.",
          "type": "boolean"
        },
```

- [ ] **Step 2: Document the behaviour in the README**

Add a section to `a2a-claude/README.md`, near the session/feature configuration docs:

```markdown
### Rate limits

When Claude reports a rate-limit rejection, the wrapper ends the turn
immediately rather than waiting out the reset or letting the request decay into
a prompt timeout. It publishes an `input-required` status whose message names
the limit and its reset time, for example:

> Rate limit reached (5-hour limit). Resets at 2026-08-11T18:00:00.000Z. Send
> another message on this task to continue.

The same status carries machine-readable metadata for orchestrators that
schedule their own retry:

```json
{
  "reason": "rate_limit",
  "source": "rate_limit_event",
  "rateLimitType": "five_hour",
  "resetsAt": 1775930400000,
  "resetsAtIso": "2026-08-11T18:00:00.000Z",
  "utilization": 1
}
```

Because the task stays non-terminal, the client continues the same conversation
by sending another message on the same task once the limit resets — the Claude
session is resumed, so no context is lost. Set `rateLimit.taskState` to
`"failed"` if your A2A client cannot handle a non-terminal task; the message
then tells the client to retry on the same `contextId` instead.

Rate limit details (`resetsAt`, `rateLimitType`) are only available under
claude.ai subscription auth. Under API key, Bedrock, or Vertex the wrapper still
ends the turn cleanly, but the message omits the reset time because the SDK does
not report one.

Warnings — approaching a limit, or an internal retry after a 429 — do not end
the turn. They surface as `rate_limit` sideband events, which can be disabled
with `features.emitRateLimitEvents: false`.
```

- [ ] **Step 3: Add the changeset**

Create `.changeset/claude-rate-limit-handling.md`:

```markdown
---
"a2a-claude": minor
"@a2a-wrapper/core": minor
---

Handle Claude rate limit events instead of failing the turn generically.

Rate-limit signals were previously unrecognised: `rate_limit_event`,
`system/api_retry`, and assistant `rate_limit` errors all fell through to a
debug log, and the turn surfaced as `failed` with `"Error during execution."` —
or, because the SDK retries internally, burned the whole `timeouts.prompt`
window and surfaced as a bogus timeout.

A rejection now ends the turn immediately with an `input-required` status naming
the limit type and reset time, plus structured metadata (`reason`,
`rateLimitType`, `resetsAt`, `resetsAtIso`, `utilization`). The task stays
non-terminal, so the client continues the same conversation on the same task
once the limit resets. Configurable via `rateLimit.taskState` for clients that
require a terminal state.

Adds a `rate_limit` sideband event type to `@a2a-wrapper/core`, gated by
`features.emitRateLimitEvents`.
```

- [ ] **Step 4: Verify JSON validity and run everything**

```bash
cd a2a-claude && node -e "JSON.parse(require('fs').readFileSync('schemas/agent-config.schema.json','utf8')); console.log('schema ok')"
export PATH="$HOME/.local/bin:$PATH" && cd .. && npm test && npm run typecheck && npm run build
```

Expected: `schema ok`, then all three commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add a2a-claude/schemas/agent-config.schema.json a2a-claude/README.md .changeset/claude-rate-limit-handling.md
git commit -m "docs(a2a-claude): document rate limit handling and config"
```

---

### Task 7: Full verification

- [ ] **Step 1: Confirm session behaviour was not touched**

```bash
git diff main --stat -- a2a-claude/src/claude/session-manager.ts a2a-claude/src/config/defaults.ts
```

Expected: no changes to `session-manager.ts`. `defaults.ts` should show only the `rateLimit` block and `emitRateLimitEvents` — if the `session.ttl` value appears in the diff, it belongs to the other PR and must be reverted here.

- [ ] **Step 2: Run the whole monorepo suite, typecheck, and build**

```bash
export PATH="$HOME/.local/bin:$PATH" && npm test && npm run typecheck && npm run build
```

Expected: all three exit 0.
