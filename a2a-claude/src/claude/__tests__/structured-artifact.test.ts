import { describe, it, expect } from "vitest";
import { publishFinalArtifactWithData, publishLastChunkMarkerWithData } from "../structured-artifact.js";

function mockBus() {
  const events: any[] = [];
  return { bus: { publish: (e: any) => events.push(e) } as any, events };
}

describe("structured-artifact publishers", () => {
  it("appends a data part when structuredData is an object (final artifact)", () => {
    const { bus, events } = mockBus();
    const data = { answer: "42", ok: true };
    publishFinalArtifactWithData(bus, "t1", "c1", "text body", data);
    const parts = events[0].artifact.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ kind: "text", text: "text body" });
    expect(parts[1].kind).toBe("data");
    expect(parts[1].data).toEqual(data);
    expect(parts[1].metadata).toEqual({ mimeType: "application/json" });
    expect(events[0].append).toBe(false);
    expect(events[0].lastChunk).toBe(true);
  });

  it("stays text-only when structuredData is omitted (final artifact)", () => {
    const { bus, events } = mockBus();
    publishFinalArtifactWithData(bus, "t1", "c1", "text body");
    expect(events[0].artifact.parts).toEqual([{ kind: "text", text: "text body" }]);
  });

  it("appends a data part on the last-chunk marker", () => {
    const { bus, events } = mockBus();
    const data = { answer: "42" };
    publishLastChunkMarkerWithData(bus, "t1", "c1", "art-1", "full text", data);
    const parts = events[0].artifact.parts;
    expect(parts).toHaveLength(2);
    expect(parts[1].data).toEqual(data);
    expect(events[0].artifact.artifactId).toBe("art-1");
    expect(events[0].append).toBe(true);
    expect(events[0].lastChunk).toBe(true);
  });

  it("ignores a non-object (array) structuredData", () => {
    const { bus, events } = mockBus();
    publishFinalArtifactWithData(bus, "t1", "c1", "body", [1, 2, 3]);
    expect(events[0].artifact.parts).toEqual([{ kind: "text", text: "body" }]);
  });
});
