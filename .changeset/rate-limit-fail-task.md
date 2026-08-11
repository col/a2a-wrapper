---
"a2a-claude": minor
---

**Breaking:** a rate limit now always fails the task. The `rateLimit.taskState`
config option is removed.

It previously defaulted to `input-required`, on the reasoning that leaving the
task open let the client continue the same conversation. That reasoning does not
hold:

- **The interrupted turn cannot resume.** `ctx.task` only suppresses the initial
  `Task` record; the prompt sent is always the new user message, and there is no
  replay or continue-previous-turn logic. A follow-up on the open task is just a
  new prompt appended to the conversation — exactly what a new task would send.
- **Continuity never depended on the task state.** It comes from the
  `contextId` → Claude session mapping in `SessionManager`, which is indifferent
  to how a task ended. A new task on the same `contextId` resumes the identical
  Claude session.
- **`input-required` means the agent lacks information.** A rate limit lacks
  quota; nothing the client sends unblocks it, only elapsed time. Clients with
  generic `input-required` handling would prompt a human for input nobody wants.
- Publishing a non-terminal state alongside `final: true` was also internally
  inconsistent.

The status message now always points at the `contextId` rather than the closed
task, and still carries the structured metadata (`reason`, `rateLimitType`,
`resetsAt`, `resetsAtIso`, `utilization`) that an orchestrator needs to schedule
its own retry. `features.emitRateLimitEvents` is unchanged.

Migration: remove any `rateLimit` block from your config. If your orchestrator
alerts on failed tasks, key the suppression on `metadata.reason === "rate_limit"`.
