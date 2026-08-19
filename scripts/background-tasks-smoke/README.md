# Background-task lifecycle smoke tests

Manual end-to-end checks that Claude's background-task wake actually fires in
headless SDK mode. Unit tests use scripted fakes; only these run the real CLI.

**These spend real quota** — roughly a minute of model time each — and need an
authenticated `claude` on PATH. They are deliberately not wired into `npm test`.

## Running

```bash
cd scripts/background-tasks-smoke
npm install @anthropic-ai/claude-agent-sdk@^0.3.235
node spike-single.mjs   # one background task: does a second result arrive at all
node spike-chain.mjs    # two-stage chain: does the hold loop across rounds
```

## What to look for

`spike-single.mjs` should show `background_tasks_changed` with one id, then
`RESULT #1`, then `background_tasks_changed []`, then `RESULT #2` — two results
on one query, with no second user message pushed. That is the whole premise of
the feature: the CLI wakes itself when background work settles.

`spike-chain.mjs` mirrors the executor's hold-vs-complete decision inline and
should end with `decisions=["HOLD","HOLD","COMPLETE"]`.

Both should show `session_state_changed` **never firing**. It is documented in
the SDK as the "authoritative turn-over signal", but it is not carried by the
stream-json transport, which is why the executor counts the background-task
level set instead. If it ever starts firing, revisit that decision.
