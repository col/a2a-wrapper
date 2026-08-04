---
"@a2a-wrapper/core": minor
"a2a-claude": minor
---

Publish Claude's thinking output over A2A.

`buildQueryOptions` never set the SDK's `thinking` option, so on current models the SDK defaulted to `display: "omitted"` and returned thinking blocks with an empty string, which the event mapper then dropped silently — no `trace.thinking` artifact ever reached the bus. The wrapper now requests `{ "type": "adaptive", "display": "summarized" }` whenever `features.emitThinkingEvents` is on, and the new `claude.thinking` field passes the full SDK `ThinkingConfig` through for cost or latency tuning. An empty thinking block now logs a warning naming the cause instead of vanishing.

When `features.streamArtifactChunks` is on, thinking also streams incrementally. `@a2a-wrapper/core` gains an optional `stream` field on `AgentEvent`, which `A2ATransport` publishes with A2A append semantics — one stable `artifactId` per thinking block, closed by a final chunk carrying the complete text, matching how response text already streams. The field is optional and the unstreamed path is unchanged, so other wrappers are unaffected.

Thinking content is now truncated at 10,000 characters rather than 2,000, matching the existing tool-output cap.
