---
"a2a-claude": minor
---

Session expiry is now disabled by default (`session.ttl` defaults to `0`).

Previously sessions expired one hour after their **first** message regardless of
activity, which silently dropped the `contextId` → Claude session mapping and
made a conversation lose all of its context with no error and only an
`info`-level log line. Evicting the record reclaimed no disk either — the wrapper
never deletes SDK session files, so eviction orphaned the transcript rather than
removing it.

`session.ttl <= 0` now disables expiry in both eviction paths. A positive `ttl`
behaves as before. Both shipped example configs have been updated from
`3600000` to `0`.
