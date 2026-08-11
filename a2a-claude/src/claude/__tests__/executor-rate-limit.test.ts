import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeExecutor } from "../executor.js";
import { FakeClaudeClient } from "./fake-client.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";
import type { SDKMessageLike } from "../client-factory.js";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";
import type { AgentEvent } from "@a2a-wrapper/core";

const STATE_NAME: Partial<Record<TaskState, string>> = {
  [TaskState.TASK_STATE_SUBMITTED]: "submitted",
  [TaskState.TASK_STATE_WORKING]: "working",
  [TaskState.TASK_STATE_INPUT_REQUIRED]: "input-required",
  [TaskState.TASK_STATE_COMPLETED]: "completed",
  [TaskState.TASK_STATE_FAILED]: "failed",
  [TaskState.TASK_STATE_AUTH_REQUIRED]: "auth-required",
};

interface PublishedEvent { kind?: string; data?: Record<string, unknown>; [k: string]: unknown }

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

function makeCtx(taskId: string, contextId: string): RequestContext {
  return {
    taskId, contextId, task: undefined,
    userMessage: {
      messageId: "m1", contextId, taskId, role: 1,
      parts: [{ content: { $case: "text", value: "do the thing" }, metadata: undefined }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    },
  } as unknown as RequestContext;
}

function states(events: PublishedEvent[]): string[] {
  return events
    .filter((e) => e.kind === "statusUpdate")
    .map((e) => STATE_NAME[(e.data?.status as { state?: TaskState })?.state as TaskState] ?? "");
}

function terminalStatus(events: PublishedEvent[]): Record<string, unknown> {
  const updates = events.filter((e) => e.kind === "statusUpdate");
  return updates[updates.length - 1]!.data as Record<string, unknown>;
}

/**
 * A2A v1.0 wraps a text part as `{ content: { $case: "text", value } }` rather
 * than the v0.3 `{ text }` — see event-publisher.ts's module doc in core.
 */
function statusText(events: PublishedEvent[]): string {
  const status = terminalStatus(events).status as {
    message?: { parts?: Array<{ content?: { $case?: string; value?: string } }> };
  };
  const part = status?.message?.parts?.[0]?.content;
  return part?.$case === "text" ? part.value ?? "" : "";
}

const REJECTED: SDKMessageLike = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected", rateLimitType: "five_hour",
    resetsAt: Date.UTC(2026, 7, 11, 18, 0, 0), utilization: 1,
  },
};

/** init -> assistant text -> rate limit rejection -> then hangs until aborted. */
function rateLimitedTurn() {
  return {
    messages: [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-test" },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "partial" }] } },
      REJECTED,
    ] as SDKMessageLike[],
    hangAfter: true,
  };
}

let ws: string;
let config: Required<AgentConfig>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "a2a-claude-ws-"));
  config = JSON.parse(JSON.stringify({ ...DEFAULTS, configDir: ws })) as Required<AgentConfig>;
  config.claude.workingDirectory = ws;
  config.events = { enabled: false } as Required<AgentConfig>["events"];
});

afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe("ClaudeExecutor rate limit handling", () => {
  it("ends the turn as input-required with reset details", async () => {
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "input-required"]);
    expect(statusText(events)).toContain("Rate limit reached (5-hour limit)");
    expect(statusText(events)).toContain("2026-08-11T18:00:00.000Z");
    expect(terminalStatus(events).metadata).toMatchObject({
      reason: "rate_limit", rateLimitType: "five_hour", utilization: 1,
    });
    expect(finished()).toBe(1);
  });

  it("does not publish a response artifact for the interrupted turn", async () => {
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(events.filter((e) => e.kind === "artifactUpdate")).toHaveLength(0);
  });

  it("keeps the session resumable on the next turn", async () => {
    const client = new FakeClaudeClient([
      rateLimitedTurn(),
      {
        messages: [
          { type: "system", subtype: "init", session_id: "sess-1", model: "claude-test" },
          { type: "result", subtype: "success", result: "done", session_id: "sess-1" },
        ] as SDKMessageLike[],
      },
    ]);
    const ex = new ClaudeExecutor(config, () => client);

    await ex.execute(makeCtx("t1", "ctx-1"), makeBus().bus);
    await ex.execute(makeCtx("t2", "ctx-1"), makeBus().bus);

    expect(client.calls[1].options.resume).toBe("sess-1");
  });

  it("honours rateLimit.taskState: failed", async () => {
    config.rateLimit = { taskState: "failed" };
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "failed"]);
    expect(statusText(events)).toContain("same contextId");
  });

  it("omits the reset clause when the SDK reports no reset time", async () => {
    const client = new FakeClaudeClient([{
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        { type: "assistant", error: "rate_limit", parent_tool_use_id: null, message: { content: [] } },
      ] as SDKMessageLike[],
      hangAfter: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "input-required"]);
    expect(statusText(events)).toBe(
      "Rate limit reached. Send another message on this task to continue.",
    );
    expect(terminalStatus(events).metadata).not.toHaveProperty("resetsAt");
  });

  it("lets a warning through without ending the turn", async () => {
    const client = new FakeClaudeClient([{
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.9 } },
        { type: "result", subtype: "success", result: "finished anyway", session_id: "s" },
      ] as SDKMessageLike[],
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "completed"]);
    expect(JSON.stringify(events)).toContain("finished anyway");
  });

  it("emits a rate_limit sideband event", async () => {
    config.events = { enabled: true } as Required<AgentConfig>["events"];
    const captured: AgentEvent[] = [];
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    ex.customTransport = async (e: AgentEvent) => { captured.push(e); };

    await ex.execute(makeCtx("t1", "ctx-1"), makeBus().bus);

    const rl = captured.filter((e) => e.eventType === "rate_limit");
    expect(rl).toHaveLength(1);
    expect(rl[0].data).toMatchObject({ status: "rejected", action: "ended_turn" });
  });

  it("terminates a streaming artifact that was already in flight", async () => {
    config.features.streamArtifactChunks = true;
    const client = new FakeClaudeClient([{
      messages: [
        { type: "system", subtype: "init", session_id: "s", model: "m" },
        {
          type: "stream_event", parent_tool_use_id: null,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial " } },
        },
        REJECTED,
      ] as SDKMessageLike[],
      hangAfter: true,
    }]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    const artifacts = events.filter((e) => e.kind === "artifactUpdate");
    expect(artifacts.length).toBeGreaterThan(1);
    expect(artifacts[artifacts.length - 1].data).toMatchObject({ lastChunk: true });
  });
});
