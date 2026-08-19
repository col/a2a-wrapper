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
