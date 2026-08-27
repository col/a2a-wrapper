# Emit rate-limit warnings as trace artifacts (a2a-claude) — design

**Ticket:** TX-79 (companion to the throngx rate-limit timeline cards work)
**Date:** 2026-08-27
**Repo:** `a2a-wrapper` / `a2a-claude`
**Consumer:** `throngx` folds the artifact defined here into an inline timeline
card. The throngx side is already built against this contract and is inert until
this ships.

## Problem

The wrapper already detects rate-limit **warnings** ("approaching the limit",
`status: "allowed_warning"`) and **retries** (`source: "api_retry"`), and emits
them via `EventMapper.handleRateLimit()` as a sideband `rate_limit` agent event.

That event type is **not** in `EVENT_TO_TRACE_KEY` in
`packages/core/src/events/transport.ts`, so `A2ATransport.send()` returns early
and the event is **silently dropped on the A2A transport**. A2A consumers
(throngx) therefore never see warnings or retries — only the terminal rejection,
which rides the separate status-update `metadata` path.

Rate-limit **rejections** are unaffected and out of scope here: they end the turn
via `publishStatus(..., rateLimitMetadata(snapshot))` and already reach consumers
on `TaskStatusUpdateEvent.metadata`. This spec covers **warnings and retries
only**.

## Goal

Deliver rate-limit **warning** and **retry** signals to A2A consumers by emitting
them as a **`trace.rate_limit` trace artifact** — the same delivery mechanism the
wrapper already uses for `trace.thinking`, `trace.mcp`, `trace.decision`,
`trace.lifecycle`, etc., all of which route over the A2A transport and are folded
by throngx today.

## Non-goals

- No change to rejection handling (status-update `metadata` path stays as is).
- No change to the `rate_limit` **sideband agent event** itself — HTTP/custom
  transports that already consume it keep working. This spec **adds** a trace
  artifact; it does not remove the existing event. (Optionally the sideband event
  can remain for non-A2A consumers.)
- No retry/auto-restart behaviour changes.

## Design

### Artifact name

`trace.rate_limit` — consistent with the existing `trace.*` sideband family.

### When emitted

From the same detection point that currently calls the sideband emit — the
warning and retry verdicts produced by `RateLimitTracker.observe()`:

- `verdict.kind === "warning"` with `snapshot.source === "api_retry"` → `action: "retrying"`
- `verdict.kind === "warning"` (approaching limit) → `action: "warning"`
- `verdict.kind === "rejected"` → **not** emitted as a trace artifact; the
  rejection continues to end the turn via the status `metadata` path. (Emitting a
  rejection trace as well is optional and left out to avoid double-signalling the
  same event; throngx renders the rejection from the status metadata.)

Gated by the existing `config.features.emitRateLimitEvents` flag (default `true`).

### Artifact `DataPart` `data` shape

The trace artifact carries one `DataPart` whose `data` map is:

```jsonc
{
  "status":        "allowed_warning",          // RateLimitStatus
  "action":        "warning" | "retrying",
  "rateLimitType": "five_hour",                 // optional; omit when absent
  "resetsAt":      1786471200000,               // optional; epoch ms
  "utilization":   0.9,                          // optional; 0–1
  "retry": {                                     // optional; present for action:"retrying"
    "attempt":    2,
    "maxRetries": 5,
    "delayMs":    4000
  }
}
```

Rules (match the existing `rateLimitMetadata()` conventions):

- Omit any optional key whose source value is `undefined` (never emit `null`).
- Keys are camelCase, consistent with other trace artifacts' `data` maps. (throngx
  reads defensively and snake-cases on its side.)
- `resetsAt` is epoch **milliseconds**, already normalised by the tracker (values
  below `1e12` are treated as seconds ×1000; non-future values dropped).

### Artifact `metadata.timestamp`

Every trace artifact the wrapper emits stamps `metadata.timestamp` (ISO-8601);
throngx reads it for the entry's `occurred_at` (`EventLog.artifact_time/2`). Emit
it here the same way as the other `trace.*` artifacts (reuse the shared trace
artifact builder).

### Implementation sketch

- In `EventMapper.handleRateLimit()` (`a2a-claude/src/claude/event-mapper.ts`),
  alongside (or instead of) the sideband `emit("rate_limit", …)`, publish a
  `trace.rate_limit` artifact through the same trace-artifact publisher used for
  `trace.thinking`/`trace.decision` (see `publishTraceArtifact` in
  `packages/core/src/events/event-publisher.ts`), for the `warning`/`retrying`
  actions only.
- Reuse the snapshot→payload mapping already present in `handleRateLimit()`
  (`rateLimitType`/`resetsAt`/`utilization`/`retry`), plus `status` and `action`.
- No change needed to `EVENT_TO_TRACE_KEY`: trace artifacts route via the artifact
  path, not the sideband-event trace-key map. (If the sideband `rate_limit` event
  is kept, adding it to `EVENT_TO_TRACE_KEY` is an *optional* separate improvement
  and not required by this spec.)

## Consumer contract (throngx — for reference)

throngx folds `trace.rate_limit` in `EventLog.fold_artifact/4` into a
`:rate_limit` entry and renders an inline warning card. It reads `status`,
`action`, `rateLimitType`, `resetsAt`, `utilization`, and `retry` defensively
(tolerating both camelCase and snake_case), and uses `metadata.timestamp` for
ordering. Only the artifact **name**, the **`data` keys above**, and
**`metadata.timestamp`** are load-bearing across the boundary.

## Testing (TDD)

- `EventMapper.handleRateLimit()` emits a `trace.rate_limit` artifact for
  `warning` and `retrying` verdicts, with the correct `data` shape and omitted
  optional keys, gated by `emitRateLimitEvents`.
- No `trace.rate_limit` artifact is emitted for a `rejected` verdict (rejection
  path unchanged).
- The artifact carries `metadata.timestamp`.
- Existing rejection status-metadata tests remain green (no regression).

## Files (expected)

- `a2a-claude/src/claude/event-mapper.ts` — emit the trace artifact
- `a2a-claude/src/claude/__tests__/…` — tests
- (no change required to `transport.ts` for the trace-artifact path)
- changeset describing the new artifact
