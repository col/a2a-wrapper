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
