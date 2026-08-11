---
"a2a-claude": minor
---

**Breaking:** session expiry is now disabled by default (`session.ttl` defaults
to `0`), and the background cleanup sweep with it (`session.cleanupInterval`
also defaults to `0`). Set `"session.ttl": 3600000` and
`"session.cleanupInterval": 300000` to restore the previous behaviour.

Previously sessions expired one hour after their **first** message regardless of
activity, which silently dropped the `contextId` → Claude session mapping and
made a conversation lose all of its context with no error and only an
`info`-level log line. Evicting the record reclaimed no disk either — the wrapper
never deletes SDK session files, so eviction orphaned the transcript rather than
removing it.

`session.ttl <= 0` now disables expiry in both eviction paths. A positive `ttl`
behaves as before.

`cleanupInterval` is only ever consulted when `ttl > 0` — with expiry off there
is nothing to sweep — so leaving it at `300000` alongside `ttl: 0` was dead
configuration that read as if it did something. It now defaults to `0` to match,
and both example configs drop it entirely. If you set `ttl` on its own you get
expiry via the lazy check in `getOrCreate`, but a context that is never used
again holds its record until the process exits; set `cleanupInterval` too if you
want that reclaimed. Both disabled states are now logged at startup, so neither
can be lost silently.

Known consequence: if a Claude session's on-disk transcript is removed while the
server is running, the stored `contextId` → `sessionId` mapping is now pinned for
the life of the process instead of being evicted within the hour, so turns on
that context keep failing to resume until the server restarts. Previously the
one-hour expiry masked this by self-healing.
