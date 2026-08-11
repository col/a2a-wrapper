/**
 * Rate Limit Tracker — Claude SDK rate-limit signal detection
 *
 * Turns raw SDK messages into a verdict about whether the current turn can
 * continue. Detection lives here rather than in EventMapper on purpose: that
 * class is pure observability and swallows its own exceptions by design, so
 * turn-ending control flow must not depend on it.
 *
 * Rate limit info is only populated for claude.ai subscription auth. Under API
 * key, Bedrock, or Vertex the SDK never emits `rate_limit_event`, so the
 * assistant-message error is the only signal available and no reset time exists.
 */

import type { SDKMessageLike } from "./client-factory.js";

export type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";

export interface RateLimitSnapshot {
  status: RateLimitStatus;
  /** e.g. five_hour, seven_day, seven_day_opus. Absent when the SDK omits it. */
  rateLimitType?: string;
  /** Epoch milliseconds. Undefined when no reset time was reported. */
  resetsAt?: number;
  utilization?: number;
  source: "rate_limit_event" | "assistant_error" | "api_retry";
}

export type RateLimitVerdict =
  | { kind: "none" }
  | { kind: "warning"; snapshot: RateLimitSnapshot }
  | { kind: "rejected"; snapshot: RateLimitSnapshot };

const NONE: RateLimitVerdict = { kind: "none" };

/**
 * The SDK types `resetsAt` as a bare number with no unit, so discriminate by
 * magnitude: 1e12 ms is 2001-09-09, while a plausible reset expressed in
 * seconds is ~1.8e9. Anything below the threshold is therefore seconds.
 */
const MS_THRESHOLD = 1e12;

function normalizeResetsAt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < MS_THRESHOLD ? value * 1000 : value;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isStatus(value: unknown): value is RateLimitStatus {
  return value === "allowed" || value === "allowed_warning" || value === "rejected";
}

export class RateLimitTracker {
  private last: RateLimitSnapshot | null = null;

  /** Most recent known limit state, for metadata on a later rejection. */
  get snapshot(): RateLimitSnapshot | null {
    return this.last;
  }

  observe(msg: SDKMessageLike): RateLimitVerdict {
    if (msg.type === "rate_limit_event") return this.observeLimitEvent(msg);

    if (msg.type === "system" && msg.subtype === "api_retry" && msg.error === "rate_limit") {
      return { kind: "warning", snapshot: this.derive("allowed_warning", "api_retry") };
    }

    if (msg.type === "assistant" && msg.error === "rate_limit") {
      return { kind: "rejected", snapshot: this.derive("rejected", "assistant_error") };
    }

    return NONE;
  }

  private observeLimitEvent(msg: SDKMessageLike): RateLimitVerdict {
    const info = msg.rate_limit_info as Record<string, unknown> | undefined;
    if (!info || typeof info !== "object") return NONE;
    if (!isStatus(info.status)) return NONE;

    const snapshot: RateLimitSnapshot = {
      status: info.status,
      rateLimitType: readString(info.rateLimitType),
      resetsAt: normalizeResetsAt(info.resetsAt),
      utilization: readNumber(info.utilization),
      source: "rate_limit_event",
    };
    this.last = snapshot;

    if (snapshot.status === "rejected") return { kind: "rejected", snapshot };
    if (snapshot.status === "allowed_warning") return { kind: "warning", snapshot };
    return NONE;
  }

  /**
   * Build a snapshot for a signal that carries no limit details of its own,
   * inheriting whatever the last `rate_limit_event` told us.
   */
  private derive(status: RateLimitStatus, source: RateLimitSnapshot["source"]): RateLimitSnapshot {
    const snapshot: RateLimitSnapshot = {
      status,
      rateLimitType: this.last?.rateLimitType,
      resetsAt: this.last?.resetsAt,
      utilization: this.last?.utilization,
      source,
    };
    this.last = snapshot;
    return snapshot;
  }
}

/** A2A task states this wrapper is willing to publish for a rate limit. */
export type RateLimitTaskState = "input-required" | "failed" | "auth-required";

const RATE_LIMIT_TYPE_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "7-day limit",
  seven_day_opus: "7-day Opus limit",
  seven_day_sonnet: "7-day Sonnet limit",
  seven_day_overage_included: "7-day limit (overage included)",
  overage: "overage limit",
};

/**
 * Human-readable status text. An unknown limit type drops the parenthetical
 * rather than leaking a raw enum, and an unknown reset time drops the clause
 * rather than printing a fabricated one.
 */
export function renderRateLimitMessage(
  snapshot: RateLimitSnapshot,
  taskState: RateLimitTaskState,
): string {
  const label = snapshot.rateLimitType ? RATE_LIMIT_TYPE_LABELS[snapshot.rateLimitType] : undefined;
  const parts: string[] = [label ? `Rate limit reached (${label}).` : "Rate limit reached."];

  if (snapshot.resetsAt !== undefined) {
    parts.push(`Resets at ${new Date(snapshot.resetsAt).toISOString()}.`);
  }

  // A terminal task cannot accept another message, so the prose must not say it can.
  parts.push(
    taskState === "failed"
      ? "Retry on the same contextId to continue this conversation."
      : "Send another message on this task to continue.",
  );

  return parts.join(" ");
}

/** Machine-readable equivalent, for orchestrators that schedule their own retry. */
export function rateLimitMetadata(snapshot: RateLimitSnapshot): Record<string, unknown> {
  const meta: Record<string, unknown> = { reason: "rate_limit", source: snapshot.source };
  if (snapshot.rateLimitType !== undefined) meta.rateLimitType = snapshot.rateLimitType;
  if (snapshot.resetsAt !== undefined) {
    meta.resetsAt = snapshot.resetsAt;
    meta.resetsAtIso = new Date(snapshot.resetsAt).toISOString();
  }
  if (snapshot.utilization !== undefined) meta.utilization = snapshot.utilization;
  return meta;
}
