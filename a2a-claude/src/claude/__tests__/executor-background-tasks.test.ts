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
