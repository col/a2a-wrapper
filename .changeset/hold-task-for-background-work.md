---
"a2a-claude": minor
"@a2a-wrapper/core": minor
---

Hold the A2A Task open while Claude has background work in flight.

A Task used to reach a terminal state as soon as Claude's first turn ended —
even when that turn had just started a background process and said it was
waiting on the result. A2A gives an agent no way to open a new turn against a
terminal Task, so the follow-up report had nowhere to land.

The Task now stays in `working` for as long as Claude reports background work
running, and completes only once a turn ends with nothing left. Each turn
publishes its own `response` artifact and a non-final `working` status update
whose `metadata.backgroundTasks` lists what is still in flight. Chains of any
length work this way, as rounds of one Task rather than several Tasks.

Controlled by `features.holdTaskForBackgroundWork` (default `true`; set
`false` for the old complete-at-first-result behavior) and
`features.emitBackgroundTaskEvents` (default `true`), which publishes a new
`background_tasks` sideband event — added to `@a2a-wrapper/core` — each time
the live set changes.

Bumps `@anthropic-ai/claude-agent-sdk` from `0.3.202` to `0.3.245`. The
feature needs at least `0.3.235`, the first version to emit
`background_tasks_changed`.

Three changes apply even with `holdTaskForBackgroundWork` off:

- Queries now use streaming input rather than a string prompt. A string prompt
  makes the SDK close the CLI subprocess's stdin on the first result, which
  ends the process before a second round is possible. This is not switchable.
- `agent_started` / `agent_finished` are emitted once per A2A Task rather than
  once per SDK turn.
- A success result with empty text no longer publishes an empty `response`
  artifact.

See the a2a-claude README for caveats, including how `claude.maxTurns` and
`timeouts.prompt` now span a held-open Task's rounds.
