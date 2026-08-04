# Thinking Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `a2a-claude` publish agent thinking as `trace.thinking` artifacts over A2A, including incremental streaming when `features.streamArtifactChunks` is on.

**Architecture:** Ask the SDK for thinking content (`thinking: { type: "adaptive", display: "summarized" }`), which it does not do today; extend `@a2a-wrapper/core`'s event transport with optional append semantics; and teach `EventMapper` to stream `thinking_delta` events and close each block with the complete text as the `lastChunk` marker — the same shape response text already uses.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, `@anthropic-ai/claude-agent-sdk@0.3.202`, `@a2a-js/sdk`.

**Spec:** `docs/superpowers/specs/2026-08-04-thinking-events-design.md`

---

## Background the engineer needs

**The bug.** `buildQueryOptions` never sets the SDK `thinking` option. Current models then default to `display: "omitted"`, which returns thinking blocks whose `thinking` field is `""`. `EventMapper.handleAssistant` guards on `... && block.thinking`, so those blocks are dropped with no log. Nothing downstream is broken.

**Two measured SDK behaviours the design depends on.** Both were confirmed against the live SDK; do not "simplify" past them:

1. The SDK emits **one assistant message per content block**, not one per turn. A thinking-only assistant message and a text-only assistant message arrive with the **same** `message.id`.
2. The assistant message's **content-array index does not match the stream `content_block` index**. A text block observed at stream `index=1` was reported at array position `0` of its assistant message. **Never correlate streamed blocks to complete blocks by array position.** Correlation is done with a FIFO queue keyed on `message.id`.

**Build order.** `a2a-claude` imports `@a2a-wrapper/core` from its built `dist/`, not from source. After changing core you **must** run `npm run build` in `packages/core` or `a2a-claude`'s typecheck and tests will use stale types.

**Node.** `node`/`npm` live in `~/.local/bin`, which is not on the default PATH. Prefix commands with `export PATH="$HOME/.local/bin:$PATH"` if `node -v` fails.

---

## File Structure

**`packages/core/src/events/transport.ts`** (modify) — owns the `AgentEvent` shape and the A2A/HTTP transports. Gains an optional `stream` field and the append-mode publish path. Additive only: when `stream` is absent, every byte of the published artifact is what it is today, so the other four wrappers are untouched.

**`packages/core/src/index.ts`** (modify) — re-export the new `AgentEventStream` type.

**`packages/core/src/__tests__/events/transport.test.ts`** (create) — first test file for the transport module; covers both the streaming and non-streaming publish paths.

**`a2a-claude/src/config/types.ts`** (modify) — declares `ClaudeThinkingConfig` locally and adds `claude.thinking`. Declared locally on purpose: `client-factory.ts` is the only file allowed to import the SDK, and that boundary is what lets tests inject fakes.

**`a2a-claude/src/claude/client-factory.ts`** (modify) — resolves and passes the `thinking` option. This is the root-cause fix.

**`a2a-claude/src/claude/event-mapper.ts`** (modify) — gains the streaming-thinking path, the FIFO correlation state, the raised truncation cap, and the empty-block warning.

**Tests** — extend `a2a-claude/src/claude/__tests__/client-factory.test.ts` and `event-mapper.test.ts` in place.

**Docs** — `a2a-claude/README.md`, `a2a-claude/schemas/agent-config.schema.json` (hand-maintained; there is no `npm run schema` in `a2a-claude`), and a new changeset.

---

## Task 1: Core transport append semantics

**Files:**
- Modify: `packages/core/src/events/transport.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/events/transport.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/events/transport.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { A2ATransport, AgentEventEmitter } from "../../events/transport.js";
import type { AgentEvent } from "../../events/transport.js";

function createMockBus() {
  const events: any[] = [];
  return { publish(event: any) { events.push(event); }, events };
}

const baseEvent: AgentEvent = {
  eventId: "evt-1",
  eventType: "thinking",
  agentId: "agent-1",
  agentName: "Agent One",
  traceId: "trace-1",
  parentAgentId: null,
  timestamp: "2026-08-04T00:00:00.000Z",
  data: { content: "hello" },
};

describe("A2ATransport", () => {
  it("publishes a standalone buffered artifact when no stream is set", async () => {
    const bus = createMockBus();
    await new A2ATransport(bus as any, "task-1", "ctx-1").send(baseEvent);

    expect(bus.events).toHaveLength(1);
    const published = bus.events[0];
    expect(published.append).toBe(false);
    expect(published.lastChunk).toBe(true);
    expect(published.artifact.name).toBe("trace.thinking");
    expect(published.artifact.artifactId).toMatch(/^trace\.thinking-/);
    expect(published.artifact.parts[0].data).toMatchObject({
      agent_id: "agent-1",
      agent_name: "Agent One",
      trace_id: "trace-1",
      content: "hello",
    });
  });

  it("publishes append-mode chunks sharing one stable artifactId when stream is set", async () => {
    const bus = createMockBus();
    const transport = new A2ATransport(bus as any, "task-1", "ctx-1");

    await transport.send({ ...baseEvent, stream: { id: "msg_1-0", lastChunk: false } });
    await transport.send({ ...baseEvent, stream: { id: "msg_1-0", lastChunk: true } });

    expect(bus.events.map((e) => [e.append, e.lastChunk])).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(bus.events[0].artifact.artifactId).toBe("trace.thinking-msg_1-0");
    expect(bus.events[1].artifact.artifactId).toBe("trace.thinking-msg_1-0");
  });

  it("drops event types with no trace key mapping", async () => {
    const bus = createMockBus();
    await new A2ATransport(bus as any, "t", "c").send({ ...baseEvent, eventType: "context_window" });
    expect(bus.events).toHaveLength(0);
  });
});

describe("AgentEventEmitter", () => {
  it("forwards the stream argument onto the event", async () => {
    const sent: AgentEvent[] = [];
    const emitter = new AgentEventEmitter({
      agentId: "a", agentName: "A", traceId: "t",
      transport: { async send(e: AgentEvent) { sent.push(e); } },
    });

    await emitter.emit("thinking", { content: "x" }, { id: "s1", lastChunk: true });
    await emitter.emit("thinking", { content: "y" });

    expect(sent[0].stream).toEqual({ id: "s1", lastChunk: true });
    expect(sent[1].stream).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/core && npx vitest --run src/__tests__/events/transport.test.ts
```

Expected: FAIL — TypeScript rejects the `stream` property on `AgentEvent`, and `emit()` takes only two arguments.

- [ ] **Step 3: Add the `AgentEventStream` type and `stream` field**

In `packages/core/src/events/transport.ts`, immediately **above** the `AgentEvent` interface, add:

```typescript
/**
 * Marks an event as one chunk of a larger logical artifact.
 *
 * Transports that support append semantics (see {@link A2ATransport}) use `id`
 * to keep every chunk on one artifact and `lastChunk` to close it. Mirrors the
 * `publishStreamingChunk` / `publishLastChunkMarker` pair used for response text.
 */
export interface AgentEventStream {
  /** Stable identifier shared by every chunk of one logical artifact. */
  id: string;
  /** True on the final chunk, which closes the artifact. */
  lastChunk: boolean;
}
```

Then add this field to the `AgentEvent` interface, after `data`:

```typescript
  /** Present when this event is one chunk of a streamed artifact. */
  stream?: AgentEventStream;
```

- [ ] **Step 4: Use append semantics in `A2ATransport.send`**

In `A2ATransport.send`, replace the `artifactEvent` construction (currently `append: false` / `lastChunk: true` / `artifactId: \`${traceKey}-${uuidv4()}\``) with:

```typescript
    // A streamed event appends to one stable artifact; an unstreamed event is a
    // self-contained artifact, exactly as before.
    const stream = event.stream;
    const artifactEvent: TaskArtifactUpdateEvent = {
      kind: "artifact-update",
      taskId: this.taskId,
      contextId: this.contextId,
      append: stream !== undefined,
      lastChunk: stream ? stream.lastChunk : true,
      artifact: {
        artifactId: stream ? `${traceKey}-${stream.id}` : `${traceKey}-${uuidv4()}`,
        name: traceKey,
        extensions: [TRACE_EXTENSION_URI],
        metadata: {
          traceType: traceKey,
          timestamp: event.timestamp,
        },
        parts: [
          {
            kind: "data",
            data,
            metadata: { mimeType: "application/json" },
          } as any,
        ],
      },
    };
    this.bus.publish(artifactEvent);
```

- [ ] **Step 5: Accept `stream` in `AgentEventEmitter.emit`**

Replace the `emit` method body's signature and event construction:

```typescript
  async emit(
    eventType: EventType,
    data: Record<string, unknown> = {},
    stream?: AgentEventStream,
  ): Promise<void> {
    const event: AgentEvent = {
      eventId: uuidv4(),
      eventType,
      agentId: this.agentId,
      agentName: this.agentName,
      traceId: this.traceId,
      parentAgentId: this.parentAgentId,
      timestamp: new Date().toISOString(),
      data,
      ...(stream ? { stream } : {}),
    };
    try {
      await this.transport.send(event);
    } catch (e) {
      console.warn(`[emitter] Failed to emit ${eventType}: ${(e as Error).message}`);
    }
  }
```

Also update the JSDoc above `emit` by adding this line after the `@param data` line:

```
   * @param stream    - Set when this event is one chunk of a streamed artifact.
```

- [ ] **Step 6: Export the new type**

In `packages/core/src/index.ts`, add `AgentEventStream` to the existing `export type { ... } from "./events/transport.js";` block so it reads:

```typescript
export type {
  EventTransport,
  EventTransportFn,
  AgentEvent,
  AgentEventStream,
  EventType,
} from "./events/transport.js";
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd packages/core && npx vitest --run src/__tests__/events/transport.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 8: Run the full core suite and typecheck for regressions**

```bash
cd packages/core && npm test && npm run typecheck
```

Expected: all pass. The `stream` field is optional, so existing callers are unaffected.

- [ ] **Step 9: Rebuild core so `a2a-claude` sees the new types**

```bash
cd packages/core && npm run build
```

Expected: exits 0. Skipping this makes every later task fail with "Object literal may only specify known properties".

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/events/transport.ts packages/core/src/index.ts packages/core/src/__tests__/events/transport.test.ts
git commit -m "feat(core): optional append semantics for streamed trace artifacts"
```

---

## Task 2: Request thinking content from the SDK

This is the root-cause fix. Do it before the mapper work — it is independently shippable and is what actually makes thinking appear.

**Files:**
- Modify: `a2a-claude/src/config/types.ts`
- Modify: `a2a-claude/src/claude/client-factory.ts`
- Test: `a2a-claude/src/claude/__tests__/client-factory.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these three tests inside the existing `describe("buildQueryOptions", ...)` block in `a2a-claude/src/claude/__tests__/client-factory.test.ts`, just before its closing `});`:

```typescript
  it("requests summarized adaptive thinking by default", () => {
    // Regression guard: without an explicit display the SDK defaults to
    // "omitted" on current models and returns empty thinking blocks, so the
    // sideband thinking events have nothing to publish.
    const opts = buildQueryOptions(cfg(), {});
    expect(opts.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("passes an explicit claude.thinking through unchanged", () => {
    const opts = buildQueryOptions(cfg({ thinking: { type: "enabled", budgetTokens: 4096 } }), {});
    expect(opts.thinking).toEqual({ type: "enabled", budgetTokens: 4096 });
  });

  it("omits thinking when emitThinkingEvents is off", () => {
    const c = cfg();
    c.features = { ...c.features, emitThinkingEvents: false };
    expect(buildQueryOptions(c, {}).thinking).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/client-factory.test.ts
```

Expected: FAIL — `thinking` does not exist on the config type or on the returned options.

- [ ] **Step 3: Add the config type**

In `a2a-claude/src/config/types.ts`, add this **above** the `ClaudeConfig` interface (just after the `ClaudeMarketplaceConfig` interface):

```typescript
/**
 * Controls Claude's thinking/reasoning behaviour. Mirrors the Claude Agent SDK's
 * `ThinkingConfig`, declared locally so that the SDK import stays confined to
 * `claude/client-factory.ts`.
 *
 * `display` matters: the SDK default on current models is `"omitted"`, which
 * returns thinking blocks with an empty `thinking` string.
 */
export type ClaudeThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };
```

Then add this field to `ClaudeConfig`, immediately after the `fallbackModel` field:

```typescript
  /**
   * Thinking/reasoning behaviour. When omitted and `features.emitThinkingEvents`
   * is on, defaults to `{ type: "adaptive", display: "summarized" }` so that
   * thinking blocks actually carry content.
   */
  thinking?: ClaudeThinkingConfig;
```

- [ ] **Step 4: Pass the option through in `buildQueryOptions`**

In `a2a-claude/src/claude/client-factory.ts`, extend the type import on line 11:

```typescript
import type { AgentConfig, ClaudeThinkingConfig } from "../config/types.js";
```

Add this field to `QueryOptionsLike`, after `includePartialMessages?: boolean;`:

```typescript
  thinking?: ClaudeThinkingConfig;
```

Inside `buildQueryOptions`, add this after the `mcpServers` line (`const mcpServers = buildMcpServers(...)`):

```typescript
  // The SDK defaults to display "omitted" on current models, which yields
  // thinking blocks with an empty string — nothing for the sideband thinking
  // events to publish. Ask for summaries whenever those events are enabled.
  const thinking: ClaudeThinkingConfig | undefined =
    claude.thinking ??
    (config.features.emitThinkingEvents
      ? { type: "adaptive", display: "summarized" }
      : undefined);
```

Then add `thinking,` to the returned `opts` object, immediately after the `includePartialMessages:` line.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/client-factory.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit**

```bash
git add a2a-claude/src/config/types.ts a2a-claude/src/claude/client-factory.ts a2a-claude/src/claude/__tests__/client-factory.test.ts
git commit -m "fix(a2a-claude): request summarized thinking so thinking blocks carry content"
```

---

## Task 3: Raise the thinking truncation cap and warn on empty blocks

**Files:**
- Modify: `a2a-claude/src/claude/event-mapper.ts`
- Test: `a2a-claude/src/claude/__tests__/event-mapper.test.ts`

- [ ] **Step 1: Write the failing tests**

In `a2a-claude/src/claude/__tests__/event-mapper.test.ts`, first add `vi` to the vitest import on line 1:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
```

Replace the existing test `"redacts and truncates thinking content"` (currently asserting `toBeLessThanOrEqual(2000)`) with:

```typescript
  it("redacts and truncates thinking content at the 10k cap", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "thinking", thinking: "the file has api_key=sk-live-9 in it " + "x".repeat(20_000) },
    ]));
    const content = emitted[0].data.content as string;
    expect(content).not.toContain("sk-live-9");
    expect(content.length).toBe(10_000);
  });

  it("drops an empty thinking block and warns exactly once per mapper", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { mapper, emitted } = makeMapper();
      mapper.handleMessage(assistantMsg([{ type: "thinking", thinking: "", signature: "Ev1" }]));
      mapper.handleMessage(assistantMsg([{ type: "thinking", thinking: "", signature: "Ev2" }]));

      expect(emitted).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("omitted");
    } finally {
      warn.mockRestore();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/event-mapper.test.ts
```

Expected: FAIL — content is truncated to 2000, and no warning is logged.

- [ ] **Step 3: Add the cap constant**

In `a2a-claude/src/claude/event-mapper.ts`, add below the existing `MAX_COMMAND_LENGTH` constant:

```typescript
const MAX_THINKING_LENGTH = 10_000;
```

- [ ] **Step 4: Add the warn-once flag**

Add this private field to the `EventMapper` class, directly after `private readonly config: Required<AgentConfig>;`:

```typescript
  /** Warn once per execution about empty thinking blocks; more would be noise. */
  private warnedEmptyThinking = false;
```

- [ ] **Step 5: Replace the thinking branch with a dedicated handler**

In `handleAssistant`, replace the whole `if (block.type === "thinking") { ... continue; }` block with:

```typescript
      if (block.type === "thinking") {
        if (features.emitThinkingEvents) this.handleThinkingBlock(block);
        continue;
      }
```

Then add this private method to the class, immediately after `handleAssistant`:

```typescript
  /**
   * Publish one complete thinking block.
   *
   * An empty `thinking` string means the SDK returned the block with
   * `display: "omitted"` — the default on current models. That is a config
   * problem, not a model problem, so say so rather than dropping it silently.
   */
  private handleThinkingBlock(block: Record<string, unknown>): void {
    const raw = typeof block.thinking === "string" ? block.thinking : "";

    if (!raw) {
      if (!this.warnedEmptyThinking) {
        this.warnedEmptyThinking = true;
        log.warn(
          "Received a thinking block with no content. The SDK returns empty thinking " +
          'when thinking.display is "omitted", which is the default on current models. ' +
          'Set claude.thinking to { "type": "adaptive", "display": "summarized" } to receive content.',
        );
      }
      return;
    }

    this.emitter.emit("thinking", {
      content: redactSecrets(raw).substring(0, MAX_THINKING_LENGTH),
    });
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/event-mapper.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 7: Commit**

```bash
git add a2a-claude/src/claude/event-mapper.ts a2a-claude/src/claude/__tests__/event-mapper.test.ts
git commit -m "fix(a2a-claude): raise thinking cap to 10k and warn on empty thinking blocks"
```

---

## Task 4: Stream thinking deltas with FIFO correlation

**Files:**
- Modify: `a2a-claude/src/claude/event-mapper.ts`
- Test: `a2a-claude/src/claude/__tests__/event-mapper.test.ts`

- [ ] **Step 1: Update the test emitter mock to capture the stream argument**

In `a2a-claude/src/claude/__tests__/event-mapper.test.ts`, change the `Emitted` type and `makeMapper` mock:

```typescript
type Emitted = { event: string; data: Record<string, unknown>; stream?: { id: string; lastChunk: boolean } };

function makeMapper(features: Partial<FeatureFlags> = {}) {
  const emitted: Emitted[] = [];
  const emitter = {
    emit: (event: string, data: Record<string, unknown>, stream?: { id: string; lastChunk: boolean }) => {
      emitted.push(stream ? { event, data, stream } : { event, data });
    },
  } as unknown as AgentEventEmitter;
  const config = { ...DEFAULTS, features: { ...DEFAULTS.features, ...features } } as Required<AgentConfig>;
  return { mapper: new EventMapper(emitter, config), emitted };
}
```

The `stream` key is only added when defined, so every existing `toEqual([{ event, data }])` assertion still holds.

- [ ] **Step 2: Write the failing tests**

Add these tests inside the `describe("EventMapper", ...)` block, before its closing `});`. Note the helper defined first:

```typescript
  const streamEvent = (event: Record<string, unknown>) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    event,
  });

  const thinkingAssistantMsg = (id: string, thinking: string) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, content: [{ type: "thinking", thinking }] },
  });

  it("streams thinking deltas and closes the block with the complete text", () => {
    const { mapper, emitted } = makeMapper({ streamArtifactChunks: true });
    mapper.handleMessage(streamEvent({ type: "message_start", message: { id: "msg_1" } }));
    mapper.handleMessage(streamEvent({
      type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" },
    }));
    mapper.handleMessage(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } }));
    mapper.handleMessage(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "check." } }));
    mapper.handleMessage(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "Ev1" } }));
    mapper.handleMessage(thinkingAssistantMsg("msg_1", "Let me check."));

    expect(emitted).toEqual([
      { event: "thinking", data: { content: "Let me " }, stream: { id: "msg_1-0", lastChunk: false } },
      { event: "thinking", data: { content: "check." }, stream: { id: "msg_1-0", lastChunk: false } },
      { event: "thinking", data: { content: "Let me check." }, stream: { id: "msg_1-0", lastChunk: true } },
    ]);
  });

  it("correlates by message id, not by assistant content-array position", () => {
    // Observed SDK behaviour: thinking is stream index 0 and text is stream
    // index 1, but the text-only assistant message reports its block at array
    // position 0 and shares the thinking message's id. Correlating on array
    // position would mis-pair them.
    const { mapper, emitted } = makeMapper({ streamArtifactChunks: true });
    mapper.handleMessage(streamEvent({ type: "message_start", message: { id: "msg_2" } }));
    mapper.handleMessage(streamEvent({
      type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" },
    }));
    mapper.handleMessage(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }));
    mapper.handleMessage(thinkingAssistantMsg("msg_2", "reasoning"));
    mapper.handleMessage(streamEvent({ type: "content_block_stop", index: 0 }));
    mapper.handleMessage(streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
    mapper.handleMessage(streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }));
    mapper.handleMessage({
      type: "assistant", parent_tool_use_id: null,
      message: { id: "msg_2", content: [{ type: "text", text: "answer" }] },
    });

    expect(emitted).toEqual([
      { event: "thinking", data: { content: "reasoning" }, stream: { id: "msg_2-0", lastChunk: false } },
      { event: "thinking", data: { content: "reasoning" }, stream: { id: "msg_2-0", lastChunk: true } },
    ]);
  });

  it("emits a standalone thinking event when no deltas preceded the block", () => {
    const { mapper, emitted } = makeMapper({ streamArtifactChunks: true });
    mapper.handleMessage(thinkingAssistantMsg("msg_3", "no deltas here"));
    expect(emitted).toEqual([{ event: "thinking", data: { content: "no deltas here" } }]);
  });

  it("ignores thinking deltas when streaming is off", () => {
    const { mapper, emitted } = makeMapper({ streamArtifactChunks: false });
    mapper.handleMessage(streamEvent({ type: "message_start", message: { id: "msg_4" } }));
    mapper.handleMessage(streamEvent({
      type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" },
    }));
    mapper.handleMessage(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hidden" } }));
    mapper.handleMessage(thinkingAssistantMsg("msg_4", "hidden"));
    expect(emitted).toEqual([{ event: "thinking", data: { content: "hidden" } }]);
  });

  it("ignores subagent stream events", () => {
    const { mapper, emitted } = makeMapper({ streamArtifactChunks: true });
    mapper.handleMessage({
      type: "stream_event", parent_tool_use_id: "tu1",
      event: { type: "message_start", message: { id: "msg_5" } },
    });
    mapper.handleMessage({
      type: "stream_event", parent_tool_use_id: "tu1",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "sub" } },
    });
    expect(emitted).toEqual([]);
  });

  it("caps streamed thinking at the 10k budget", () => {
    const { mapper, emitted } = makeMapper({ streamArtifactChunks: true });
    mapper.handleMessage(streamEvent({ type: "message_start", message: { id: "msg_6" } }));
    mapper.handleMessage(streamEvent({
      type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" },
    }));
    for (let i = 0; i < 4; i++) {
      mapper.handleMessage(streamEvent({
        type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "z".repeat(4000) },
      }));
    }
    const streamedChars = emitted.reduce((n, e) => n + (e.data.content as string).length, 0);
    expect(streamedChars).toBe(10_000);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/event-mapper.test.ts
```

Expected: FAIL — stream events are ignored, so no delta events are emitted and the complete block carries no `stream`.

- [ ] **Step 4: Add the correlation state**

In `a2a-claude/src/claude/event-mapper.ts`, add these private fields to `EventMapper`, directly after the `warnedEmptyThinking` field from Task 3:

```typescript
  /**
   * Stream ids of thinking blocks whose deltas have been seen, queued per SDK
   * message id. A FIFO — not an index lookup — because the SDK's assistant
   * content-array position does not match the stream content_block index.
   */
  private readonly pendingThinkingStreams = new Map<string, string[]>();
  /** Characters already emitted per thinking stream id, for the truncation budget. */
  private readonly thinkingStreamLength = new Map<string, number>();
  /** Message id of the in-flight streamed message, from the last message_start. */
  private currentStreamMessageId: string | null = null;
```

- [ ] **Step 5: Route stream events to a handler**

In `handleMessage`, replace the `stream_event` case:

```typescript
        case "stream_event":
          this.handleStreamEvent(msg);
          break;
```

The executor still consumes `stream_event` separately for response-text artifact deltas; this only adds the thinking path.

- [ ] **Step 6: Implement the stream handler**

Add this private method to the class, immediately after `handleThinkingBlock`:

```typescript
  /**
   * Emit incremental thinking from raw stream events.
   *
   * Only runs when artifact streaming is on, because `includePartialMessages`
   * is itself derived from that flag. Each thinking block is registered on a
   * per-message FIFO at `content_block_start` and consumed by the matching
   * complete block in `handleAssistant`.
   */
  private handleStreamEvent(msg: SDKMessageLike): void {
    const features = this.config.features;
    if (!features.emitThinkingEvents) return;
    if (features.streamArtifactChunks !== true) return;
    if (msg.parent_tool_use_id != null) return;

    const event = msg.event as Record<string, unknown> | undefined;
    if (!event) return;

    if (event.type === "message_start") {
      const message = event.message as Record<string, unknown> | undefined;
      this.currentStreamMessageId = typeof message?.id === "string" ? message.id : null;
      return;
    }

    const messageId = this.currentStreamMessageId;
    if (!messageId) return;
    const streamId = `${messageId}-${String(event.index ?? 0)}`;

    if (event.type === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type !== "thinking") return;
      const queue = this.pendingThinkingStreams.get(messageId) ?? [];
      queue.push(streamId);
      this.pendingThinkingStreams.set(messageId, queue);
      this.thinkingStreamLength.set(streamId, 0);
      return;
    }

    if (event.type !== "content_block_delta") return;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type !== "thinking_delta" || typeof delta.thinking !== "string") return;

    // Unknown stream id means this block never opened as a thinking block.
    const used = this.thinkingStreamLength.get(streamId);
    if (used === undefined || used >= MAX_THINKING_LENGTH) return;

    const text = redactSecrets(delta.thinking).substring(0, MAX_THINKING_LENGTH - used);
    if (!text) return;
    this.thinkingStreamLength.set(streamId, used + text.length);
    this.emitter.emit("thinking", { content: text }, { id: streamId, lastChunk: false });
  }

  /** Pop the next unmatched streamed thinking block for this message, if any. */
  private takePendingThinkingStream(messageId: string): string | null {
    const queue = this.pendingThinkingStreams.get(messageId);
    if (!queue || queue.length === 0) return null;
    const streamId = queue.shift() as string;
    if (queue.length === 0) this.pendingThinkingStreams.delete(messageId);
    return streamId;
  }
```

- [ ] **Step 7: Close the stream from the complete block**

`handleThinkingBlock` needs the message id, so change its call site in `handleAssistant` to pass the message:

```typescript
      if (block.type === "thinking") {
        if (features.emitThinkingEvents) this.handleThinkingBlock(msg, block);
        continue;
      }
```

Then replace `handleThinkingBlock`'s signature and its emit call. The signature becomes:

```typescript
  private handleThinkingBlock(msg: SDKMessageLike, block: Record<string, unknown>): void {
```

and the final `this.emitter.emit(...)` at the end of the method becomes:

```typescript
    const content = redactSecrets(raw).substring(0, MAX_THINKING_LENGTH);
    const inner = msg.message as Record<string, unknown> | undefined;
    const messageId = typeof inner?.id === "string" ? inner.id : null;
    const streamId = messageId ? this.takePendingThinkingStream(messageId) : null;

    // Mirrors publishLastChunkMarker for response text: the complete block is
    // re-sent as the closing chunk so a consumer that missed deltas still gets
    // the whole thought. With no deltas, it is a standalone artifact as before.
    if (streamId) {
      this.thinkingStreamLength.delete(streamId);
      this.emitter.emit("thinking", { content }, { id: streamId, lastChunk: true });
      return;
    }
    this.emitter.emit("thinking", { content });
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd a2a-claude && npx vitest --run src/claude/__tests__/event-mapper.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 9: Run the full a2a-claude suite and typecheck**

```bash
cd a2a-claude && npm test && npm run typecheck
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add a2a-claude/src/claude/event-mapper.ts a2a-claude/src/claude/__tests__/event-mapper.test.ts
git commit -m "feat(a2a-claude): stream thinking deltas as append-mode trace artifacts"
```

---

## Task 5: Documentation, schema, and changeset

**Files:**
- Modify: `a2a-claude/schemas/agent-config.schema.json`
- Modify: `a2a-claude/README.md`
- Create: `.changeset/thinking-events.md`

- [ ] **Step 1: Add `thinking` to the JSON schema**

In `a2a-claude/schemas/agent-config.schema.json`, inside the `claude` block's `properties`, add this immediately after the `"fallbackModel": { "type": "string" },` line:

```json
            "thinking": {
              "description": "Thinking/reasoning behaviour. Defaults to { \"type\": \"adaptive\", \"display\": \"summarized\" } when features.emitThinkingEvents is on; without an explicit display the SDK returns empty thinking blocks on current models.",
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "type": { "const": "adaptive" },
                    "display": { "enum": ["summarized", "omitted"] }
                  },
                  "required": ["type"]
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "type": { "const": "enabled" },
                    "budgetTokens": { "type": "integer", "minimum": 1 },
                    "display": { "enum": ["summarized", "omitted"] }
                  },
                  "required": ["type"]
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": { "type": { "const": "disabled" } },
                  "required": ["type"]
                }
              ]
            },
```

- [ ] **Step 2: Verify the schema is still valid JSON**

```bash
cd a2a-claude && node -e "JSON.parse(require('fs').readFileSync('schemas/agent-config.schema.json','utf8')); console.log('valid json')"
```

Expected: `valid json`.

- [ ] **Step 3: Document the config field**

In `a2a-claude/README.md`, in the `### claude block fields` table, add this row immediately after the `fallbackModel` row:

```markdown
| `thinking` | `{ type: "adaptive" \| "enabled" \| "disabled", display?: "summarized" \| "omitted", budgetTokens?: number }` | Thinking/reasoning behaviour, passed through to the SDK. Defaults to `{ "type": "adaptive", "display": "summarized" }` when `features.emitThinkingEvents` is on — without an explicit `display` the SDK returns **empty** thinking blocks on current models and no thinking is published. |
```

- [ ] **Step 4: Update the sideband events table**

In the same file, replace the `thinking` row of the **Sideband Events** table with:

```markdown
| `thinking` | Assistant `thinking` content block | Controlled by `features.emitThinkingEvents`; requires `claude.thinking` to request a non-omitted `display` (the default does this). Truncated at 10,000 characters. When `features.streamArtifactChunks` is on, also streams incrementally from `thinking_delta` events: each block becomes one appended `trace.thinking` artifact, closed by a final chunk carrying the complete text. |
```

- [ ] **Step 5: Note the streaming redaction caveat**

In the same file, directly beneath the Sideband Events table, add this paragraph:

```markdown
> **Note on streamed thinking.** Secret redaction is applied per emitted chunk. With `features.streamArtifactChunks` on, a secret split across two `thinking_delta` events is not matched by the redaction patterns, so a consumer rendering deltas live may briefly show an unredacted fragment. The closing chunk carries the complete block and is redacted as a whole.
```

- [ ] **Step 6: Write the changeset**

Create `.changeset/thinking-events.md`:

```markdown
---
"@a2a-wrapper/core": minor
"a2a-claude": minor
---

Publish Claude's thinking output over A2A.

`buildQueryOptions` never set the SDK's `thinking` option, so on current models the SDK defaulted to `display: "omitted"` and returned thinking blocks with an empty string, which the event mapper then dropped silently — no `trace.thinking` artifact ever reached the bus. The wrapper now requests `{ "type": "adaptive", "display": "summarized" }` whenever `features.emitThinkingEvents` is on, and the new `claude.thinking` field passes the full SDK `ThinkingConfig` through for cost or latency tuning. An empty thinking block now logs a warning naming the cause instead of vanishing.

When `features.streamArtifactChunks` is on, thinking also streams incrementally. `@a2a-wrapper/core` gains an optional `stream` field on `AgentEvent`, which `A2ATransport` publishes with A2A append semantics — one stable `artifactId` per thinking block, closed by a final chunk carrying the complete text, matching how response text already streams. The field is optional and the unstreamed path is unchanged, so other wrappers are unaffected.

Thinking content is now truncated at 10,000 characters rather than 2,000, matching the existing tool-output cap.
```

- [ ] **Step 7: Run the full monorepo test suite**

```bash
cd /Users/col/projects/throng_platform/a2a-wrapper && npm test
```

Expected: all packages pass.

- [ ] **Step 8: Commit**

```bash
git add a2a-claude/schemas/agent-config.schema.json a2a-claude/README.md .changeset/thinking-events.md
git commit -m "docs(a2a-claude): document claude.thinking and streamed thinking events"
```

---

## Task 6: Verify against the live SDK

Unit tests use fakes, so they cannot prove the SDK actually returns content. This is the check that the original bug report is fixed.

**Files:**
- Create: scratchpad only — nothing in the repo

- [ ] **Step 1: Write the verification probe**

Create `verify-thinking.mjs` in the **repo root** (so Node resolves `node_modules`; it is deleted in Step 4 and must never be committed):

```javascript
import { buildQueryOptions } from "./a2a-claude/dist/claude/client-factory.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const config = {
  claude: { workingDirectory: process.cwd(), permissionMode: "plan", settingSources: [], maxTurns: 1 },
  features: { emitThinkingEvents: true, streamArtifactChunks: false },
  mcp: {},
};

const options = buildQueryOptions(config, {});
console.log("resolved thinking option:", JSON.stringify(options.thinking));

options.disallowedTools = ["Write", "Edit", "NotebookEdit", "Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task"];

let chars = 0;
for await (const msg of query({ prompt: "Think carefully, then answer in one line: what is 17 * 23 + 4?", options })) {
  if (msg.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "thinking") chars += (block.thinking ?? "").length;
    }
  }
}
console.log(chars > 0 ? `PASS — received ${chars} chars of thinking` : "FAIL — thinking still empty");
```

- [ ] **Step 2: Build a2a-claude so the probe can import the compiled factory**

```bash
cd a2a-claude && npm run build
```

Expected: exits 0.

- [ ] **Step 3: Run the probe**

```bash
cd /Users/col/projects/throng_platform/a2a-wrapper && node verify-thinking.mjs
```

Expected output:

```
resolved thinking option: {"type":"adaptive","display":"summarized"}
PASS — received <N> chars of thinking
```

This costs one short model call. If it prints `FAIL`, stop and report — do not proceed.

- [ ] **Step 4: Delete the probe and confirm the tree is clean**

```bash
rm -f /Users/col/projects/throng_platform/a2a-wrapper/verify-thinking.mjs
cd /Users/col/projects/throng_platform/a2a-wrapper && git status --short
```

Expected: no output. `dist/` is gitignored; if `git status` shows anything else, investigate before continuing.

---

## Optional: collapse to the two-commit delivery shape

The spec calls for one core commit and one `a2a-claude` commit. Task commits are kept separate during development for bisectability. To collapse them afterwards (non-interactive, no `rebase -i`):

```bash
# Confirm what will be collapsed first
git log --oneline 94ba678..HEAD

# Squash the three a2a-claude commits (Tasks 2, 3, 4, 5) into one
git reset --soft <sha-of-core-commit>
git commit -m "fix(a2a-claude): publish thinking output over A2A"
```

Only do this if the user asks. Do not force-push over `origin/fix/thinking-events` without checking.
