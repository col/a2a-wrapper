# Design: Disable session TTL by default (`a2a-claude`)

**Date:** 2026-08-11
**Status:** Approved, ready for implementation
**Scope:** PR 1 of 2. Companion spec: `2026-08-11-rate-limit-handling-design.md`.

## Problem

`SessionManager` maps A2A `contextId` → Claude `sessionId`. That mapping is the
only thing that lets a follow-up turn resume an existing Claude conversation
(`buildQueryOptions` passes `resume: session.sessionId`). Claude persists the
actual transcript to disk itself (`persistSession: true`), so the map is just a
pointer to it.

The map is evicted on a one-hour TTL by default. When a record is evicted, the
next turn on that `contextId` runs with `resume: undefined` — a brand-new Claude
session. The user sees a conversation silently lose all its context. The only
trace is an `info`-level log line.

The TTL buys us almost nothing in return:

| Claimed benefit | Reality |
| --- | --- |
| Reclaims disk | False. Nothing in the wrapper or `@a2a-wrapper/core` deletes SDK session files. Evicting a record orphans the on-disk transcript rather than removing it. |
| Bounds memory | Technically true, marginally. A record is `{contextId, sessionId, two numbers, a settled Promise}` ≈ 400 bytes. 10,000 conversations ≈ 4 MB. |
| Guards against dangling `resume` ids | False. If `~/.claude/projects` is wiped, a 59-minute-old pointer dangles exactly as badly as a 5-hour-old one. |
| Stops conversations growing forever | Not the wrapper's call. The client owns `contextId`; sending the same one is a request for continuity. Claude auto-compacts long sessions. |

So the default trades real, silent, user-visible data loss for a few megabytes.

## Goal

Make "never expire" the default, while leaving an explicit `session.ttl` fully
functional for deployments that want it.

## Design

### Behaviour

`session.ttl <= 0` disables session expiry entirely. That becomes the default.

This is load-bearing in both directions: as the code stands today, setting
`ttl: 0` is not a no-op but a catastrophe. `getOrCreate`'s check is
`age < ttl`, false for every age when `ttl` is 0, so every lookup expires. The
cleanup sweep's check is `now - lastAccessedAt > ttl`, true for every record
when `ttl` is 0, so the first sweep deletes the entire map. **Both paths must
be guarded, or the new default destroys every session immediately.**

### Changes

**`a2a-claude/src/claude/session-manager.ts`**

In `getOrCreate` (currently lines 43–78):

- `const ttl = sessionCfg.ttl ?? 3_600_000;` → `?? 0`
- The reuse condition `age < ttl` → `ttl <= 0 || age < ttl`

In `startCleanup` (currently lines 107–122):

- Guard becomes `if (interval <= 0 || ttl <= 0) return;`
- Log at `info` when expiry is disabled, so operators can see it in startup
  logs rather than inferring it.

**`a2a-claude/src/claude/executor.ts`**

The `startCleanup` call site (currently lines 125–128) passes
`this.config.session.ttl ?? 3_600_000`. Change that fallback to `?? 0` so a
partial config object cannot resurrect the old default behind the new one.

**`a2a-claude/src/config/defaults.ts`**

- `session.ttl: 3_600_000` → `0`

**`a2a-claude/src/config/types.ts`**

- Update the `SessionConfig.ttl` doc comment: `Session TTL in ms. 0 or less
  disables expiry entirely (default: 0 — sessions never expire).`

**Docs**

Update any `README` / configuration reference that documents `session.ttl`, and
add a changelog entry for the default change.

### Tests

`a2a-claude/src/claude/__tests__/session-manager.test.ts`:

1. With `ttl: 0`, a session is reused after the clock advances well past the old
   one-hour default.
2. With `ttl: 0`, `startCleanup` does not evict — start the sweep, advance
   timers, assert the same session object comes back.
3. With `ttl: 0`, `startCleanup` does not even install a timer (assert via
   `vi.getTimerCount()` or equivalent), confirming the early return.
4. Existing `ttl > 0` behaviour is unchanged. The two existing TTL tests
   (`"expires sessions past TTL"`, `"cleanup removes stale sessions…"`) already
   pass `ttl: 1000` explicitly, so they should continue to pass untouched — that
   is itself the regression check that the default change did not alter
   configured behaviour.

## Explicitly out of scope

Both are documented as known issues rather than fixed here, to keep this PR to
a single concern:

1. **`getOrCreate` ages from `createdAt`, the cleanup sweep ages from
   `lastAccessedAt`.** The two halves of the TTL disagree: a conversation active
   every ten minutes is never touched by the sweep but is dropped by
   `getOrCreate` on the first turn after one hour. This is dormant under the new
   default (`ttl <= 0` short-circuits both) and only affects deployments that set
   `ttl` explicitly.

2. **The map is now unbounded.** With expiry off by default, a long-lived server
   accumulates ~400 bytes per conversation forever — roughly 150 MB/year at
   1,000 conversations/day. A size-based LRU cap (`session.maxEntries`) was
   considered and deliberately deferred; it is the right fix if this ever
   becomes real, and it is strictly better than a clock because it can only
   evict under genuine pressure rather than on a timer.

3. **Rate-limit handling.** Covered by the companion spec. This PR must not
   change session behaviour on behalf of rate limits, and that spec must not
   change session behaviour at all.

## Compatibility

Non-breaking at the config-schema level: `session.ttl` and
`session.cleanupInterval` keep their names, types, and meaning. Only the default
value changes.

Behaviour change worth a changelog note: conversations now resume indefinitely
on the same `contextId` instead of being silently reset after an hour.
