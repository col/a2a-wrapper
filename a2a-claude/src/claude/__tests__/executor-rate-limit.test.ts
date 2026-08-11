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
import type { AgentEvent } from "@a2a-wrapper/core";

// A2A v0.3 wire shapes: the bus receives the event object itself (no {kind,data}
// envelope), `status.state` is the lowercase-hyphen string, and a text part is
// `{ kind: "text", text }`. See event-publisher.ts in core.
interface PublishedEvent { kind?: string; status?: { state?: string; message?: unknown }; [k: string]: unknown }

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
      kind: "message", messageId: "m1", role: "user",
      parts: [{ kind: "text", text: "do the thing" }],
    },
  } as unknown as RequestContext;
}

function states(events: PublishedEvent[]): string[] {
  return events
    .filter((e) => e.kind === "status-update")
    .map((e) => e.status?.state ?? "");
}

function terminalStatus(events: PublishedEvent[]): PublishedEvent {
  const updates = events.filter((e) => e.kind === "status-update");
  return updates[updates.length - 1]!;
}

function statusText(events: PublishedEvent[]): string {
  const status = terminalStatus(events).status as {
    message?: { parts?: Array<{ kind?: string; text?: string }> };
  };
  const part = status?.message?.parts?.[0];
  return part?.kind === "text" ? part.text ?? "" : "";
}

/**
 * The tracker drops a reset time that is not in the future, so the fixture is
 * relative to now rather than a literal that eventually ages into the past.
 */
const RESETS_AT = Date.now() + 3_600_000;
const RESETS_AT_ISO = new Date(RESETS_AT).toISOString();

const REJECTED: SDKMessageLike = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "rejected", rateLimitType: "five_hour",
    resetsAt: RESETS_AT, utilization: 1,
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
  it("ends the turn as failed with reset details", async () => {
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events, finished } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(states(events)).toEqual(["submitted", "working", "failed"]);
    expect(statusText(events)).toContain("Rate limit reached (5-hour limit)");
    expect(statusText(events)).toContain(RESETS_AT_ISO);
    expect(terminalStatus(events).metadata).toMatchObject({
      reason: "rate_limit", rateLimitType: "five_hour", utilization: 1,
    });
    expect(finished()).toBe(1);
  });

  it("tears down the SDK subprocess by aborting the turn", async () => {
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);

    await ex.execute(makeCtx("t1", "ctx-1"), makeBus().bus);

    expect(client.calls[0].options.abortController?.signal.aborted).toBe(true);
  });

  it("still ends as failed when the iterator teardown throws", async () => {
    // `break` awaits iterator.return(); a rejection there lands in the catch
    // block, which must not discard an already-detected rate limit.
    for (const teardownError of ["stream closed unexpectedly", "the stream was aborted"]) {
      const client = new FakeClaudeClient([{ ...rateLimitedTurn(), throwOnReturn: teardownError }]);
      const ex = new ClaudeExecutor(config, () => client);
      const { bus, events, finished } = makeBus();

      await ex.execute(makeCtx("t1", "ctx-1"), bus);

      expect(states(events)).toEqual(["submitted", "working", "failed"]);
      expect(statusText(events)).toContain("Rate limit reached (5-hour limit)");
      expect(terminalStatus(events).metadata).toMatchObject({ reason: "rate_limit" });
      expect(finished()).toBe(1);
    }
  });

  it("does not publish a response artifact for the interrupted turn", async () => {
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(events.filter((e) => e.kind === "artifact-update")).toHaveLength(0);
  });

  it("resumes the same Claude session on a new task after the failure", async () => {
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

  it("points the client at the contextId rather than the closed task", async () => {
    const client = new FakeClaudeClient([rateLimitedTurn()]);
    const ex = new ClaudeExecutor(config, () => client);
    const { bus, events } = makeBus();

    await ex.execute(makeCtx("t1", "ctx-1"), bus);

    expect(statusText(events)).toContain("same contextId");
    expect(statusText(events)).not.toContain("this task");
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

    expect(states(events)).toEqual(["submitted", "working", "failed"]);
    expect(statusText(events)).toBe(
      "Rate limit reached. Retry on the same contextId to continue this conversation.",
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

    const artifacts = events.filter((e) => e.kind === "artifact-update");
    expect(artifacts.length).toBeGreaterThan(1);
    expect(artifacts[artifacts.length - 1]).toMatchObject({ lastChunk: true });
  });
});
