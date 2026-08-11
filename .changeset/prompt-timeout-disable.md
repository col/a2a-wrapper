---
"a2a-claude": minor
---

Allow `timeouts.prompt` to be disabled by setting it to `0` (or any value `<= 0`). Previously every turn was bounded at ten minutes by default with no way to opt out, which cut off legitimately long-running turns.

Negative values were also a footgun: `setTimeout` coerces a negative delay to the next tick, so `prompt: -1` — the intuitive spelling for "no timeout" — aborted the turn immediately instead of disabling the bound. The timer is now armed only for positive values, matching the "set to `0` to disable" convention already used for `healthCheck`.
