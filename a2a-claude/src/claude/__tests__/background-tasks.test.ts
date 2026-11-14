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

// SDK >= 0.3.286 marks tasks that are "not activity" (skip_transcript tasks and
// live-update watchers, requested or auto-started) with `ambient: true` and tells
// hosts to exclude them from activity indicators. The hold is an activity
// indicator, so an ambient task must never keep an A2A Task open.
describe("BackgroundTaskTracker ambient tasks", () => {
  function changedWith(
    ...tasks: Array<{ id: string; ambient?: boolean }>
  ): SDKMessageLike {
    return {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: tasks.map(({ id, ambient }) => ({
        task_id: id,
        task_type: "monitor",
        description: `task ${id}`,
        ...(ambient === undefined ? {} : { ambient }),
      })),
    };
  }

  it("excludes ambient tasks from the live set", () => {
    const t = new BackgroundTaskTracker();
    t.observe(changedWith({ id: "watcher", ambient: true }, { id: "work", ambient: false }));
    expect(t.size).toBe(1);
    expect(t.snapshot().map((x) => x.taskId)).toEqual(["work"]);
  });

  it("treats an ambient-only set as empty", () => {
    const t = new BackgroundTaskTracker();
    t.observe(changedWith({ id: "watcher", ambient: true }));
    expect(t.size).toBe(0);
    expect(t.snapshot()).toEqual([]);
  });

  it("counts an entry turning ambient as a membership change", () => {
    const t = new BackgroundTaskTracker();
    expect(t.observe(changedWith({ id: "a" }))).toBe(true);
    expect(t.observe(changedWith({ id: "a", ambient: true }))).toBe(true);
    expect(t.size).toBe(0);
  });

  it("does not report a change when only ambient entries come and go", () => {
    const t = new BackgroundTaskTracker();
    t.observe(changedWith({ id: "work" }));
    expect(t.observe(changedWith({ id: "work" }, { id: "watcher", ambient: true }))).toBe(false);
    expect(t.observe(changedWith({ id: "work" }))).toBe(false);
  });
});
