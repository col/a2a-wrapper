---
"a2a-claude": patch
---

**Fix:** cancelling a turn no longer breaks the next turn in the same context.

Cancellation used to `abortController.abort()`, which SIGKILLs the Claude
subprocess mid-turn. With `persistSession: true` that leaves the session
transcript truncated, so the *next* turn's `resume` returns an immediate empty
result and does nothing — the turn after that recovers. (Real symptom: cancel a
running turn, send a prompt, it "completes" instantly having done nothing; send
another and it works.)

Turns are now driven in the SDK's **streaming-input mode**, which makes
`query.interrupt()` available. Cancellation prefers a graceful `interrupt()` —
the turn stops and the subprocess exits cleanly, so the session persists intact
and the next turn resumes normally. `abort()` remains only as a fallback when no
live query exists yet or the CLI lacks streaming-input control support.

The interrupted turn ends with a terminal result, so the run loop now suppresses
the `completed`/`failed` status it would otherwise publish — cancellation is
reported exactly once, as `canceled`.
