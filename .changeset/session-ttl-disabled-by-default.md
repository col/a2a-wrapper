---
"a2a-claude": minor
---

**Breaking:** session expiry is now disabled by default (`session.ttl` defaults
to `0`). Set `"session.ttl": 3600000` to restore the previous behaviour.

Previously sessions expired one hour after their **first** message regardless of
activity, which silently dropped the `contextId` → Claude session mapping and
made a conversation lose all of its context with no error and only an
`info`-level log line. Evicting the record reclaimed no disk either — the wrapper
never deletes SDK session files, so eviction orphaned the transcript rather than
removing it.

`session.ttl <= 0` now disables expiry in both eviction paths. A positive `ttl`
behaves as before. Both shipped example configs have been updated from
`3600000` to `0`.

Known consequence: if a Claude session's on-disk transcript is removed while the
server is running, the stored `contextId` → `sessionId` mapping is now pinned for
the life of the process instead of being evicted within the hour, so turns on
that context keep failing to resume until the server restarts. Previously the
one-hour expiry masked this by self-healing.
