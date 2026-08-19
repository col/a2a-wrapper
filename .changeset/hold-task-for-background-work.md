---
"a2a-claude": minor
"@a2a-wrapper/core": minor
---

Hold the A2A Task open while Claude has background work in flight, instead of
completing it the moment the first SDK turn ends.

An A2A Task reached a terminal state as soon as Claude's first turn ended —
even when that turn started a background process and said it was waiting on
the result. A2A gives an agent no way to open a new turn against a terminal
Task, so the eventual follow-up report had nowhere to land: the client had
already been told the Task was done.

The Task now stays in `working` for as long as Claude reports background work
in flight. Each SDK turn ("round") publishes its own `response` artifact plus
a non-final `working` status update whose `metadata.backgroundTasks` lists
what's still running (`taskId`, `type`, `description`). The Task only
completes once a round ends with nothing left. Chains of any length work this
way — check the build, start the deploy, report the result — as rounds of one
Task rather than a string of separate ones.

This forced a change to how queries are issued: with a plain string prompt,
the SDK closes the CLI subprocess's stdin on the first result and the process
exits, making a second turn impossible at any SDK version. Queries now use
streaming-input mode instead, keeping the subprocess alive across rounds. A
per-query `BackgroundTaskTracker` follows the SDK's `background_tasks_changed`
message — a level signal with replace semantics, not a pair of start/stop
edges — to know what's still running. This required bumping
`@anthropic-ai/claude-agent-sdk` from `0.3.202` to `^0.3.235`, the first
version to emit that message.

Both behaviors are gated by feature flags, on by default:
`features.holdTaskForBackgroundWork` (default `true`; set `false` to restore
the previous completes-at-first-result behavior) and
`features.emitBackgroundTaskEvents` (default `true`), which publishes a
`background_tasks` sideband event each time the live set changes.

Two wire-visible changes worth knowing about even if you don't use the new
flags: a success result with empty text no longer publishes an empty
`response` artifact (the old code published one unconditionally), and
`agent_started` / `agent_finished` sideband events are now emitted once per
A2A Task rather than once per SDK turn — the SDK re-emits `system/init` on
every background-task wake, so without this a held-open Task would have
emitted `agent_started` several times over.

Adds a `background_tasks` sideband event type to `@a2a-wrapper/core`, gated by
`features.emitBackgroundTaskEvents`.
