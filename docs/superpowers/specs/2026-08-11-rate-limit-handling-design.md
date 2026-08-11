# Design: Handle Claude rate limit events (`a2a-claude`)

**Date:** 2026-08-11
**Status:** Approved, ready for implementation
**Scope:** PR 2 of 2. Companion spec: `2026-08-11-session-ttl-disable-design.md`.

## Problem

When the Claude Agent SDK reports a rate limit, the wrapper does not recognise
it. Every rate-limit signal falls through to a debug log, and the turn ends as
a generic failure:

| SDK signal | Current handling |
| --- | --- |
| `rate_limit_event` (`status`, `resetsAt`, `rateLimitType`, `utilization`) | Unhandled — hits `default:` in `EventMapper.handleMessage` (`event-mapper.ts:104`) |
| `system/api_retry` with `error: "rate_limit"` | Unhandled — `handleSystem` only matches `init` and `permission_denied` (`event-mapper.ts:112`) |
| `assistant` message with `error: "rate_limit"` | Unhandled |
| Terminal outcome | Surfaces as `error_during_execution` → `"Error during execution."`, published as `failed` (`executor.ts:300-314`) |

Two consequences. The client is told nothing useful — no limit type, no reset
time, no indication that retrying later would work. And because the SDK retries
internally before giving up, a rate-limited turn can also burn the whole
`timeouts.prompt` window (default 10 minutes) and surface as a bogus timeout.

## Goals

1. End the turn promptly and deliberately when a rate limit rejects the request,
   rather than letting it decay into a timeout or a generic failure.
2. Tell the client what happened, when it resets, and what to do about it — in
   both prose and machine-readable metadata.
3. Leave the Claude session resumable, so the client continues the same
   conversation on the same `contextId` once the limit resets.

## Non-goals

- **No session-lifetime changes.** No edits to `session-manager.ts`, no
  `expiresAt`, no pinning a session past a reset. If a configured `session.ttl`
  expires before the limit resets, the context is lost — accepted, and separated
  deliberately from the companion PR.
- **No waiting or auto-retry.** The wrapper never blocks for a reset. The client
  decides when to come back.
- **No partial-output artifact.** Whatever the model produced before the limit
  hit is retained in the Claude session and available on resume, but is not
  published as a `response` artifact. (One protocol-hygiene exception below.)

## Design

### 1. `RateLimitTracker` — detection

New file `a2a-claude/src/claude/rate-limit-tracker.ts`. Detection lives here
rather than inline in the executor because `turnFn` already peeks at raw SDK
messages for four separate concerns and `executor.ts` is the largest file in the
package. It is deliberately *not* folded into `EventMapper`: that class is pure
observability, its errors are swallowed by design (`event-mapper.ts:107`), and
turn-ending control flow must not depend on a component whose exceptions are
intentionally ignored.

```ts
export interface RateLimitSnapshot {
  status: "allowed" | "allowed_warning" | "rejected";
  rateLimitType?: string;   // five_hour | seven_day | seven_day_opus | ...
  resetsAt?: number;        // normalized to epoch milliseconds
  utilization?: number;
  source: "rate_limit_event" | "assistant_error" | "api_retry";
}

export type RateLimitVerdict =
  | { kind: "none" }
  | { kind: "warning"; snapshot: RateLimitSnapshot }
  | { kind: "rejected"; snapshot: RateLimitSnapshot };

export class RateLimitTracker {
  observe(msg: SDKMessageLike): RateLimitVerdict;
  get snapshot(): RateLimitSnapshot | null;   // last known, for metadata
}
```

Recognised messages, all read defensively off the untyped `SDKMessageLike`:

| Message | Verdict |
| --- | --- |
| `rate_limit_event`, `rate_limit_info.status === "rejected"` | `rejected` — end the turn |
| `rate_limit_event`, status `allowed_warning` | `warning` — sideband only, turn continues |
| `rate_limit_event`, status `allowed` | `none`, snapshot updated |
| `system/api_retry`, `error === "rate_limit"` | `warning` — sideband only; short internal retries ride through normally |
| `assistant`, `error === "rate_limit"` | `rejected` — degradation path for API-key / Bedrock / Vertex, where `rate_limit_event` never fires and no `resetsAt` exists |

**`resetsAt` normalization.** The SDK types it as a bare `number` with no unit.
Normalize explicitly rather than guess: values below `1e12` are Unix **seconds**
and multiplied by 1000, values at or above are already milliseconds. The
threshold is unambiguous — `1e12` ms is 2001-09-09, and a plausible reset in
seconds is ~1.8e9. Non-finite, non-positive, or non-numeric values yield
`undefined`, never a fabricated timestamp.

### 2. Executor — turn termination

In `turnFn` (`executor.ts:252-350`), before the message loop:

```ts
const rateLimits = new RateLimitTracker();
let rateLimited: RateLimitSnapshot | null = null;
```

Inside the loop, at the top:

```ts
const verdict = rateLimits.observe(msg);
if (verdict.kind !== "none") mapper.handleRateLimit(verdict);
if (verdict.kind === "rejected") { rateLimited = verdict.snapshot; break; }
```

After the loop, **before** the existing `resultError` check:

```ts
if (rateLimited) {
  abortController.abort();
  const state = this.config.rateLimit.taskState ?? "input-required";
  if (streaming && streamArtifactStarted) {
    publishLastChunkMarker(bus, taskId, contextId, streamArtifactId, finalText);
  }
  publishStatus(bus, taskId, contextId, state,
    renderRateLimitMessage(rateLimited, state), true, {
      reason: "rate_limit",
      rateLimitType: rateLimited.rateLimitType,
      resetsAt: rateLimited.resetsAt,
      resetsAtIso: rateLimited.resetsAt ? new Date(rateLimited.resetsAt).toISOString() : undefined,
      utilization: rateLimited.utilization,
      source: rateLimited.source,
    });
  bus.finished();
  return;
}
```

`break`-then-`abort` mirrors the teardown `preflightPlugins` already uses
successfully (`executor.ts:177`, `executor.ts:186`), so this is an established
pattern in the file rather than a new one.

The `publishLastChunkMarker` call is the one exception to "no partial output".
It is not a content decision: when `features.streamArtifactChunks` is enabled,
chunks have already gone out with `append: true, lastChunk: false`, and
abandoning the artifact unterminated leaves the client's stream permanently
open. This closes it. When streaming is off, nothing is published.

Note that `finalText` is `""` on this path — it is only assigned from a
successful `result` message, which never arrives. That is intentional: the
marker terminates the stream and appends nothing. Do **not** "fix" this by
accumulating streamed deltas into a buffer to pass here; that would republish
partial output, which is explicitly out of scope. The already-delivered chunks
stand on their own, and the full work is preserved in the Claude session.

Metadata keys whose values are `undefined` should be omitted from the object
rather than emitted as explicit nulls.

The existing `finally` block already clears the prompt timer and calls
`untrackExecution`, so no changes there.

**How continuity is restored.** With `taskState: "input-required"` (the
default), the task is non-terminal. The client's follow-up arrives on the same
`taskId`, so `ctx.task` is set and `publishTask` is skipped;
`getOrCreate(contextId)` returns the preserved record; `buildQueryOptions`
passes `resume: session.sessionId`. Claude's transcript is already on disk
(`persistSession: true`, `client-factory.ts:150`), so the interrupted turn's
work is intact — the same mechanism `cancelTask` relies on today.

**To verify during implementation:** that a turn aborted *mid-tool-call* replays
cleanly on resume. It is the same code path as an existing cancel, so it is
expected to work, but it should be confirmed against a real session rather than
assumed.

### 3. Client-facing message

`renderRateLimitMessage(snapshot, taskState)` produces, for example:

> Rate limit reached (5-hour limit). Resets at 2026-08-11T18:00:00Z. Send
> another message on this task to continue.

Rules:

- The parenthetical is derived from `rateLimitType` via a label map
  (`five_hour` → "5-hour limit", `seven_day` → "7-day limit",
  `seven_day_opus` → "7-day Opus limit", `seven_day_sonnet` → "7-day Sonnet
  limit", `seven_day_overage_included` → "7-day limit (overage included)",
  `overage` → "overage limit"). An unknown or absent type omits the
  parenthetical entirely rather than printing a raw enum.
- The reset clause is omitted when `resetsAt` is `undefined`, rather than
  printing a fabricated or epoch-zero time.
- Times render as ISO 8601 UTC — unambiguous, and no server-locale guessing.
- The closing sentence follows the configured `taskState`: non-terminal states
  say "Send another message on this task to continue"; `failed` says "Retry on
  the same contextId to continue this conversation." A terminal task cannot
  accept another message, and the prose must not tell the client otherwise.

### 4. Sideband event

Add `"rate_limit"` to the `EventType` union in
`packages/core/src/events/transport.ts:48-56`. Additive, so the other four
wrappers are unaffected. Check whether any test asserts the union exhaustively
and update it if so.

`EventMapper` gains:

```ts
handleRateLimit(verdict: RateLimitVerdict): void
```

gated on `features.emitRateLimitEvents`, emitting:

```ts
{
  backend: "claude",
  status,          // allowed_warning | rejected
  rateLimitType,
  resetsAt,
  utilization,
  action,          // "ended_turn" | "warning" | "retrying"
}
```

`action` is `"ended_turn"` for `rejected`, `"retrying"` for an `api_retry`
warning, `"warning"` for an `allowed_warning`. The executor passes the verdict
in rather than having `EventMapper` re-parse the message, so detection rules
live in exactly one place.

### 5. Config

`a2a-claude/src/config/types.ts`:

```ts
export interface RateLimitConfig {
  /**
   * A2A task state published when a rate limit ends a turn.
   * Non-terminal states let the client continue the same task after the reset.
   * @default "input-required"
   */
  taskState?: "input-required" | "failed" | "auth-required";
}

export interface AgentConfig {
  // ...
  rateLimit?: RateLimitConfig;
}
```

`FeatureFlags` gains:

```ts
/** Publish rate-limit status changes as sideband events. Default: true. */
emitRateLimitEvents?: boolean;
```

`config/defaults.ts`: `rateLimit: { taskState: "input-required" }` and
`features.emitRateLimitEvents: true`.

`ClaudeExecutor.validateConfig` validates `rateLimit.taskState` against a
`VALID_RATE_LIMIT_TASK_STATES` set, matching the existing style used for
`VALID_PERMISSION_MODES` and `VALID_EFFORT_LEVELS` (`executor.ts:44-46`).

### 6. Tests

**`rate-limit-tracker.test.ts`** (new) — no executor, no bus, no fake client:

1. `rate_limit_event` with `status: "rejected"` → `rejected` verdict carrying
   `rateLimitType`, `resetsAt`, `utilization`.
2. `status: "allowed_warning"` → `warning`.
3. `status: "allowed"` → `none`, but `snapshot` updated.
4. `system/api_retry` with `error: "rate_limit"` → `warning`, never `rejected`.
5. `system/api_retry` with a non-rate-limit error → `none`.
6. `assistant` with `error: "rate_limit"` → `rejected`, `source:
   "assistant_error"`, `resetsAt` undefined.
7. `resetsAt` normalization: seconds are scaled to ms; ms pass through;
   `undefined` / `null` / `NaN` / negative yield `undefined`.
8. Unrelated messages (`init`, `result`, `stream_event`) → `none`.

**`executor-rate-limit.test.ts`** (new), via the existing
`__tests__/fake-client.ts`:

1. Rejected mid-turn → task ends `input-required`, status message names the
   limit type and reset time, metadata carries `reason: "rate_limit"` and the
   structured fields, and the query is torn down.
2. `rateLimit.taskState: "failed"` → publishes `failed`, and the message says
   "same contextId" rather than "this task".
3. `allowed_warning` mid-turn → sideband event emitted, turn still completes
   normally with its final artifact.
4. `emitRateLimitEvents: false` → no sideband event, but the turn still ends
   correctly on a rejection.
5. Rejection with `resetsAt` absent → message omits the reset clause, no
   fabricated timestamp in prose or metadata.
6. Streaming enabled and chunks already sent → the artifact is terminated with a
   last-chunk marker.
7. No rate-limit messages → existing behaviour byte-for-byte unchanged.

**`config/__tests__/loader.test.ts`** — an invalid `rateLimit.taskState` is
rejected at startup.

## Compatibility

Purely additive. New config keys default to current-equivalent behaviour except
for the intended change: a rate-limited turn now ends as `input-required` with a
useful message instead of `failed` with `"Error during execution."` Deployments
whose A2A client cannot handle a non-terminal task can set
`rateLimit.taskState: "failed"` to keep a terminal state while still gaining the
message and metadata.

The `packages/core` change is one added union member, affecting no existing
consumer.
