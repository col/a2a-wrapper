---
"a2a-claude": patch
---

**Fix:** cancelling a turn no longer breaks the next turn in the same context.

`cancelTask` called `abortController.abort()` first, which SIGKILLs the Claude
subprocess mid-turn. With `persistSession: true` that leaves the session
transcript truncated, so the *next* turn's `resume` returns an immediate empty
result and does nothing — the turn after that recovers. (Symptom: cancel a
running turn, send a prompt, it "completes" instantly having done nothing; send
another and it works.)

Cancellation now prefers a graceful `interrupt()` — already available since the
turn is driven in streaming-input mode. The turn stops and the subprocess exits
cleanly, so the session persists intact and the next turn resumes normally.
`abort()` remains only as a fallback when there is no live query yet or interrupt
throws.

Because a graceful interrupt ends the turn with an ordinary terminal result
(rather than an abort), the run loop now suppresses the `completed`/`failed` it
would otherwise publish, keyed on a `canceled` flag rather than solely on
`abortController.signal.aborted`. Cancellation is still reported exactly once, as
`canceled`.
