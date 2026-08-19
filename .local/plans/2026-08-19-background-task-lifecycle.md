# Background Task Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an A2A Task in `working` while Claude has background work in flight, and stream each subsequent SDK turn onto the same `taskId`, instead of completing the Task the moment the first SDK turn ends.

**Architecture:** Switch `execute()` from a one-shot string prompt to a streaming-input query whose input stream we hold open, because the SDK closes the CLI's stdin on the first result when the prompt is a string. Track the live background-task set from `background_tasks_changed` (a level signal with replace semantics), and at each `result` decide hold-vs-complete from it. Everything stays inside one query per A2A Task, so `SessionManager`, `resume` continuity and cancellation are untouched.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Vitest, `@anthropic-ai/claude-agent-sdk`, `@a2a-js/sdk`, `@a2a-wrapper/core`.

**Spec:** `.local/specs/2026-08-19-background-task-lifecycle-design.md`

**Working directory for every command:** `/Users/col/projects/throng_platform/a2a-wrapper`

**Note on `npm`:** `node` and `npm` live in `~/.local/bin` and are not on the default PATH. Prefix commands with `export PATH="$HOME/.local/bin:$PATH";` if `npm` is not found.

---

## File Structure

**Created:**
- `a2a-claude/src/claude/background-tasks.ts` — `BackgroundTaskTracker`. Owns the live set and nothing else.
- `a2a-claude/src/claude/__tests__/background-tasks.test.ts` — tracker unit tests.
- `a2a-claude/src/claude/__tests__/executor-background-tasks.test.ts` — lifecycle tests.
- `scripts/background-tasks-smoke/spike-single.mjs`, `scripts/background-tasks-smoke/spike-chain.mjs`, `scripts/background-tasks-smoke/README.md` — end-to-end proof the wake fires.
- `.changeset/hold-task-for-background-work.md`

**Modified:**
- `a2a-claude/package.json` — SDK bump.
- `a2a-claude/src/claude/client-factory.ts` — widen the `runQuery` prompt type; export `SDKUserMessageLike`.
- `a2a-claude/src/claude/prompt-builder.ts` — add `promptStream()`.
- `a2a-claude/src/claude/executor.ts` — the lifecycle change (`turnFn`).
- `a2a-claude/src/claude/event-mapper.ts` — once-per-Task bookends; `background_tasks` event.
- `a2a-claude/src/config/types.ts`, `a2a-claude/src/config/defaults.ts` — two feature flags.
- `a2a-claude/src/claude/__tests__/fake-client.ts` — accept a streaming prompt, record closure.
- `a2a-claude/README.md` — lifecycle docs and the three caveats.

---

### Task 1: Bump the Claude Agent SDK

`background_tasks_changed` does not exist at the pinned `0.3.202`. Nothing else in this plan works without this.

**Files:**
- Modify: `a2a-claude/package.json:58`

- [ ] **Step 1: Change the pin**

In `a2a-claude/package.json`, change:

```json
    "@anthropic-ai/claude-agent-sdk": "0.3.202",
```

to:

```json
    "@anthropic-ai/claude-agent-sdk": "^0.3.235",
```

- [ ] **Step 2: Install**

Run: `export PATH="$HOME/.local/bin:$PATH"; npm install`
Expected: completes without `ERESOLVE` errors.

- [ ] **Step 3: Verify the new message type is present**

Run: `grep -c "background_tasks_changed" node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
Expected: a number greater than `0`. If it prints `0`, the install did not take — stop and investigate before continuing.

- [ ] **Step 4: Verify nothing regressed**

Run: `export PATH="$HOME/.local/bin:$PATH"; npm run typecheck && npm test`
Expected: typecheck clean, all existing tests pass. The wrapper only touches the SDK through the narrow `ClaudeClientLike` interface, so a clean run here is expected. If tests fail, the SDK made a breaking change — fix it in this task before moving on.

- [ ] **Step 5: Commit**

```bash
git add a2a-claude/package.json package-lock.json
git commit -m "chore(claude): bump claude-agent-sdk to ^0.3.235 for background_tasks_changed"
```

---

### Task 2: `BackgroundTaskTracker`

A pure, dependency-free class. Consumes only `background_tasks_changed`, with strict replace semantics. The edge bookends (`task_started` / `task_notification`) are deliberately ignored — the SDK documents their ordering relative to the level as unspecified.

**Files:**
- Create: `a2a-claude/src/claude/background-tasks.ts`
- Test: `a2a-claude/src/claude/__tests__/background-tasks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `a2a-claude/src/claude/__tests__/background-tasks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BackgroundTaskTracker } from "../background-tasks.js";
import type { SDKMessageLike } from "../client-factory.js";

function changed(...ids: string[]): SDKMessageLike {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: ids.map((id) => ({ task_id: id, task_type: "shell", description: `task ${id}` })),
  };
}

describe("BackgroundTaskTracker", () => {
  it("starts empty", () => {
    expect(new BackgroundTaskTracker().size).toBe(0);
  });

  it("replaces the set on each payload rather than merging", () => {
    const t = new BackgroundTaskTracker();
    t.observe(changed("a", "b"));
    expect(t.snapshot().map((x) => x.taskId).sort()).toEqual(["a", "b"]);

    t.observe(changed("b"));
    expect(t.snapshot().map((x) => x.taskId)).toEqual(["b"]);

    t.observe(changed());
    expect(t.size).toBe(0);
  });

  it("reports whether membership changed", () => {
    const t = new BackgroundTaskTracker();
    expect(t.observe(changed("a"))).toBe(true);
    expect(t.observe(changed("a"))).toBe(false);
    expect(t.observe(changed("a", "b"))).toBe(true);
    expect(t.observe(changed())).toBe(true);
  });

  it("ignores every other message type, including the edge bookends", () => {
    const t = new BackgroundTaskTracker();
    t.observe(changed("a"));
    expect(t.observe({ type: "system", subtype: "task_started", task_id: "z" })).toBe(false);
    expect(t.observe({ type: "system", subtype: "task_notification", task_id: "a", status: "completed" })).toBe(false);
    expect(t.observe({ type: "result", subtype: "success", result: "hi" })).toBe(false);
    expect(t.snapshot().map((x) => x.taskId)).toEqual(["a"]);
  });

  it("carries type and description through for status metadata", () => {
    const t = new BackgroundTaskTracker();
    t.observe(changed("a"));
    expect(t.snapshot()[0]).toEqual({ taskId: "a", type: "shell", description: "task a" });
  });

  it("tolerates malformed payloads", () => {
    const t = new BackgroundTaskTracker();
    t.observe({ type: "system", subtype: "background_tasks_changed", tasks: "nonsense" });
    expect(t.size).toBe(0);

    t.observe({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "a" }, { description: "no id" }, null],
    });
    expect(t.snapshot()).toEqual([{ taskId: "a", type: "unknown", description: "" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `export PATH="$HOME/.local/bin:$PATH"; cd a2a-claude && npx vitest --run src/claude/__tests__/background-tasks.test.ts`
Expected: FAIL — cannot resolve `../background-tasks.js`.

- [ ] **Step 3: Write the implementation**

Create `a2a-claude/src/claude/background-tasks.ts`:

```ts
/**
 * Background Task Tracker — the live set of Claude's in-flight background work.
 *
 * Consumes only `system/background_tasks_changed`, which the SDK documents as a
 * *level* signal with replace semantics: every payload carries the full set, so
 * consumers swap their set rather than pairing `task_started` /
 * `task_notification` edges. A missed bookend therefore cannot wedge a stale
 * "still running" indicator, and the SDK explicitly leaves the level's ordering
 * relative to those bookends unspecified — which is why they are ignored here.
 *
 * The level is per-process and nothing is emitted at startup, so a tracker must
 * begin empty and be discarded when the CLI process goes away. That is enforced
 * structurally: the executor creates one tracker per query, and a query is one
 * CLI process, so instance lifetime is process lifetime.
 */

import type { SDKMessageLike } from "./client-factory.js";

/** One live background task, in the shape the A2A status metadata carries. */
export interface BackgroundTaskInfo {
  taskId: string;
  type: string;
  description: string;
}

export class BackgroundTaskTracker {
  private live = new Map<string, BackgroundTaskInfo>();

  /**
   * Fold one SDK message into the set.
   *
   * @returns `true` when set membership changed, so callers can emit a sideband
   *          event only on real transitions.
   */
  observe(msg: SDKMessageLike): boolean {
    if (msg.type !== "system" || msg.subtype !== "background_tasks_changed") return false;

    const raw = Array.isArray(msg.tasks) ? (msg.tasks as unknown[]) : [];
    const next = new Map<string, BackgroundTaskInfo>();

    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      const task = entry as Record<string, unknown>;
      const taskId = typeof task.task_id === "string" ? task.task_id : "";
      if (!taskId) continue;
      next.set(taskId, {
        taskId,
        type: typeof task.task_type === "string" ? task.task_type : "unknown",
        description: typeof task.description === "string" ? task.description : "",
      });
    }

    const changed =
      next.size !== this.live.size || [...next.keys()].some((id) => !this.live.has(id));
    this.live = next;
    return changed;
  }

  /** How many background tasks are live right now. */
  get size(): number {
    return this.live.size;
  }

  /** The live set, for status-update metadata. */
  snapshot(): BackgroundTaskInfo[] {
    return [...this.live.values()];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `export PATH="$HOME/.local/bin:$PATH"; cd a2a-claude && npx vitest --run src/claude/__tests__/background-tasks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add a2a-claude/src/claude/background-tasks.ts a2a-claude/src/claude/__tests__/background-tasks.test.ts
git commit -m "feat(claude): add BackgroundTaskTracker with replace semantics"
```

---

### Task 3: Streaming-input plumbing

Widen the client interface and add the input-stream helper. No behaviour change yet — `execute()` still passes a string after this task.

**Files:**
- Modify: `a2a-claude/src/claude/client-factory.ts:16-54, 166-172`
- Modify: `a2a-claude/src/claude/prompt-builder.ts`
- Modify: `a2a-claude/src/claude/__tests__/fake-client.ts`
- Test: `a2a-claude/src/claude/__tests__/prompt-builder.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `a2a-claude/src/claude/__tests__/prompt-builder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { promptStream } from "../prompt-builder.js";
import { createDeferred } from "@a2a-wrapper/core";

describe("promptStream", () => {
  it("yields exactly one user message carrying the prompt text", async () => {
    const closed = createDeferred<void>();
    const it0 = promptStream("do the thing", closed.promise)[Symbol.asyncIterator]();

    const first = await it0.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: "do the thing" },
    });
  });

  it("parks after the first message and only ends once closed", async () => {
    const closed = createDeferred<void>();
    const it0 = promptStream("hi", closed.promise)[Symbol.asyncIterator]();
    await it0.next();

    const pending = it0.next();
    const raced = await Promise.race([
      pending.then(() => "ended"),
      new Promise((r) => setTimeout(() => r("still-open"), 20)),
    ]);
    expect(raced).toBe("still-open");

    closed.resolve();
    expect((await pending).done).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `export PATH="$HOME/.local/bin:$PATH"; cd a2a-claude && npx vitest --run src/claude/__tests__/prompt-builder.test.ts`
Expected: FAIL — `promptStream` is not exported.

- [ ] **Step 3: Widen the client interface**

In `a2a-claude/src/claude/client-factory.ts`, add this interface immediately after the `SDKMessageLike` interface (around line 19):

```ts
/**
 * The one input-message shape this wrapper sends. Narrower than the SDK's
 * `SDKUserMessage` on purpose: `uuid` and `session_id` are optional there, and
 * everything else on it is for replay/subagent traffic we never originate.
 */
export interface SDKUserMessageLike {
  type: "user";
  parent_tool_use_id: string | null;
  message: { role: "user"; content: string };
}
```

Then change the `ClaudeClientLike` interface (line 52-54) to:

```ts
export interface ClaudeClientLike {
  runQuery(
    prompt: string | AsyncIterable<SDKUserMessageLike>,
    options: QueryOptionsLike,
  ): QueryLike;
}
```

And change `createClaudeClient` (line 166-172) to:

```ts
export function createClaudeClient(_config: Required<AgentConfig>): ClaudeClientLike {
  return {
    runQuery(
      prompt: string | AsyncIterable<SDKUserMessageLike>,
      options: QueryOptionsLike,
    ): QueryLike {
      // A string prompt makes the SDK close the CLI's stdin on the first result
      // (`isSingleUserTurn`), which ends the process before any background-task
      // wake could fire. Streaming input is what keeps that window open.
      return query({
        prompt: prompt as Parameters<typeof query>[0]["prompt"],
        options: options as unknown as Options,
      }) as unknown as QueryLike;
    },
  };
}
```

- [ ] **Step 4: Add `promptStream`**

Replace the whole of `a2a-claude/src/claude/prompt-builder.ts` with:

```ts
/**
 * Prompt Builder
 *
 * Re-exports the shared `extractUserText` helper from `@a2a-wrapper/core`
 * (see `packages/core/src/events/part-utils.ts`) so this wrapper's
 * import paths stay stable. Inbound `Part` parsing is an A2A protocol
 * concern and lives in core, not here.
 *
 * Also owns `promptStream`, the SDK input stream for one A2A Task.
 */

import type { SDKUserMessageLike } from "./client-factory.js";

export { extractUserText } from "@a2a-wrapper/core";

/**
 * The SDK input stream for one A2A Task: the user's prompt, then a park.
 *
 * Passing an async iterable (rather than a string) is what stops the SDK
 * closing the CLI's stdin on the first result, which is the only reason a
 * second turn — and therefore a background-task report — can ever arrive.
 * Resolving `closed` ends the stream, which ends the CLI's input, which lets
 * the process exit and the message iterator complete.
 *
 * The caller MUST resolve `closed` on every exit path or the generator parks
 * forever.
 */
export async function* promptStream(
  text: string,
  closed: Promise<void>,
): AsyncGenerator<SDKUserMessageLike> {
  yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: text } };
  await closed;
}
```

- [ ] **Step 5: Teach the fake client about streaming input**

In `a2a-claude/src/claude/__tests__/fake-client.ts`, replace the `FakeCall` interface, the `FakeQuery` class declaration line, and the `FakeClaudeClient.runQuery` method.

Change the import line at the top to add `SDKUserMessageLike`:

```ts
import type {
  ClaudeClientLike,
  QueryLike,
  QueryOptionsLike,
  SDKMessageLike,
  SDKUserMessageLike,
} from "../client-factory.js";
```

Replace `FakeCall`:

```ts
export interface FakeCall {
  prompt: string | AsyncIterable<SDKUserMessageLike>;
  /** Text of the first input message, whichever prompt form was used. */
  promptText: string;
  options: QueryOptionsLike;
  /** True once the executor closed its input stream. Always true for a string prompt. */
  inputClosed: boolean;
  /** Messages the executor pushed into the input stream. */
  inputMessages: SDKUserMessageLike[];
}
```

Replace `FakeClaudeClient.runQuery` with:

```ts
  runQuery(
    prompt: string | AsyncIterable<SDKUserMessageLike>,
    options: QueryOptionsLike,
  ): QueryLike {
    const call: FakeCall = {
      prompt,
      promptText: typeof prompt === "string" ? prompt : "",
      options,
      inputClosed: typeof prompt === "string",
      inputMessages: [],
    };
    this.calls.push(call);

    // Drain the input stream the way the real SDK does, so tests can assert the
    // executor closed it. The generator parks after its first message, so this
    // loop stays pending until the executor resolves its deferred.
    if (typeof prompt !== "string") {
      void (async () => {
        try {
          for await (const msg of prompt) {
            call.inputMessages.push(msg);
            if (call.promptText === "") call.promptText = msg.message.content;
          }
        } catch {
          // A rejected input stream is not something the executor should do;
          // swallow it so an unhandled rejection cannot fail an unrelated test.
        }
        call.inputClosed = true;
      })();
    }

    const script = this.scripts[Math.min(this.calls.length - 1, this.scripts.length - 1)];
    const q = new FakeQuery(script, options.abortController?.signal);
    this.queries.push(q);
    return q;
  }
```

- [ ] **Step 6: Run the full suite**

Run: `export PATH="$HOME/.local/bin:$PATH"; npm run typecheck && npm test`
Expected: all tests pass, including the two new `promptStream` tests. `execute()` still passes a string, so nothing else changed.

- [ ] **Step 7: Commit**

```bash
git add a2a-claude/src/claude/client-factory.ts a2a-claude/src/claude/prompt-builder.ts a2a-claude/src/claude/__tests__/fake-client.ts a2a-claude/src/claude/__tests__/prompt-builder.test.ts
git commit -m "feat(claude): support streaming-input queries in the client interface"
```

---

### Task 4: Feature flags

Two flags, both defaulting on. Added before the executor change so the executor can read them.

**Files:**
- Modify: `a2a-claude/src/config/types.ts:168-181`
- Modify: `a2a-claude/src/config/defaults.ts:44-51`

- [ ] **Step 1: Add the flags to the type**

In `a2a-claude/src/config/types.ts`, inside `interface FeatureFlags`, add after the `emitRateLimitEvents` line:

```ts
  /**
   * Hold the A2A Task open in `working` while Claude has background work in
   * flight, completing it only once a turn ends with nothing left running.
   * Default: true. Set false to restore the pre-0.4 behaviour of completing the
   * Task at the first SDK result.
   */
  holdTaskForBackgroundWork?: boolean;
  /** Publish background-task set changes as sideband events. Default: true. */
  emitBackgroundTaskEvents?: boolean;
```

- [ ] **Step 2: Add the defaults**

In `a2a-claude/src/config/defaults.ts`, inside the `features` object, add after `emitRateLimitEvents: true,`:

```ts
    holdTaskForBackgroundWork: true,
    emitBackgroundTaskEvents: true,
```

- [ ] **Step 3: Verify**

Run: `export PATH="$HOME/.local/bin:$PATH"; npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add a2a-claude/src/config/types.ts a2a-claude/src/config/defaults.ts
git commit -m "feat(claude): add holdTaskForBackgroundWork and emitBackgroundTaskEvents flags"
```

---

### Task 5: Event-mapper — once-per-Task bookends and the background_tasks event

The spikes show an `init` re-emitted on every background-task wake (three across a two-stage chain), and `handleResult` fires `agent_finished` on every result. Both bookends must fire once per A2A Task. `EventMapper` is constructed once per `execute()` call, so instance state is the right scope.

**Files:**
- Modify: `a2a-claude/src/claude/event-mapper.ts:79-155, 260-283`
- Test: `a2a-claude/src/claude/__tests__/event-mapper.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `a2a-claude/src/claude/__tests__/event-mapper.test.ts`. If the file's existing helpers differ, reuse them rather than redefining — this block assumes an `emitter` double collecting `{ type, data }` and a `makeConfig()` helper; if those names differ in the file, adapt the two lines that build `mapper`.

```ts
describe("EventMapper across a held-open task", () => {
  it("emits agent_started once even when init is re-emitted on wake", () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const emitter = { emit: (type: string, data: unknown) => { events.push({ type, data }); } };
    const mapper = new EventMapper(emitter as never, makeConfig());

    const init = { type: "system", subtype: "init", model: "claude-test" };
    mapper.handleMessage(init);
    mapper.handleMessage(init);
    mapper.handleMessage(init);

    expect(events.filter((e) => e.type === "agent_started")).toHaveLength(1);
  });

  it("suppresses agent_finished while the task is held, emitting once at the end", () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const emitter = { emit: (type: string, data: unknown) => { events.push({ type, data }); } };
    const mapper = new EventMapper(emitter as never, makeConfig());

    const result = { type: "result", subtype: "success", result: "x", usage: {}, total_cost_usd: 0, num_turns: 1 };
    mapper.handleResult(result, { held: true });
    mapper.handleResult(result, { held: true });
    mapper.handleResult(result, { held: false });

    expect(events.filter((e) => e.type === "agent_finished")).toHaveLength(1);
  });

  it("emits background_tasks when the flag is on and not when it is off", () => {
    const on: Array<{ type: string; data: unknown }> = [];
    const onMapper = new EventMapper(
      { emit: (type: string, data: unknown) => { on.push({ type, data }); } } as never,
      makeConfig(),
    );
    onMapper.handleBackgroundTasks([{ taskId: "a", type: "shell", description: "build" }]);
    expect(on.filter((e) => e.type === "background_tasks")).toHaveLength(1);
    expect(on[0].data).toMatchObject({ backend: "claude", count: 1 });

    const offConfig = makeConfig();
    offConfig.features.emitBackgroundTaskEvents = false;
    const off: Array<{ type: string; data: unknown }> = [];
    const offMapper = new EventMapper(
      { emit: (type: string, data: unknown) => { off.push({ type, data }); } } as never,
      offConfig,
    );
    offMapper.handleBackgroundTasks([{ taskId: "a", type: "shell", description: "build" }]);
    expect(off).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH="$HOME/.local/bin:$PATH"; cd a2a-claude && npx vitest --run src/claude/__tests__/event-mapper.test.ts`
Expected: FAIL — `handleResult` is private and `handleBackgroundTasks` does not exist.

- [ ] **Step 3: Add the import and instance state**

In `a2a-claude/src/claude/event-mapper.ts`, add to the imports:

```ts
import type { BackgroundTaskInfo } from "./background-tasks.js";
```

Inside `class EventMapper`, add below the existing `config` field:

```ts
  /**
   * A background-task wake re-emits `system/init` for the same session, so
   * without this an A2A Task that spans several SDK turns would emit
   * `agent_started` once per turn. Both bookends are per-A2A-Task, and this
   * mapper is constructed per `execute()` call, so instance state is the
   * right scope.
   */
  private sawInit = false;
  private emittedFinished = false;
```

- [ ] **Step 4: Suppress the duplicate `agent_started`**

In `handleSystem`, replace the `init` branch:

```ts
    if (msg.subtype === "init") {
      if (this.sawInit) return;
      this.sawInit = true;
      this.emitter.emit("agent_started", {
        backend: "claude",
        model: typeof msg.model === "string" ? msg.model : "",
      });
    } else if (msg.subtype === "permission_denied") {
```

- [ ] **Step 5: Make `handleResult` public and held-aware**

Change the `case "result":` line inside `handleMessage` to:

```ts
        case "result":
          this.handleResult(msg, { held: false });
          break;
```

Change the `handleResult` signature and its success branch:

```ts
  /**
   * @param opts.held - True when the executor is keeping the A2A Task open
   *   because background work is still in flight. `agent_finished` is a
   *   per-A2A-Task bookend, not a per-SDK-turn one, so it is suppressed until
   *   the turn that actually ends the Task.
   */
  handleResult(msg: SDKMessageLike, opts: { held: boolean } = { held: false }): void {
    if (msg.subtype === "success") {
      if (opts.held || this.emittedFinished) return;
      this.emittedFinished = true;
      this.emitter.emit("agent_finished", {
        backend: "claude",
        usage: sanitizeData(msg.usage) ?? null,
        totalCostUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
        numTurns: typeof msg.num_turns === "number" ? msg.num_turns : null,
      });
      return;
    }
```

Leave the error branch below it untouched.

- [ ] **Step 6: Add `handleBackgroundTasks`**

Add this method to `EventMapper`, next to `handleRateLimit`:

```ts
  /**
   * Emit the live background-task set. Called by the executor only when
   * membership actually changed, so this is a transition, not a heartbeat.
   */
  handleBackgroundTasks(tasks: BackgroundTaskInfo[]): void {
    if (!this.config.features.emitBackgroundTaskEvents) return;
    this.emitter.emit("background_tasks", {
      backend: "claude",
      count: tasks.length,
      tasks,
    });
  }
```

- [ ] **Step 7: Run the tests**

Run: `export PATH="$HOME/.local/bin:$PATH"; npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add a2a-claude/src/claude/event-mapper.ts a2a-claude/src/claude/__tests__/event-mapper.test.ts
git commit -m "feat(claude): make agent lifecycle bookends per-task, add background_tasks event"
```

---

### Task 6: Hold the A2A Task open

The core change. `turnFn` moves terminality from "the iterator ended" to "a result arrived with nothing in flight".

**Files:**
- Modify: `a2a-claude/src/claude/executor.ts:33-46, 258-426`
- Test: `a2a-claude/src/claude/__tests__/executor-background-tasks.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `a2a-claude/src/claude/__tests__/executor-background-tasks.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeExecutor } from "../executor.js";
import { FakeClaudeClient } from "./fake-client.js";
import type { SDKMessageLike } from "../client-factory.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";

const STATE_NAME: Partial<Record<TaskState, string>> = {
  [TaskState.TASK_STATE_SUBMITTED]: "submitted",
  [TaskState.TASK_STATE_WORKING]: "working",
  [TaskState.TASK_STATE_COMPLETED]: "completed",
  [TaskState.TASK_STATE_CANCELED]: "canceled",
  [TaskState.TASK_STATE_FAILED]: "failed",
};

interface PublishedEvent {
  kind?: string;
  data?: { status?: { state?: TaskState; message?: unknown }; [k: string]: unknown };
  [k: string]: unknown;
}

function makeBus() {
  const events: PublishedEvent[] = [];
  let finishedCount = 0;
  const bus = {
    publish: (e: PublishedEvent) => { events.push(e); },
    finished: () => { finishedCount++; },
    on: () => bus, off: () => bus, once: () => bus, removeAllListeners: () => bus,
  } as unknown as ExecutionEventBus;
  return { bus, events, finished: () => finishedCount };
}

function makeCtx(taskId: string, contextId: string, text = "do the thing"): RequestContext {
  return {
    taskId, contextId, task: undefined,
    userMessage: {
      messageId: "m1", contextId, taskId, role: 1,
      parts: [{ content: { $case: "text", value: text }, metadata: undefined }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    },
  } as unknown as RequestContext;
}

const states = (events: PublishedEvent[]): string[] =>
  events.filter((e) => e.kind === "statusUpdate")
    .map((e) => STATE_NAME[e.data?.status?.state as TaskState] ?? "");

const artifacts = (events: PublishedEvent[]): PublishedEvent[] =>
  events.filter((e) => e.kind === "artifactUpdate");

// ─── SDK message builders ────────────────────────────────────────────────────

const init = (sessionId: string): SDKMessageLike =>
  ({ type: "system", subtype: "init", session_id: sessionId, model: "claude-test" });

const bgChanged = (...ids: string[]): SDKMessageLike =>
  ({
    type: "system", subtype: "background_tasks_changed",
    tasks: ids.map((id) => ({ task_id: id, task_type: "shell", description: `task ${id}` })),
  });

const result = (text: string): SDKMessageLike =>
  ({
    type: "result", subtype: "success", result: text,
    usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.01, num_turns: 1,
  });

const errorResult = (subtype: string): SDKMessageLike =>
  ({ type: "result", subtype, errors: ["boom"], usage: {}, total_cost_usd: 0, num_turns: 1 });

// ─── Setup ───────────────────────────────────────────────────────────────────

let ws: string;
let config: Required<AgentConfig>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "a2a-claude-bg-"));
  config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ws })) as Required<AgentConfig>;
  config.claude.workingDirectory = ws;
  config.events = { enabled: false } as Required<AgentConfig>["events"];
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("held-open A2A task", () => {
  it("stays working when a result arrives with background work in flight", async () => {
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("build started"), bgChanged(), result("build passed")],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "working", "completed"]);
    expect(finished()).toBe(1);
  });

  it("publishes one artifact per round", async () => {
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("build started"), bgChanged(), result("build passed")],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    const texts = artifacts(events).map((a) => JSON.stringify(a));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("build started");
    expect(texts[1]).toContain("build passed");
  });

  it("carries the live set as status metadata on the held update", async () => {
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("waiting"), bgChanged(), result("done")],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    const held = events.filter((e) => e.kind === "statusUpdate")[1];
    expect(JSON.stringify(held)).toContain("bg1");
  });

  it("loops for as many rounds as the chain needs", async () => {
    const client = new FakeClaudeClient([{
      messages: [
        init("s1"),
        bgChanged("bg1"), result("stage 1 running"),
        bgChanged(), bgChanged("bg2"), result("stage 2 running"),
        bgChanged(), result("both done"),
      ],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "working", "working", "completed"]);
    expect(artifacts(events)).toHaveLength(3);
    expect(finished()).toBe(1);
  });

  it("completes at the first result when nothing is in flight", async () => {
    const client = new FakeClaudeClient([{ messages: [init("s1"), result("hello world")] }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "completed"]);
    expect(artifacts(events)).toHaveLength(1);
    expect(finished()).toBe(1);
  });

  it("completes at the first result when the flag is off", async () => {
    config.features.holdTaskForBackgroundWork = false;
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("build started"), bgChanged(), result("never read")],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "completed"]);
    expect(artifacts(events)).toHaveLength(1);
  });

  it("closes the input stream on the success path", async () => {
    const client = new FakeClaudeClient([{ messages: [init("s1"), result("done")] }]);
    const ex = new ClaudeExecutor(config, () => client);

    await ex.execute(makeCtx("t1", "ctx-1"), makeBus().bus);
    await new Promise((r) => setTimeout(r, 10));

    expect(client.calls[0].inputClosed).toBe(true);
    expect(client.calls[0].promptText).toBe("do the thing");
  });

  it("closes the input stream when a result errors", async () => {
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), errorResult("error_max_turns")],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);
    await new Promise((r) => setTimeout(r, 10));

    expect(states(events)).toEqual(["submitted", "working", "failed"]);
    expect(finished()).toBe(1);
    expect(client.calls[0].inputClosed).toBe(true);
  });

  it("falls back to completing when the iterator ends while still held", async () => {
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("still waiting")],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "working", "completed"]);
    expect(finished()).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export PATH="$HOME/.local/bin:$PATH"; cd a2a-claude && npx vitest --run src/claude/__tests__/executor-background-tasks.test.ts`
Expected: FAIL — the held tests complete at the first result.

- [ ] **Step 3: Add the imports**

In `a2a-claude/src/claude/executor.ts`, add to the local imports block:

```ts
import { extractUserText, promptStream } from "./prompt-builder.js";
import { BackgroundTaskTracker } from "./background-tasks.js";
```

(the existing `import { extractUserText } from "./prompt-builder.js";` line is replaced by the first of these), and add `createDeferred` to the `@a2a-wrapper/core` import list:

```ts
import {
  resolveTransport,
  AgentEventEmitter,
  materializeMemory,
  bootstrapSubAgents,
  createDeferred,
  publishTask,
  publishStatus,
  publishFinalArtifact,
  publishStreamingChunk,
  publishLastChunkMarker,
} from "@a2a-wrapper/core";
```

- [ ] **Step 4: Rewrite `turnFn`**

Replace the whole `const turnFn = async (): Promise<void> => { … };` block (executor.ts:258-426) with:

```ts
      const turnFn = async (): Promise<void> => {
        let timedOut = false;
        // A prompt timeout of 0 (or any value <= 0) disables the bound entirely:
        // the turn runs until the SDK iterator completes. Without this guard
        // setTimeout would coerce such a delay to the next tick and abort at once.
        //
        // Note this timer is armed once, at turn start, and never re-armed — so
        // for a held-open task it bounds the whole A2A Task including the idle
        // gaps between SDK turns. See the README caveat.
        const promptTimeout = this.config.timeouts.prompt ?? 600_000;
        const timer =
          promptTimeout > 0
            ? setTimeout(() => {
                timedOut = true;
                abortController.abort();
              }, promptTimeout)
            : null;

        // Hoisted above the try: `break` inside `for await` awaits
        // iterator.return(), and a rejection there lands in the catch block,
        // which must still be able to see a rate limit we already detected.
        let rateLimited: RateLimitSnapshot | null = null;
        let finalText = "";
        let streamArtifactStarted = false;
        const streaming = this.config.features.streamArtifactChunks === true;

        // One artifact per round, so a held-open task's later rounds cannot
        // append onto an earlier round's artifact and make its lastChunk
        // marker's fullText a lie.
        let round = 1;
        const streamArtifactId = (): string => `response-${taskId}-${round}`;

        // Terminality is decided inside the loop now, so both the catch and the
        // post-loop block need to know whether it already happened.
        let terminalPublished = false;

        // One tracker per query. A query is one CLI process, and the SDK's
        // background-task level signal is per-process, so this scoping is what
        // makes "reset to empty when the process restarts" structural.
        const backgroundTasks = new BackgroundTaskTracker();
        const holdEnabled = this.config.features.holdTaskForBackgroundWork !== false;

        // Resolving this ends the SDK input stream, which lets the CLI exit.
        // It MUST be resolved on every exit path — see the finally block.
        const inputClosed = createDeferred<void>();

        /** Single definition of the rate-limit ending, used by both paths. */
        const endTurnRateLimited = (snapshot: RateLimitSnapshot): void => {
          // Tear down the subprocess — same break-then-abort teardown the
          // plugin preflight uses. Waiting out a reset is never our call.
          // `query.interrupt()` (which cancelTask also calls) is not needed
          // here: the `break` already closed the iterator, so there is no
          // in-flight consumer left to interrupt, and abort() is what actually
          // stops the subprocess.
          abortController.abort();

          // Already-sent chunks would otherwise leave the client's artifact
          // open forever. This closes the current round's stream; finalText is
          // intentionally "" here, since no success result arrives on this path.
          if (streaming && streamArtifactStarted) {
            publishLastChunkMarker(bus, taskId, contextId, streamArtifactId(), finalText);
          }

          // Always terminal. The SDK cannot resume an interrupted turn — a
          // follow-up is a new prompt regardless — so holding the task open
          // would promise a continuation we never deliver. Continuity comes
          // from the contextId → Claude session mapping, which survives a
          // failed task, so the client just starts a new task on the same
          // contextId once the limit resets.
          publishStatus(
            bus, taskId, contextId, "failed",
            renderRateLimitMessage(snapshot),
            true,
            rateLimitMetadata(snapshot),
          );
          terminalPublished = true;
          bus.finished();
        };

        try {
          publishStatus(bus, taskId, contextId, "working", "Processing request...");

          const options = buildQueryOptions(this.config, {
            resume: session.sessionId ?? undefined,
            abortController,
          });
          // Streaming input, not a string: a string prompt makes the SDK close
          // the CLI's stdin on the first result, ending the process before any
          // background-task wake could fire.
          const q = this.client!.runQuery(promptStream(promptText, inputClosed.promise), options);
          this.sessionManager!.attachQuery(taskId, q);

          let resultError: string | null = null;
          const rateLimits = new RateLimitTracker();

          for await (const msg of q as AsyncIterable<SDKMessageLike>) {
            const verdict = rateLimits.observe(msg);
            if (verdict.kind !== "none") mapper.handleRateLimit(verdict);
            if (verdict.kind === "rejected") {
              rateLimited = verdict.snapshot;
              break;
            }

            if (backgroundTasks.observe(msg)) {
              mapper.handleBackgroundTasks(backgroundTasks.snapshot());
            }

            if (msg.type === "system" && msg.subtype === "init" && session.sessionId === null) {
              if (typeof msg.session_id === "string") session.sessionId = msg.session_id;
            }

            // Safety-system refusal with no fallback model → fail the task
            // with a generic message (spec §4.4). Never echo refusal details.
            if (msg.type === "system" && msg.subtype === "model_refusal_no_fallback") {
              resultError = "Request declined by model safety system.";
            }

            if (streaming && msg.type === "stream_event" && msg.parent_tool_use_id == null) {
              const event = msg.event as Record<string, unknown> | undefined;
              const delta = event?.delta as Record<string, unknown> | undefined;
              if (event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
                streamArtifactStarted = true;
                publishStreamingChunk(bus, taskId, contextId, streamArtifactId(), delta.text);
              }
            }

            if (msg.type !== "result") {
              mapper.handleMessage(msg);
              continue;
            }

            // ── A result message: decide whether this ends the A2A Task ──
            if (msg.subtype === "success" && typeof msg.result === "string") {
              finalText = msg.result;
            } else if (msg.subtype !== "success") {
              const reasons: Record<string, string> = {
                error_max_turns: "Turn limit reached (max_turns).",
                error_max_budget_usd: "Budget limit reached (max_budget_usd).",
                error_during_execution: "Error during execution.",
                error_max_structured_output_retries: "Structured output retries exhausted.",
              };
              resultError = reasons[String(msg.subtype)] ?? `Execution failed (${String(msg.subtype)}).`;
            }

            const holding = holdEnabled && resultError === null && backgroundTasks.size > 0;
            mapper.handleResult(msg, { held: holding });

            if (resultError !== null) {
              // The CLI stays alive on streaming input, so an error result would
              // hang the loop unless we close the stream ourselves.
              inputClosed.resolve();
              break;
            }

            // This round's output, closed either way so the next round starts a
            // fresh artifact.
            if (streaming && streamArtifactStarted) {
              publishLastChunkMarker(bus, taskId, contextId, streamArtifactId(), finalText);
            } else if (finalText) {
              publishFinalArtifact(bus, taskId, contextId, finalText);
            }
            streamArtifactStarted = false;

            if (holding) {
              publishStatus(
                bus, taskId, contextId, "working",
                finalText || undefined,
                false,
                { backgroundTasks: backgroundTasks.snapshot() },
              );
              finalText = "";
              round += 1;
              continue;
            }

            publishStatus(bus, taskId, contextId, "completed", undefined, true);
            terminalPublished = true;
            bus.finished();
            inputClosed.resolve();
            break;
          }

          if (rateLimited) {
            endTurnRateLimited(rateLimited);
            return;
          }

          if (resultError) {
            publishStatus(bus, taskId, contextId, "failed", sanitizeMessage(resultError), true);
            terminalPublished = true;
            bus.finished();
            return;
          }

          if (!terminalPublished) {
            // The iterator ended while we were still holding — the CLI died, or
            // it closed input on us. Complete with whatever the last round left
            // rather than hanging until the prompt timeout.
            log.info("SDK iterator ended while the task was still held open", {
              taskId,
              liveBackgroundTasks: backgroundTasks.size,
            });
            if (streaming && streamArtifactStarted) {
              publishLastChunkMarker(bus, taskId, contextId, streamArtifactId(), finalText);
            } else if (finalText) {
              publishFinalArtifact(bus, taskId, contextId, finalText);
            }
            publishStatus(bus, taskId, contextId, "completed", undefined, true);
            terminalPublished = true;
            bus.finished();
          }
        } catch (err) {
          // A detected rate limit outranks whatever the teardown threw: the
          // `break` above awaits iterator.return(), so a failing teardown would
          // otherwise discard the real reason this turn ended — and a teardown
          // error whose text merely contains "abort" would fall into the
          // silent branch below, leaving the task open with no terminal event.
          if (rateLimited) {
            log.info("Rate limit ended the turn; ignoring teardown error", {
              taskId,
              error: err instanceof Error ? err.message : String(err),
            });
            endTurnRateLimited(rateLimited);
            return;
          }

          // We break out of the loop after publishing a terminal event, which
          // awaits iterator.return(); a throw from that teardown must not
          // produce a second, contradictory terminal event.
          if (terminalPublished) {
            log.debug("Ignoring teardown error after the task was already terminal", {
              taskId,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }

          const isAbort =
            err instanceof Error &&
            (err.name === "AbortError" || err.message.includes("abort") || err.message.includes("canceled"));

          if (isAbort && timedOut) {
            const msg = `Prompt timed out after ${promptTimeout}ms.`;
            log.error("Task execution timed out", { taskId });
            publishStatus(bus, taskId, contextId, "failed", msg, true);
            bus.finished();
          } else if (isAbort) {
            log.info("Task execution aborted", { taskId });
            // cancelTask already published the canceled status
          } else {
            const msg = sanitizeMessage(err instanceof Error ? err.message : String(err));
            log.error("Task execution failed", { taskId, error: msg });
            publishStatus(bus, taskId, contextId, "failed", msg, true);
            bus.finished();
          }
        } finally {
          // The input generator parks forever if this never resolves, keeping
          // the CLI subprocess alive. Every exit path lands here; resolving an
          // already-resolved deferred is a no-op.
          inputClosed.resolve();
          if (timer) clearTimeout(timer);
          this.sessionManager?.untrackExecution(taskId);
        }
      };
```

- [ ] **Step 5: Run the new tests**

Run: `export PATH="$HOME/.local/bin:$PATH"; cd a2a-claude && npx vitest --run src/claude/__tests__/executor-background-tasks.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Run the whole suite — this is the real regression signal**

Run: `export PATH="$HOME/.local/bin:$PATH"; npm run typecheck && npm test`
Expected: everything passes. Every existing executor test exercises the path that just switched from a string prompt to a stream; a clean run here is the evidence that the switch is behaviour-preserving. If `executor-rate-limit.test.ts` fails, check that `endTurnRateLimited` still sets `terminalPublished` before `bus.finished()`.

- [ ] **Step 7: Commit**

```bash
git add a2a-claude/src/claude/executor.ts a2a-claude/src/claude/__tests__/executor-background-tasks.test.ts
git commit -m "feat(claude): hold the A2A task open while background work is in flight"
```

---

### Task 7: Per-round artifacts in streaming mode

Task 6 already wired `streamArtifactId()` per round. This task proves it.

**Files:**
- Test: `a2a-claude/src/claude/__tests__/executor-background-tasks.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `executor-background-tasks.test.ts`, inside the existing `describe` block:

```ts
  it("gives each round its own streaming artifact id and lastChunk marker", async () => {
    config.features.streamArtifactChunks = true;
    const delta = (text: string): SDKMessageLike => ({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });

    const client = new FakeClaudeClient([{
      messages: [
        init("s1"),
        bgChanged("bg1"), delta("build "), delta("started"), result("build started"),
        bgChanged(), delta("build passed"), result("build passed"),
      ],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    const ids = artifacts(events).map(
      (a) => (a.data as { artifact?: { artifactId?: string } }).artifact?.artifactId,
    );
    expect(ids).toEqual([
      "response-t1-1", "response-t1-1", "response-t1-1",   // 2 chunks + marker
      "response-t1-2", "response-t1-2",                     // 1 chunk + marker
    ]);

    const markers = artifacts(events).filter(
      (a) => (a.data as { lastChunk?: boolean }).lastChunk === true,
    );
    expect(markers).toHaveLength(2);
    expect(JSON.stringify(markers[0])).toContain("build started");
    expect(JSON.stringify(markers[1])).toContain("build passed");
  });
```

- [ ] **Step 2: Run it**

Run: `export PATH="$HOME/.local/bin:$PATH"; cd a2a-claude && npx vitest --run src/claude/__tests__/executor-background-tasks.test.ts`
Expected: PASS. Task 6's implementation already satisfies this; if it fails, the `round += 1` is in the wrong place — it must run *after* the round's `publishLastChunkMarker`.

- [ ] **Step 3: Commit**

```bash
git add a2a-claude/src/claude/__tests__/executor-background-tasks.test.ts
git commit -m "test(claude): cover per-round streaming artifact ids"
```

---

### Task 8: Smoke scripts

The only end-to-end proof the wake actually fires. These are manual — they spend real quota and need an authenticated `claude`.

**Files:**
- Create: `scripts/background-tasks-smoke/spike-single.mjs`
- Create: `scripts/background-tasks-smoke/spike-chain.mjs`
- Create: `scripts/background-tasks-smoke/README.md`

- [ ] **Step 1: Copy the two spike scripts**

The two scripts already exist, written during design. Copy them:

```bash
mkdir -p scripts/background-tasks-smoke
cp /private/tmp/claude-501/-Users-col-projects-throng-platform-a2a-wrapper/d0765a57-a273-4d3a-b03e-59f2a39e0dbf/scratchpad/spike/spike.mjs scripts/background-tasks-smoke/spike-single.mjs
cp /private/tmp/claude-501/-Users-col-projects-throng-platform-a2a-wrapper/d0765a57-a273-4d3a-b03e-59f2a39e0dbf/scratchpad/spike/spike2.mjs scripts/background-tasks-smoke/spike-chain.mjs
```

If the scratchpad has been cleaned up and the files are gone, skip this task, note it in the handoff, and move on — they are documentation, not production code.

- [ ] **Step 2: Write the README**

Create `scripts/background-tasks-smoke/README.md`:

```markdown
# Background-task lifecycle smoke tests

Manual end-to-end checks that Claude's background-task wake actually fires in
headless SDK mode. Unit tests use scripted fakes; only these run the real CLI.

**These spend real quota** — roughly a minute of model time each — and need an
authenticated `claude` on PATH.

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
on one query, with no second user message pushed.

`spike-chain.mjs` mirrors the executor's decision logic inline and should end
with `decisions=["HOLD","HOLD","COMPLETE"]`.

Both should show `session_state_changed` **never firing**. It is documented as
the "authoritative turn-over signal" but is not carried by the stream-json
transport, which is why the executor counts the background-task level set
instead. If it ever starts firing, revisit that decision.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/background-tasks-smoke
git commit -m "test(claude): add background-task lifecycle smoke scripts"
```

---

### Task 9: Documentation and changeset

**Files:**
- Modify: `a2a-claude/README.md`
- Create: `.changeset/hold-task-for-background-work.md`

- [ ] **Step 1: Document the lifecycle**

In `a2a-claude/README.md`, find the section covering task lifecycle or feature flags (search for `streamArtifactChunks`) and add:

```markdown
### Background work and task lifecycle

When Claude starts a background process and ends its turn waiting on it, the
A2A Task stays in `working` instead of completing. Each subsequent SDK turn
publishes its own `response` artifact plus a non-final `working` status whose
`metadata.backgroundTasks` lists what is still running. The Task completes when
a turn ends with nothing left in flight.

Controlled by `features.holdTaskForBackgroundWork` (default `true`). Set it to
`false` to complete the Task at the first SDK result, as older versions did.

Three consequences worth knowing:

- **`claude.maxTurns` now spans rounds.** A held-open Task accumulates SDK turns
  across every round, so a chain that would previously have been several Tasks
  under several budgets is now one budget.
- **`timeouts.prompt` bounds the whole Task**, including the idle gaps between
  turns, because it is armed once at turn start. Raise it if you expect long
  background work; the default of 10 minutes is often too low for this feature.
  Setting it to `0` disables the bound entirely, which means a held-open Task
  can wait indefinitely.
- **Further messages on the same `contextId` queue behind a held-open Task**,
  since turns are serialized per context.
```

- [ ] **Step 2: Write the changeset**

Create `.changeset/hold-task-for-background-work.md`:

```markdown
---
"a2a-claude": minor
---

Decouple the A2A Task lifecycle from the SDK turn so background work can report back.

An A2A Task previously completed the moment the first SDK turn ended, so when
Claude started a background process and ended its turn waiting on it, the
follow-up could never be delivered — A2A gives an agent no way to initiate a
turn against a terminal Task.

The Task now stays in `working` while background work is in flight, publishing
one `response` artifact and one non-final status update per SDK turn, and
completes when a turn ends with nothing left running. Turn the behaviour off
with `features.holdTaskForBackgroundWork: false`.

This required moving queries to streaming-input mode, since a string prompt
makes the SDK close the CLI's stdin on the first result, and bumping
`@anthropic-ai/claude-agent-sdk` to `^0.3.235` for the `background_tasks_changed`
message.
```

- [ ] **Step 3: Verify and commit**

Run: `export PATH="$HOME/.local/bin:$PATH"; npm run typecheck && npm test && npm run build`
Expected: all clean.

```bash
git add a2a-claude/README.md .changeset/hold-task-for-background-work.md
git commit -m "docs(claude): document the held-open task lifecycle"
```

---

## Self-Review Notes

**Spec coverage:** SDK bump → Task 1. Tracker with replace semantics and per-query scope → Task 2. Streaming input and `promptStream` → Task 3. Feature flags → Task 4. Once-per-Task bookends and `background_tasks` event → Task 5. Lifecycle table, per-round artifacts, status metadata, stream-closure discipline, loop-ends-while-held fallback, `resultError` closure, rate-limit round id, terminal-after-teardown guard → Task 6. Streaming artifact ids → Task 7. Smoke scripts → Task 8. README caveats and changeset → Task 9.

**Spec items with no task, by design:** the wedge case (accepted risk, no code), `maxTurns` spanning rounds (documented only), concurrent messages queuing (status quo, documented only), and the deferred two-timer timeout work (explicitly out of scope).

**Test-case mapping to the spec's table:** 1→"stays working"; 2→"publishes one artifact per round" + "completes at the first result"; 3→"loops for as many rounds"; 4→"completes at the first result when nothing is in flight"; 5→"flag off"; 6→the two "closes the input stream" tests; 7→"falls back to completing"; 8→Task 5's mapper tests; 9→Task 7; 10→Task 2.

**Type consistency:** `BackgroundTaskInfo` is `{ taskId, type, description }` in Task 2 and used with those names in Tasks 5 and 6. `handleResult(msg, { held })` and `handleBackgroundTasks(tasks)` match between Task 5's definitions and Task 6's call sites. `SDKUserMessageLike` is defined in Task 3 and imported in Task 3's `prompt-builder.ts`. `streamArtifactId()` is a function in Task 6 and every call site uses `streamArtifactId()`, never the old `streamArtifactId` constant.
