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
