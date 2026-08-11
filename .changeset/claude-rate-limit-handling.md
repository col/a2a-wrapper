---
"a2a-claude": minor
"@a2a-wrapper/core": minor
---

Handle Claude rate limit events instead of failing the turn generically.

Rate-limit signals were previously unrecognised: `rate_limit_event`,
`system/api_retry`, and assistant `rate_limit` errors all fell through to a
debug log, and the turn surfaced as `failed` with `"Error during execution."`

A rejection now ends the turn immediately with an `input-required` status naming
the limit type and reset time, plus structured metadata (`reason`,
`rateLimitType`, `resetsAt`, `resetsAtIso`, `utilization`, and `errorCode` /
`canPurchaseCredits` when the SDK reports them). The task stays non-terminal, so
the client continues the same conversation on the same task once the limit
resets. Configurable via `rateLimit.taskState` for clients that require a
terminal state.

This does not shorten the SDK's own retry behaviour: a `system/api_retry` is
deliberately treated as a warning that does not end the turn, so the SDK's
internal retries still run to exhaustion inside the same `timeouts.prompt`
window. The turn ends only once the SDK gives up and emits an assistant
`rate_limit` error. Those retries are at least visible now, as `rate_limit`
sideband events with `action: "retrying"` carrying the SDK's `attempt`,
`maxRetries`, and `delayMs`.

A rejection whose overage window is still open is treated as a warning rather
than a rejection, since the request may proceed on overage credits; if it does
not, the assistant `rate_limit` error still ends the turn. Limit details are
never fabricated — a limit type or reset time is inherited by a later signal
only from a snapshot that reported pressure, utilization is never inherited, and
a reset time that is not in the future is dropped.

Adds a `rate_limit` sideband event type to `@a2a-wrapper/core`, gated by
`features.emitRateLimitEvents`.
