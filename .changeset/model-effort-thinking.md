---
"a2a-claude": minor
---

Add `claude.effort` and `claude.thinking`, mapping onto the Claude Agent SDK's `Options.effort` and `Options.thinking`. `effort` accepts `low`/`medium`/`high`/`xhigh`/`max` and is also settable via the `CLAUDE_EFFORT` environment variable; `thinking` accepts `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens?, display? }`, or `{ type: "disabled" }`.

Both are additive and optional — `claude.model` remains a plain string and `claude.fallbackModel` is unchanged. Values are validated at `initialize()`, so an unsupported effort level or a malformed `thinking` object fails at startup with a message naming the allowed values rather than surfacing as an SDK error mid-task.
