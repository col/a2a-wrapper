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
import type { AgentEvent } from "@a2a-wrapper/core";

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

const rejected = (): SDKMessageLike =>
  ({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected", rateLimitType: "five_hour",
      resetsAt: Date.now() + 3_600_000, utilization: 1,
    },
  });

/**
 * Fail fast rather than hanging to vitest's default timeout.
 *
 * The input-stream tests below run against a transport whose `return()`
 * drains the input pump. An executor that stops closing its stream before a
 * `break` wedges there permanently — a wedge is exactly the failure those
 * tests exist to catch, so it needs a bounded, legible signal.
 */
async function settleWithin<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let ws: string;
let config: Required<AgentConfig>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "a2a-claude-bg-"));
  config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ws })) as Required<AgentConfig>;
  config.claude.workingDirectory = ws;
  config.events = { enabled: false } as Required<AgentConfig>["events"];
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

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

    // [0] submitted, [1] working "Processing request...", [2] the held update.
    const statusUpdates = events.filter((e) => e.kind === "statusUpdate");
    expect(states(events)).toEqual(["submitted", "working", "working", "completed"]);
    const held = statusUpdates[2];
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

  // ── Closing the SDK input stream ───────────────────────────────────────
  //
  // Three sites decide when the stream closes, and the asymmetry between them
  // is deliberate: the success and error `break`s close it first, the
  // rate-limit `break` deliberately does not and leans on the `finally`.
  // Asserting `inputClosed === true` alone cannot tell them apart — the
  // `finally` makes that true on every exit path — so the first two tests run
  // against `returnAwaitsInputClosed`, a transport that wedges on `break`
  // unless the stream was already closed, and the third runs without it so
  // that only the `finally` can satisfy it.

  it("closes the input stream before breaking on the success path", async () => {
    const client = new FakeClaudeClient([{
      messages: [init("s1"), result("done")],
      returnAwaitsInputClosed: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await settleWithin(ex.execute(makeCtx("t1", "ctx-1"), bus), 500, "execute()");

    expect(states(events)).toEqual(["submitted", "working", "completed"]);
    expect(finished()).toBe(1);
    expect(client.calls[0].inputClosed).toBe(true);
    expect(client.calls[0].promptText).toBe("do the thing");
  });

  it("closes the input stream before breaking when a result errors", async () => {
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), errorResult("error_max_turns")],
      returnAwaitsInputClosed: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await settleWithin(ex.execute(makeCtx("t1", "ctx-1"), bus), 500, "execute()");

    expect(states(events)).toEqual(["submitted", "working", "failed"]);
    expect(finished()).toBe(1);
    expect(client.calls[0].inputClosed).toBe(true);
  });

  it("leaves the rate-limit break's input stream to the finally", async () => {
    // The mirror image of the two above: this path breaks without closing the
    // stream, so the `finally` is the only thing that ever releases the input
    // generator. Deliberately runs against the ordinary non-draining
    // transport, matching the shipped SDK, where `break` cannot block on the
    // input pump.
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), rejected()],
      hangAfter: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);
    await new Promise((r) => setTimeout(r, 10));

    expect(states(events)).toEqual(["submitted", "working", "failed"]);
    expect(finished()).toBe(1);
    expect(client.calls[0].inputClosed).toBe(true);
  });

  it("releases the input stream of a held task whose CLI never wakes", async () => {
    // `hangUntilInputClosed` models a real subprocess: it outlives its scripted
    // output and only exits once stdin closes. The executor holds this task
    // open (bg1 never clears) and never gets another message, so the prompt
    // timeout is the only way out — and the input stream must still be closed
    // on the way, or the subprocess would be wedged for good.
    config.timeouts.prompt = 50;
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("waiting")],
      hangUntilInputClosed: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);
    await new Promise((r) => setTimeout(r, 10));

    expect(states(events)).toEqual(["submitted", "working", "working", "failed"]);
    expect(finished()).toBe(1);
    expect(client.calls[0].inputClosed).toBe(true);
  });

  it("publishes no second terminal event when a cancel ends the iterator cleanly", async () => {
    // `endCleanlyOnAbort` models the race where the subprocess closes its
    // stream just as the abort lands: the iterator ends normally, so none of
    // the executor's abort handling runs and the post-loop fallback is what
    // has to notice. The task is held (bg1 never clears), so nothing terminal
    // was published in the loop — exactly the state where a naive fallback
    // would emit `completed` on top of `cancelTask`'s `canceled`.
    //
    // One bus, as in production, so a contradictory pair is visible.
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("waiting")],
      hangAfter: true,
      endCleanlyOnAbort: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    const p = ex.execute(makeCtx("t1", "ctx-1"), bus);
    await new Promise((r) => setTimeout(r, 20));
    await ex.cancelTask("t1", bus);
    await p;

    expect(states(events)).toEqual(["submitted", "working", "working", "canceled"]);
    expect(finished()).toBe(1);
  });

  it("reports a timeout when the timer's abort ends the iterator cleanly", async () => {
    // Same clean-end race as the cancel test above, but reached via the prompt
    // timer. The catch's timeout branch never runs, so the post-loop block is
    // the only thing standing between this and a Task that either claims it
    // `completed` or never terminates at all.
    config.timeouts.prompt = 50;
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("waiting")],
      hangAfter: true,
      endCleanlyOnAbort: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "working", "failed"]);
    expect(finished()).toBe(1);
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

  it("emits the agent_finished bookend when the iterator ends while still held", async () => {
    // The last round's result was consumed with `{ held: true }`, which
    // suppressed the bookend, and this path never sees another result. If the
    // fallback does not close it, the Task publishes `completed` while the
    // trace stream shows `agent_started` with nothing pairing it.
    config.events = { enabled: true } as Required<AgentConfig>["events"];
    const captured: AgentEvent[] = [];
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("still waiting")],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    ex.customTransport = async (e: AgentEvent) => { captured.push(e); };
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "working", "completed"]);
    expect(captured.filter((e) => e.eventType === "agent_started")).toHaveLength(1);
    const finishedEvents = captured.filter((e) => e.eventType === "agent_finished");
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0].data).toMatchObject({ totalCostUsd: 0.01, numTurns: 1 });
  });

  it("emits the agent_finished bookend exactly once on the ordinary path", async () => {
    // The fallback re-emit must not double-fire when a round already closed
    // the bookend normally.
    config.events = { enabled: true } as Required<AgentConfig>["events"];
    const captured: AgentEvent[] = [];
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("round 1"), bgChanged(), result("round 2")],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    ex.customTransport = async (e: AgentEvent) => { captured.push(e); };

    await ex.execute(makeCtx("t1", "ctx-1"), makeBus().bus);

    expect(captured.filter((e) => e.eventType === "agent_finished")).toHaveLength(1);
  });

  it("publishes no second terminal event when the teardown throws after completing", async () => {
    // `break` awaits iterator.return(); a throw there lands in the catch after
    // `completed` was already published and `bus.finished()` already called.
    // Without the catch's `terminalPublished` guard the client gets a
    // contradictory `failed` on top of it.
    const client = new FakeClaudeClient([{
      messages: [init("s1"), bgChanged("bg1"), result("round 1"), bgChanged(), result("round 2")],
      throwOnReturn: "transport closed unexpectedly",
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "working", "completed"]);
    expect(finished()).toBe(1);
  });

  it("publishes no artifact for a success result with empty text", async () => {
    // An empty `response` artifact is noise on the wire, and a client that
    // renders every artifact shows a blank message for it.
    const client = new FakeClaudeClient([{ messages: [init("s1"), result("")] }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "completed"]);
    expect(artifacts(events)).toHaveLength(0);
    expect(finished()).toBe(1);
  });

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
});
