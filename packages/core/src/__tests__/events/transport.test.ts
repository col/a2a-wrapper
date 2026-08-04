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
