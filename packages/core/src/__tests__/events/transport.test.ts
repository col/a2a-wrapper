import { describe, it, expect } from "vitest";
import { A2ATransport } from "../../events/transport.js";
import type { AgentEvent, EventType } from "../../events/transport.js";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";

/**
 * `A2ATransport.send` drops any event type missing from its trace-key map, so
 * "the transport accepted the call" is not evidence a client ever saw it.
 * These tests assert on what actually reached the bus.
 */

function createMockBus() {
  const events: any[] = [];
  const bus = { publish(e: any) { events.push(e); } } as unknown as ExecutionEventBus;
  return { bus, events };
}

function event(eventType: EventType, data: Record<string, unknown> = {}): AgentEvent {
  return {
    eventId: "e1",
    eventType,
    agentId: "agent-1",
    agentName: "Agent One",
    traceId: "trace-1",
    parentAgentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data,
  };
}

describe("A2ATransport", () => {
  it("publishes background_tasks as a trace artifact on the default transport", async () => {
    const { bus, events } = createMockBus();
    const transport = new A2ATransport(bus, "task-1", "ctx-1");

    await transport.send(
      event("background_tasks", {
        backend: "claude",
        count: 1,
        tasks: [{ taskId: "bg1", type: "shell", description: "npm test" }],
      }),
    );

    expect(events).toHaveLength(1);
    const artifact = events[0].data.artifact;
    expect(artifact.name).toBe("trace.background_tasks");
    expect(artifact.metadata.traceType).toBe("trace.background_tasks");
    const part = artifact.parts[0].content;
    expect(part.$case).toBe("data");
    expect(part.value).toMatchObject({
      agent_id: "agent-1",
      backend: "claude",
      count: 1,
    });
    expect(JSON.stringify(part.value)).toContain("bg1");
  });

  it("still drops an event type with no trace-key mapping", async () => {
    const { bus, events } = createMockBus();
    const transport = new A2ATransport(bus, "task-1", "ctx-1");

    // rate_limit and context_window remain unmapped — a pre-existing gap this
    // test documents rather than fixes, so the drop is a deliberate state and
    // not an accident nobody noticed.
    await transport.send(event("rate_limit", { status: "rejected" }));
    await transport.send(event("context_window", { used: 1 }));

    expect(events).toHaveLength(0);
  });
});
