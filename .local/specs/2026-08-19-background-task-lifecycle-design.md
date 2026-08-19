# Decoupling the A2A Task lifecycle from the SDK turn

**Date:** 2026-08-19
**Package:** `a2a-claude`
**Status:** Approved — ready for implementation planning

## Problem

An A2A Task reaches a terminal state the moment the SDK turn ends. That breaks
whenever Claude starts a background process and ends its turn saying it is
waiting for it: the A2A Task is already `completed`, and A2A gives an agent no
way to initiate a turn, so the follow-up can never be delivered. The work
finishes, the report is written, and nobody receives it.

This design decouples the two lifecycles. The A2A Task stays open while
background work is in flight, and each subsequent SDK turn streams onto the same
`taskId`.

## Current behaviour

`a2a-claude/src/claude/executor.ts` holds the entire mapping in `execute()`.
One A2A Task equals one `runQuery()` call equals one `for await` loop:

- `publishTask` + `submitted`, then `working`
- every message is forwarded to `EventMapper` for sideband events
- `result.subtype === "success"` captures `finalText`
- the loop ends, and the post-loop block publishes the final artifact,
  `completed`, and `bus.finished()`

Terminality is therefore welded to *iterator exhaustion*, not to any signal
about whether work is still in flight. Turns are serialized per `contextId` by
`session.executionQueue`; continuity across Tasks comes from `session.sessionId`
plus `options.resume`.

## Investigation findings

Three findings shaped the design. The first two are constraints; the third
removes an option we would otherwise have taken.

### 1. `background_tasks_changed` requires an SDK bump

`a2a-claude` pins `@anthropic-ai/claude-agent-sdk` at `0.3.202`, whose
`SDKMessage` union carries only the edge bookends — `task_started`,
`task_updated`, `task_progress`, `task_notification`. Neither the typings nor
the native CLI binary contain `background_tasks_changed` at that version. It
exists in `0.3.235` (current `latest`) as `SDKBackgroundTasksChangedMessage`,
documented as a level signal with replace semantics, per-process, with nothing
emitted at startup.

`a2a-claude` is the only package in the monorepo that depends on this SDK, so
the bump is contained.

### 2. A string prompt makes a second result impossible

From the SDK bundle, present identically in `0.3.202` and `0.3.235`:

```js
if (e.type === "result") { …
  if (this.isSingleUserTurn)
    "First result received for single-turn query, closing stdin",
    this.transport.endInput() }
```

`isSingleUserTurn` is set from `typeof prompt === "string"`, which is exactly
what `createClaudeClient` passes today. The SDK closes the CLI's stdin the
instant the first result arrives, the subprocess exits, and the iterator ends.
There is no window in which a follow-up could arrive, at any SDK version.

Multiple assistant turns and multiple `result` messages within one live query
are supported — but only in *streaming-input* mode
(`prompt: AsyncIterable<SDKUserMessage>`). This is the load-bearing change; the
background-task bookkeeping is comparatively trivial.

### 3. `session_state_changed` is not available in headless SDK mode

`SDKSessionStateChangedMessage` documents `state: 'idle'` as the "authoritative
turn-over signal", which would be a more direct settle signal than counting
background tasks. It was evaluated and rejected on evidence: across two spikes
totalling roughly 200 seconds of streamed messages, it **never fired once**. Its
own doc says it "mirrors notifySessionStateChanged" — evidently a host/TUI-side
notification that the stream-json transport does not carry.

Counting the level set is not a compromise. It is the only signal that exists.

### Spike evidence

Two spikes were run against SDK `0.3.235` in streaming-input mode. Both are to
be checked in under `scripts/background-tasks-smoke/` as part of this work (see
Rollout).

**Spike 1 — single background task, does a second result arrive at all:**

```
[  5821ms] >>> background_tasks_changed ["bf18rp7dx"]
[  7186ms] ### RESULT #1 (success) "Started it in the background and I'm waiting..."
[ 45847ms] >>> background_tasks_changed []
[ 45848ms]     task_notification bf18rp7dx completed
[ 45878ms]     system/init (same session id)
[ 50096ms] ### RESULT #2 (success) "The background task finished with exit code 0..."
[150563ms] ### iterator completed normally
```

Two results on one query, with no user message pushed for the second. The CLI
woke itself when the background task settled and Claude proactively read the
output file and reported.

**Spike 2 — two-stage chain, with the proposed decision logic mirrored inline:**

```
[  3261ms] >>> bg_changed ["byw8jjhib"]
[  4958ms] ### RESULT #1 -> HOLD (waiting on byw8jjhib)
[ 23289ms] >>> bg_changed []
[ 25418ms] >>> bg_changed ["bua0fchld"]
[ 26556ms] ### RESULT #2 -> HOLD (waiting on bua0fchld)
[ 45449ms] >>> bg_changed []
[ 48498ms] ### RESULT #3 -> COMPLETE
[ 48885ms] ### iterator completed normally

decisions=["HOLD","HOLD","COMPLETE"]
```

Three conclusions:

- **Ordering has comfortable margin.** The set was populated 1.4s before result
  #1 in spike 1, and a *newly started* task registered 1.1s before the result
  that ended its turn in spike 2. The clearing transition landed 4.2s and 3.0s
  ahead of its following result. At every result the set was accurate.
- **Closing the input stream is clean and fast** — 386ms from decision to
  iterator completion, with no abort required.
- **An `init` is re-emitted on every wake**, carrying the same `session_id`
  (three of them across spike 2).

## Approach

**Query per A2A Task, with the input stream held open.** `execute()` still
creates one query, but feeds it an async iterable that yields the prompt and
then parks. The turn loop reads past the first `result`. When the Task is
decided to be over, the iterable is closed, the SDK ends input, the CLI exits,
and the iterator completes.

Blast radius is confined to `client-factory.ts`, `prompt-builder.ts`,
`executor.ts`, `event-mapper.ts`, and one new module. `SessionManager`, `resume`
continuity, cancellation, TTL cleanup, and the sub-agent, plugin-preflight and
`buildContext` paths are untouched.

### Alternatives rejected

**One long-lived query per `contextId`.** Genuinely better in two ways: no
respawn or `--resume` replay cost, and background work started under one Task
survives into the next. But the shared iterator carries no `taskId`, so every
message needs demultiplexing to "whichever A2A Task is currently active"; it
rewrites `SessionManager`, cancellation semantics and TTL cleanup; and one
throwing turn takes the process down for every future Task on that context. Its
main advantage is not collectable today — once a Task is terminal, A2A offers
nowhere to deliver to, short of adding push-notification support. Revisit if
that changes.

**Complete the Task and transition to `input-required`,** letting the client
re-prompt to collect results. Needs no streaming-mode change, but requires
client cooperation and burns a round trip.

## Design

### Dependency

`@anthropic-ai/claude-agent-sdk`: `0.3.202` → `^0.3.235`. Review the intervening
changelog before merging — that is 33 patch releases on a 0.x line.

### Streaming input

`ClaudeClientLike.runQuery` widens its first parameter from `string` to
`string | AsyncIterable<SDKUserMessageLike>`. `createClaudeClient` needs no
change: `query({ prompt, options })` already accepts both. `preflightPlugins`
and `buildContext` keep passing strings and stay one-shot; only `execute()`
passes a stream.

`promptStream()` joins `extractUserText()` in `prompt-builder.ts`, built on the
existing `createDeferred` from `@a2a-wrapper/core`:

```ts
async function* promptStream(text: string, closed: Promise<void>) {
  yield { type: "user", parent_tool_use_id: null,
          message: { role: "user", content: text } };
  await closed;   // parking here keeps stdin open; resolving lets the CLI exit
}
```

`uuid` and `session_id` are optional on `SDKUserMessage`, so nothing further is
required on the message.

### Background task tracking

New `a2a-claude/src/claude/background-tasks.ts`:

```ts
export class BackgroundTaskTracker {
  observe(msg: SDKMessageLike): boolean;  // true when membership changed
  get size(): number;
  snapshot(): Array<{ taskId: string; type: string; description: string }>;
}
```

Only `background_tasks_changed` is consumed, with strict replace semantics. The
edge bookends are deliberately ignored, per the SDK's own warning that their
ordering relative to the level is unspecified.

**Scope is per query, not per session.** Under this approach each A2A Task gets
its own CLI process, so a per-session tracker would carry a dead process's set
into a fresh one. Per-query, instance lifetime *is* process lifetime, which
makes the SDK's "reset to empty whenever the CLI process restarts" requirement
structural rather than a code path that can be forgotten.

### Lifecycle

The `for await` loop no longer treats a `result` as the end. On each `result`:

| condition | action |
|---|---|
| `resultError` set | `failed` + `finished` (unchanged) |
| live set non-empty | artifact for this round + non-final `working` status; keep reading |
| live set empty | artifact for this round + `completed` + `finished`; close the stream |

Terminality moves from "the iterator ended" to "a result arrived with nothing in
flight". The iterator ending becomes a consequence of the decision rather than
its cause.

There is no cap on rounds beyond the existing timeout; a chain of any length is
handled, which is what makes "check build → start deploy → report" work.

### Artifacts and status updates

**One artifact per round, in both buffered and streaming modes.** The two
channels carry different things and are not redundant:

- **artifact** (`response`) — the durable round text, forwarded to the
  orchestrating model
- **status update** (`working`, non-final) — the state transition plus
  `metadata.backgroundTasks` from `snapshot()`, telling a client *why* the Task
  is still open

The forwarding rule documented in `packages/core/src/events/event-publisher.ts`
— only `response` and `final_answer` artifacts reach the model, `trace.*` are
evidence-only — is what decides this. Routing intermediate text solely through a
status update would place it in `Task.history` but keep it out of the
orchestrating model's context, dropping exactly the message the feature exists
to deliver. Spike 2 makes this concrete: result #2's text, *"Stage 1 finished
(exit 0). Stage 2 is now running"*, is the only place stage 1's outcome is ever
reported.

Buffered mode needs no change — `publishFinalArtifact` already mints
`response-${uuidv4()}` per call. Streaming mode changes from the fixed
`response-${taskId}` to `response-${taskId}-${round}`, each round closed with
its own `lastChunk` marker so the reconstruct-from-the-marker contract holds per
round.

An intermediate round whose result text is empty publishes the status update and
skips the artifact.

### Sideband events

Both bookends must fire once per A2A Task, not once per SDK round:

- `handleSystem` emits `agent_started` on every `init`, and the spikes show an
  `init` per wake. Suppress after the first.
- `handleResult` emits `agent_finished` on every success result. The executor
  already computes `finalText`/`resultError` before calling the mapper, so it
  can pass what it knows — `handleResult(msg, { held })` — suppressing while
  held and emitting once on the terminal result.

New `background_tasks` sideband event on membership change, behind
`features.emitBackgroundTaskEvents`, matching the existing flag convention. It
is the only way an orchestrator can see why a Task is sitting in `working`.

### Configuration

New `features.holdTaskForBackgroundWork`, default `true`. This changes
protocol-visible terminality for every existing client, so the escape hatch
matters even though on-by-default is the right call — the current behaviour is a
bug, not a contract. When off, the stream is closed at the first result and the
observable event sequence is identical to today's.

Streaming input is used either way; only the hold decision is gated.

## Error handling and edge cases

**Stream-closure discipline.** The parked generator leaks if forgotten.
Resolving the deferred belongs in the existing `finally` alongside
`clearTimeout` and `untrackExecution`, so every exit path — success,
`resultError`, rate limit, cancel, timeout, outer throw — closes it exactly
once. Nothing else resolves it directly.

**The loop can end while still holding.** If the CLI dies or the iterator
completes cleanly with a non-empty set, the post-loop block runs having never
published a terminal event. Today that block unconditionally publishes
`completed`; it becomes a fallback: if no terminal event was published, complete
with the last held text. Without this, a mid-hold process death hangs the Task
until the prompt timeout.

**The wedge case — the main new failure mode.** If the `background_tasks_changed`
that would empty the set never arrives, the Task sits in `working` until
`timeouts.prompt` fires, then `failed`. The spikes show comfortable ordering
margin in the normal case, and `session_state_changed` is unavailable as a
secondary settle signal (finding 3), so this risk is accepted for v1 and is the
first thing the deferred inactivity timer should address.

**Background work dies with the Task.** Process-per-Task means closing the
stream kills anything still running. On the happy path the set is empty, so
nothing is lost. On the timeout and cancel paths live background work *is*
killed, and the status message should say so rather than leaving the operator to
infer it.

**Rate limit mid-hold.** `endTurnRateLimited` applies unchanged, and its
rationale comment remains correct: an interrupted turn cannot be resumed, so
holding open would promise a continuation that cannot be delivered. One
mechanical fix — its close-out `publishLastChunkMarker` must target the current
round's artifact id now that the id varies per round.

**`maxTurns` now spans rounds.** A held-open Task accumulates SDK turns across
every round, so a chain that would previously have been three separate A2A Tasks
under three separate budgets is now one budget. A configuration that was
comfortable before may start hitting `error_max_turns` mid-chain. No code
change; it needs documenting.

**Cancellation during a hold** flows through the existing abort branch and stays
silent, since `cancelTask` already publishes `canceled`.

**Concurrent messages on the same `contextId`** queue behind the held-open Task
via the existing `executionQueue`, potentially for the full timeout. This is the
accepted status quo for v1 and must be documented as a known limitation.

## Testing

The strongest regression signal is the existing suite. Every current test in
`a2a-claude/src/claude/__tests__/` exercises the string-prompt path that becomes
a stream, so `executor.test.ts`, `executor-rate-limit.test.ts`,
`executor-subagents.test.ts` and friends passing unchanged is the main evidence
that the switch is behaviour-preserving.

`fake-client.ts` needs two changes: accept the widened prompt type, and drain a
streaming input in the background while exposing whether it was closed, so tests
can assert the closure discipline rather than trusting it.

New `executor-background-tasks.test.ts`, scripted from the spike traces:

| # | Case | Assertion |
|---|---|---|
| 1 | non-empty set at result | non-final `working` + artifact; no `completed`, no `finished` |
| 2 | empty set at next result | artifact + `completed` + `finished`, exactly once |
| 3 | three-round chain | 3 artifacts, 2 working updates, 1 completion |
| 4 | empty set at first result | event sequence identical to today |
| 5 | flag off | completes at result #1 despite a non-empty set |
| 6 | every exit path | input stream closed exactly once |
| 7 | iterator ends while held | fallback terminal event, no hang |
| 8 | 3 rounds, 3 `init`s | `agent_started` / `agent_finished` emitted once each |
| 9 | streaming mode | per-round artifact ids, each with its own `lastChunk` |
| 10 | `BackgroundTaskTracker` | replace semantics: `[a,b]` → `[b]` → `[]` |

Cases 3, 8 and 9 would have shipped broken without the spikes.

## Rollout

- Changeset, minor.
- `features.holdTaskForBackgroundWork` and `features.emitBackgroundTaskEvents`
  added to `config/types.ts` and `config/defaults.ts`.
- README coverage of the new lifecycle plus the three documented consequences:
  `maxTurns` now spans rounds, `timeouts.prompt` currently bounds the whole Task
  including idle gaps, and concurrent messages on a context queue behind a
  held-open Task.
- Promote both spike scripts into `scripts/background-tasks-smoke/`, alongside
  the existing `scripts/sub-agents-smoke/`. They are the only end-to-end proof
  that the wake actually fires.

## Out of scope

**Timeouts are explicitly deferred.** `timeouts.prompt` is left exactly as it
is. Two consequences follow and are accepted for v1:

- It is armed at turn start and never re-armed, so it now bounds the *entire*
  Task including the idle gaps between turns. The effective hold cap is its
  existing 10-minute default, not the 20 minutes originally sketched.
- On firing, `timedOut` is true, so the Task ends `failed`, not `completed`.

Operators enabling this feature will want to raise `timeouts.prompt`
accordingly. Setting it to `0` disables the bound entirely, which under this
design means a held-open Task can hang until the process dies; a
config-validation warning for that combination may be worth adding.

The intended replacement, once the approach is confirmed in production, is two
timers rather than one: a total budget for the whole A2A Task, which may
legitimately be hours, and a much shorter inactivity watchdog over meaningful
stream events. The spikes quantify why a single prompt timeout is the wrong
tool — the stream was silent for 38 seconds in spike 1 and roughly 18 seconds
twice in spike 2, with the Task perfectly healthy throughout. An inactivity
watchdog must tolerate gaps at least as long as the background work itself.

**Delivering background results after a Task has completed** — via A2A push
notification config — is not addressed here and is the natural follow-up if the
long-lived-query approach is ever revisited.
