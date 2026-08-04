# Surfacing Claude thinking output over A2A

**Date:** 2026-08-04
**Branch:** `fix/thinking-events`
**Packages:** `@a2a-wrapper/core`, `a2a-claude`

## Problem

`a2a-claude` never publishes `trace.thinking` artifacts, so A2A consumers see no
agent reasoning at all.

## Root cause

A configuration defect, not a mapping defect.

`buildQueryOptions` (`a2a-claude/src/claude/client-factory.ts`) never sets the
SDK's `thinking` option. On current models the SDK default is
`display: "omitted"`, which returns thinking blocks whose `thinking` field is the
empty string. `EventMapper.handleAssistant`
(`a2a-claude/src/claude/event-mapper.ts:138`) guards on
`typeof block.thinking === "string" && block.thinking`, so every one of those
blocks is discarded silently.

Everything downstream of that guard is already correct and needs no change: the
`thinking` event maps to the `trace.thinking` artifact key
(`packages/core/src/events/transport.ts:215`) and reaches the A2A bus via
`A2ATransport`.

### Evidence

Measured against `@anthropic-ai/claude-agent-sdk@0.3.202` on subscription
(OAuth) auth, `apiKeySource=none`:

| Configuration | Model | Result |
|---|---|---|
| No `thinking` option (current behaviour) | `claude-opus-4-8[1m]` | 1 thinking block, `len=0`, signature present — dropped by the guard |
| `thinking: { type: "adaptive", display: "summarized" }` | `claude-opus-4-8[1m]` | `len=250`, real content |
| Same, plus `includePartialMessages: true` | `claude-opus-4-8[1m]` | 7 `thinking_delta` events totalling 339 chars, matching the complete block exactly |
| `thinking: { type: "adaptive", display: "summarized" }` | `claude-haiku-4-5-20251001` | No error on a model without adaptive thinking; `len=1646` of raw thinking |

Two further facts measured from the stream, both of which constrain the design:

1. **The SDK emits one assistant message per content block, not one per turn.**
   A thinking-only assistant message and a text-only assistant message arrive
   with the *same* `message.id`.
2. **The assistant message's content-array index does not match the stream
   `content_block` index.** The text-only message reported its block at array
   position `0` while that same block was stream `index=1`. Correlating streamed
   blocks to complete blocks by array position would mis-pair them.

The reason this was hard to find, and the reason an earlier fix attempt could
look plausible while changing nothing, is that the drop is completely silent —
no log, no warning, no counter.

## Design

### 1. `claude.thinking` configuration

Add a passthrough field to `ClaudeConfig` in `a2a-claude/src/config/types.ts`:

```ts
export type ClaudeThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };
```

The type is declared locally rather than imported from the SDK. `client-factory.ts`
is documented as "the single file that imports `@anthropic-ai/claude-agent-sdk`",
and that boundary is what lets the unit tests inject fakes; this change preserves it.

`buildQueryOptions` resolves the option in this order:

1. `claude.thinking` is set → pass through verbatim
2. otherwise `features.emitThinkingEvents` is true (the default) →
   `{ type: "adaptive", display: "summarized" }`
3. otherwise → leave unset, deferring to the SDK default

Step 2 is what fixes the reported bug out of the box. It is safe to apply
unconditionally: the Haiku 4.5 probe confirms a model without adaptive thinking
accepts it without error.

`QueryOptionsLike` gains a matching `thinking?: ClaudeThinkingConfig`.

### 2. Streaming support in `@a2a-wrapper/core`

`packages/core/src/events/transport.ts`, additive only:

- `AgentEvent` gains optional `stream?: { id: string; lastChunk: boolean }`
- `AgentEventEmitter.emit()` accepts an optional `stream` argument and copies it
  onto the event
- `A2ATransport.send()` — when `stream` is present, publish with
  `artifactId = \`${traceKey}-${stream.id}\``, `append: true`, and
  `lastChunk: stream.lastChunk`. When absent, behaviour is byte-for-byte what it
  is today: `append: false`, `lastChunk: true`, fresh UUID
- `HttpTransport` serialises the new field with the rest of the event

Because the field is optional and the absent path is unchanged, the other four
wrappers (`a2a-codex`, `a2a-copilot`, `a2a-opencode`, `a2a-antigravity`) are
unaffected.

This mirrors `publishStreamingChunk` / `publishLastChunkMarker`
(`packages/core/src/events/event-publisher.ts`), which is how response text
already streams in every wrapper.

### 3. Mapper changes in `a2a-claude`

`EventMapper` already receives every SDK message including `stream_event`
(`executor.ts:308`); the `stream_event` case at `event-mapper.ts:102` is
currently a bare `break`.

**Streaming path** — active only when `features.streamArtifactChunks` is true and
`parent_tool_use_id == null`. No change is needed to enable the underlying stream
events: `client-factory.ts:125` already sets `includePartialMessages` from
`features.streamArtifactChunks`.

- `message_start` → record `event.message.id` as the current message, clear
  per-message state. (`BetaRawMessageStartEvent.message` is a full `BetaMessage`,
  so the id is available.)
- `content_block_start` with `content_block.type === "thinking"` → open a stream
  block with `id = \`${messageId}-${index}\`` and push it onto a per-message FIFO
  of unmatched thinking blocks
- `thinking_delta` → emit a `thinking` event carrying the delta text, with
  `stream: { id, lastChunk: false }`
- `signature_delta` carries no text and is ignored

**Complete-block path** — `handleAssistant`, on a `thinking` block:

- Pop the next unmatched streamed thinking id for this `message.id` from the FIFO.
  If one exists, emit the complete block with `stream: { id, lastChunk: true }`.
- If the FIFO is empty, emit standalone exactly as today.

The FIFO is required because of measured fact 2 above: array position cannot be
used to correlate. It is keyed on `message.id`, which measured fact 1 confirms is
shared across the per-block assistant messages of one turn.

The complete block is **not** suppressed — it becomes the `lastChunk` marker
carrying the full text. This is deliberately identical to how response text
behaves, where `publishLastChunkMarker` re-sends the complete accumulated text so
that "consumers that missed earlier chunks can reconstruct the full artifact from
this single event" (`event-publisher.ts:247-253`). It also means the streaming
path degrades safely: a thinking block that arrives with no preceding deltas is
still published, rather than being lost.

### 4. Truncation

`MAX_THINKING_LENGTH = 10_000`, replacing the current hardcoded `2000`. The
existing `MAX_OUTPUT_LENGTH` in the same file is already `10_000`. The 2000-char
cap is too low to be useful: the Haiku probe produced 1646 characters of thinking
for a two-line arithmetic question.

The cap is a per-block budget applied to both paths. In the streaming path the
mapper stops emitting deltas once a block's accumulated emitted length reaches
the cap, and the `lastChunk` marker carries the same truncated text.

Streamed and buffered consumers therefore observe identical content **except
where redaction fires**. Because `redactSecrets` is applied per emitted chunk
(see §6), a secret spanning two deltas is redacted in the closing marker but not
in the deltas, so the two representations differ in both content and length. An
earlier draft of this spec claimed the two are always identical; that was wrong,
and it matters because the decision recorded below leans on the claim.

That is also why thinking is truncated with a bare `substring` rather than the
`\n... [truncated, N total chars]` marker `truncateOutput` appends for tool
output. Adding the marker to the buffered path alone widens the divergence above;
adding it to both means the delta stream ends with a synthetic chunk that was
never model output. Neither is clearly better than a silent cut at a cap that is
now 5× larger, so the bare `substring` stands — revisit only if operators
actually hit the cap in practice.

### 5. Diagnostics

When `features.emitThinkingEvents` is true and a thinking block arrives with an
empty `thinking` string, log a warning naming the likely cause
(`display: "omitted"`) and pointing at the `claude.thinking` option.

The warning fires at most once per `EventMapper` instance, which is once per task
execution. This is a real misconfiguration, so surfacing it on each affected task
is intended.

### 6. Known limitation: redaction across delta boundaries

`redactSecrets` is applied per emitted chunk. In the streaming path a secret
pattern split across two `thinking_delta` events will not match, and so will not
be redacted in the delta events. The `lastChunk` marker carries the complete
block text and *is* redacted as a whole, so a consumer reading only the final
marker sees correctly redacted content, but a consumer rendering deltas live may
briefly display an unredacted fragment.

This is accepted for now, on the grounds that it is the same trade-off the
existing response-text streaming path already makes. It is recorded here rather
than left implicit because it is a security-relevant property of enabling
`streamArtifactChunks`.

## Out of scope

**Subagent thinking.** It is currently blocked by two independent mechanisms:
`event-mapper.ts:94` skips any assistant message with `parent_tool_use_id != null`,
and the SDK's `forwardSubagentText` option is never set. Fixing it means a new
feature flag, a mapper path that tags events with the parent tool-use id, and
empirical verification that subagent forwarding behaves as documented — none of
which has been done. Deliberately deferred to keep this change reviewable.

**`redacted_thinking` blocks.** Not currently handled and not changed here; they
fall through the existing `block.type !== "tool_use"` guard and are ignored.

**The `effort` option.** The SDK exposes `effort` alongside `thinking`, but it is
unrelated to whether thinking is *reported* and is not needed for this fix.

## Testing

Unit tests, using the existing fake client — no live API calls.

`client-factory.test.ts`:
- **Regression test for this bug:** `buildQueryOptions` sets
  `thinking: { type: "adaptive", display: "summarized" }` when
  `features.emitThinkingEvents` is true and `claude.thinking` is unset
- an explicit `claude.thinking` is passed through verbatim and is not overridden
  by the default
- `thinking` is left unset when `emitThinkingEvents` is false

`event-mapper.test.ts`:
- an empty-string thinking block emits no event and logs exactly one warning per
  mapper instance
- a non-empty thinking block emits a `thinking` event with no `stream` field when
  `streamArtifactChunks` is false
- a `message_start` → `content_block_start` → N × `thinking_delta` →
  complete-block sequence emits N delta events with
  `stream.lastChunk === false` followed by one event with
  `stream.lastChunk === true` carrying the full text, all sharing one `stream.id`
- **FIFO correlation:** a thinking block at stream `index=0` and a text block at
  stream `index=1`, where the text-only assistant message reports its block at
  array position `0`, still pairs the thinking block correctly
- a thinking block with no preceding deltas emits standalone, with no `stream`
- content beyond `MAX_THINKING_LENGTH` is truncated identically in both paths

`packages/core` transport tests:
- an event with `stream` publishes with the derived stable `artifactId`,
  `append: true`, and the given `lastChunk`
- an event without `stream` publishes exactly as before

## Delivery

One branch, two commits:

1. `@a2a-wrapper/core` — additive transport streaming support plus its tests
2. `a2a-claude` — `claude.thinking` config, mapper changes, diagnostics, tests,
   `schemas/agent-config.schema.json`, README event/config tables, changeset

The core change ships together with the consumer that exercises it, rather than
merging an unused interface extension ahead of it.

Note that `a2a-claude/schemas/agent-config.schema.json` is hand-maintained —
`a2a-claude` has no `npm run schema` script — so it is updated by hand as part of
commit 2.
