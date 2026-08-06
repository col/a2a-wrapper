---
"a2a-claude": minor
---

Add `claude.effort` and `claude.thinking`, mapping onto the Claude Agent SDK's `Options.effort` and `Options.thinking`. `effort` accepts `low`/`medium`/`high`/`xhigh`/`max` and is also settable via the `CLAUDE_EFFORT` environment variable; `thinking` accepts `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens?, display? }`, or `{ type: "disabled" }`.

Both are additive and optional — `claude.model` remains a plain string and `claude.fallbackModel` is unchanged. Values are validated at `initialize()`, so an unsupported effort level or a malformed `thinking` object fails at startup with a message naming the allowed values rather than surfacing as an SDK error mid-task.

Also fixes `features.emitThinkingEvents` producing no events at all. The SDK leaves `thinking.display` at `"omitted"`, so thinking blocks arrive with an empty string and the mapper's non-empty guard drops every one of them. When thinking events are enabled the wrapper now requests `display: "summarized"` — supplying a full `{ type: "adaptive", display: "summarized" }` when no thinking config is set, and filling in `display` on an explicit `adaptive`/`enabled` config that omits it. An explicit `display` (including `"omitted"`) and `{ type: "disabled" }` are both left untouched. Note that with thinking events on and no `claude.thinking` of your own, this turns adaptive thinking on and it costs thinking tokens.
