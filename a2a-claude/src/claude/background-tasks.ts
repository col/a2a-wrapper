/**
 * Background Task Tracker — the live set of Claude's in-flight background work.
 *
 * Consumes only `system/background_tasks_changed`, which the SDK documents as a
 * *level* signal with replace semantics: every payload carries the full set, so
 * consumers swap their set rather than pairing `task_started` /
 * `task_notification` edges. A missed bookend therefore cannot wedge a stale
 * "still running" indicator, and the SDK explicitly leaves the level's ordering
 * relative to those bookends unspecified — which is why they are ignored here.
 *
 * Entries flagged `ambient: true` are dropped. The SDK (>= 0.3.286) marks tasks
 * that are "not activity" that way — every skip_transcript task and every
 * live-update watcher, requested or auto-started — and tells hosts to exclude
 * them from activity indicators. The hold on the A2A Task is exactly such an
 * indicator, so an ambient task must never keep it open, and since the level
 * is re-emitted when an entry's flag flips, an entry turning ambient is seen
 * here as that entry leaving the set.
 *
 * The level is per-process and nothing is emitted at startup, so a tracker must
 * begin empty and be discarded when the CLI process goes away. That is enforced
 * structurally: the executor creates one tracker per query, and a query is one
 * CLI process, so instance lifetime is process lifetime.
 */

import type { SDKMessageLike } from "./client-factory.js";

/** One live background task, in the shape the A2A status metadata carries. */
export interface BackgroundTaskInfo {
  taskId: string;
  type: string;
  description: string;
}

export class BackgroundTaskTracker {
  private live = new Map<string, BackgroundTaskInfo>();

  /**
   * Fold one SDK message into the set.
   *
   * @returns `true` when set membership changed, so callers can emit a sideband
   *          event only on real transitions.
   */
  observe(msg: SDKMessageLike): boolean {
    if (msg.type !== "system" || msg.subtype !== "background_tasks_changed") return false;

    const raw = Array.isArray(msg.tasks) ? (msg.tasks as unknown[]) : [];
    const next = new Map<string, BackgroundTaskInfo>();

    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      const task = entry as Record<string, unknown>;
      if (task.ambient === true) continue;
      const taskId = typeof task.task_id === "string" ? task.task_id : "";
      if (!taskId) continue;
      next.set(taskId, {
        taskId,
        type: typeof task.task_type === "string" ? task.task_type : "unknown",
        description: typeof task.description === "string" ? task.description : "",
      });
    }

    // Equal size plus every `next` key present in `live` forces set equality
    // for finite sets (a same-size subset is the whole set), so this pair of
    // checks alone is sufficient to detect any membership change — no need to
    // walk `live`'s keys too.
    const changed =
      next.size !== this.live.size || [...next.keys()].some((id) => !this.live.has(id));
    this.live = next;
    return changed;
  }

  /** How many background tasks are live right now. */
  get size(): number {
    return this.live.size;
  }

  /** The live set, for status-update metadata. */
  snapshot(): BackgroundTaskInfo[] {
    return [...this.live.values()];
  }
}
