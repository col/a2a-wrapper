import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventMapper, sanitizeMessage } from "../event-mapper.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig, FeatureFlags } from "../../config/types.js";
import type { AgentEventEmitter } from "@a2a-wrapper/core";

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

const assistantMsg = (blocks: unknown[]) => ({
  type: "assistant",
  message: { content: blocks },
  parent_tool_use_id: null,
});

describe("EventMapper", () => {
  it("emits agent_started on system init", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({ type: "system", subtype: "init", session_id: "s1", model: "m" });
    expect(emitted).toEqual([{ event: "agent_started", data: { backend: "claude", model: "m" } }]);
  });

  it("emits thinking sideband for thinking blocks, gated by emitThinkingEvents", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([{ type: "thinking", thinking: "hmm" }]));
    expect(emitted).toEqual([{ event: "thinking", data: { content: "hmm" } }]);

    const off = makeMapper({ emitThinkingEvents: false });
    off.mapper.handleMessage(assistantMsg([{ type: "thinking", thinking: "hmm" }]));
    expect(off.emitted).toEqual([]);
  });

  it("maps Bash tool_use to a shell tool_call_start with truncated command", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "tu1", name: "Bash", input: { command: "x".repeat(600) } },
    ]));
    expect(emitted[0].event).toBe("tool_call_start");
    expect(emitted[0].data.toolKind).toBe("shell");
    expect((emitted[0].data.command as string).length).toBe(500);
    expect(emitted[0].data.itemId).toBe("tu1");
  });

  it("maps mcp__ tool names to server/tool, flagging a2a-subagents delegation", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "tu2", name: "mcp__a2a-subagents__coding_review", input: {} },
      { type: "tool_use", id: "tu3", name: "mcp__github__list_prs", input: {} },
    ]));
    expect(emitted[0].data).toMatchObject({
      toolKind: "a2a_subagent", server: "a2a-subagents", tool: "coding_review", delegation: true,
    });
    expect(emitted[1].data).toMatchObject({ toolKind: "mcp", server: "github", tool: "list_prs" });
  });

  it("maps Edit/Write to file_change decisions (path only), gated by emitFileChangeEvents", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "t", name: "Edit", input: { file_path: "/ws/a.ts", old_string: "SECRET" } },
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/ws/b.ts", content: "data" } },
    ]));
    const changes = emitted.filter((e) => e.event === "decision");
    expect(changes[0].data).toEqual({ backend: "claude", kind: "file_change", changes: [{ path: "/ws/a.ts", kind: "edit" }] });
    expect(changes[1].data).toEqual({ backend: "claude", kind: "file_change", changes: [{ path: "/ws/b.ts", kind: "write" }] });
    // never leak contents
    expect(JSON.stringify(changes)).not.toContain("SECRET");
  });

  it("maps TodoWrite to a todo_list decision", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [
        { content: "step 1", status: "completed" },
        { content: "step 2", status: "pending" },
      ] } },
    ]));
    expect(emitted[0]).toEqual({
      event: "decision",
      data: { backend: "claude", kind: "todo_list", items: [
        { text: "step 1", completed: true },
        { text: "step 2", completed: false },
      ] },
    });
  });

  it("maps tool_result to tool_call_end with truncation and error flag", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [
        { type: "tool_result", tool_use_id: "tu1", content: "y".repeat(20_000), is_error: false },
      ] },
    });
    expect(emitted[0].event).toBe("tool_call_end");
    expect((emitted[0].data.output as string)).toContain("[truncated");
    expect(emitted[0].data.itemId).toBe("tu1");
  });

  it("suppresses tool events when emitToolEvents is false", () => {
    const { mapper, emitted } = makeMapper({ emitToolEvents: false });
    mapper.handleMessage(assistantMsg([{ type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }]));
    mapper.handleMessage({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
    expect(emitted).toEqual([]);
  });

  it("emits agent_finished with sanitized usage on result success", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({
      type: "result", subtype: "success", result: "done",
      usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.12, num_turns: 3,
    });
    expect(emitted[0]).toEqual({
      event: "agent_finished",
      data: { backend: "claude", usage: { input_tokens: 10, output_tokens: 5 }, totalCostUsd: 0.12, numTurns: 3 },
    });
  });

  it("emits agent_error on result error subtypes", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({ type: "result", subtype: "error_max_turns", errors: [], num_turns: 9 });
    expect(emitted[0].event).toBe("agent_error");
    expect(String(emitted[0].data.message)).toMatch(/max_turns|turn limit/i);
  });

  it("emits a permission_denied decision", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({ type: "system", subtype: "permission_denied", tool_name: "Bash", message: "denied by rule" });
    expect(emitted[0]).toEqual({
      event: "decision",
      data: { backend: "claude", kind: "permission_denied", tool: "Bash", message: "denied by rule" },
    });
  });

  it("ignores subagent (parent_tool_use_id != null) and unknown messages without throwing", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({ ...assistantMsg([{ type: "text", text: "sub" }]), parent_tool_use_id: "tu9" });
    mapper.handleMessage({ type: "totally_new_message_kind" });
    expect(emitted).toEqual([]);
  });

  it("redacts secrets embedded in Bash commands", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage(assistantMsg([
      { type: "tool_use", id: "t", name: "Bash", input: { command: "export API_KEY=sk-live-123 && run" } },
    ]));
    const cmd = emitted[0].data.command as string;
    expect(cmd).not.toContain("sk-live-123");
    expect(cmd).toContain("<redacted>");
  });

  it("redacts secrets embedded in tool_result output", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "DB_PASSWORD=hunter2\nother=ok" }] },
    });
    const out = emitted[0].data.output as string;
    expect(out).not.toContain("hunter2");
    expect(out).toContain("<redacted>");
  });

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

      // A second mapper (i.e. a second A2A task) must warn again — this is
      // per-instance, not process-wide, so a misconfigured deployment keeps
      // resurfacing the problem rather than going quiet after the first task.
      const second = makeMapper().mapper;
      second.handleMessage(assistantMsg([{ type: "thinking", thinking: "", signature: "Ev3" }]));
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("redacts Bearer tokens fully", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleMessage({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "Authorization: Bearer sk-ant-secret123" }] },
    });
    expect(emitted[0].data.output as string).not.toContain("sk-ant-secret123");
  });

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

  it("closes a thinking stream opened at a non-zero content_block index", () => {
    // The discriminating case for the FIFO: thinking opens at stream index 1
    // (a text block took index 0) but is reported at array position 0 of its
    // assistant message. An index lookup would search for "msg_7-0" and miss.
    const { mapper, emitted } = makeMapper({ streamArtifactChunks: true });
    mapper.handleMessage(streamEvent({ type: "message_start", message: { id: "msg_7" } }));
    mapper.handleMessage(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    mapper.handleMessage(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "prelude" } }));
    mapper.handleMessage(streamEvent({ type: "content_block_stop", index: 0 }));
    mapper.handleMessage(streamEvent({
      type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "" },
    }));
    mapper.handleMessage(streamEvent({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "later thought" } }));
    mapper.handleMessage(thinkingAssistantMsg("msg_7", "later thought"));

    expect(emitted).toEqual([
      { event: "thinking", data: { content: "later thought" }, stream: { id: "msg_7-1", lastChunk: false } },
      { event: "thinking", data: { content: "later thought" }, stream: { id: "msg_7-1", lastChunk: true } },
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
});

describe("sanitizeMessage", () => {
  it("redacts key=value secret patterns and truncates", () => {
    const out = sanitizeMessage("failed with api_key=sk-123 token: abc " + "z".repeat(3000));
    expect(out).not.toContain("sk-123");
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});
