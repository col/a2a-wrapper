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
  /** SDK error code, e.g. "credits_required" — waiting for a reset won't help. */
  errorCode?: string;
  canPurchaseCredits?: boolean;
  /** SDK internal retry counters. Populated only for `source: "api_retry"`. */
  retry?: { attempt?: number; maxRetries?: number; delayMs?: number };
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
  const ms = value < MS_THRESHOLD ? value * 1000 : value;
  // A reset already in the past tells the client nothing useful; rendering
  // "Resets at 2019-…" is worse than dropping the clause, and dropping matches
  // the rest of this module's policy of never fabricating limit details.
  return ms > Date.now() ? ms : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
      // The SDK's own retry counters are what an operator needs to recognise a
      // retry storm burning the prompt window.
      const retry = {
        attempt: readNumber(msg.attempt),
        maxRetries: readNumber(msg.max_retries),
        delayMs: readNumber(msg.retry_delay_ms),
      };
      const hasRetryDetail = Object.values(retry).some((v) => v !== undefined);
      return {
        kind: "warning",
        snapshot: this.derive("allowed_warning", "api_retry", hasRetryDetail ? retry : undefined),
      };
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
      errorCode: readString(info.errorCode),
      canPurchaseCredits: readBoolean(info.canUserPurchaseCredits),
      source: "rate_limit_event",
    };
    this.last = snapshot;

    if (snapshot.status === "rejected") {
      // The SDK documents no precedence between `status` and `overageStatus`,
      // so when the base window is exhausted but overage is still open the
      // request may well proceed on overage credits. Be permissive: if overage
      // might carry the request we let the turn continue, and if it genuinely
      // fails the assistant `error: "rate_limit"` path still ends the turn
      // correctly. Being permissive costs a slightly later turn end; being
      // aggressive kills turns that would have succeeded.
      const overage = info.overageStatus;
      if (overage === "allowed" || overage === "allowed_warning") {
        return { kind: "warning", snapshot };
      }
      return { kind: "rejected", snapshot };
    }
    if (snapshot.status === "allowed_warning") return { kind: "warning", snapshot };
    return NONE;
  }

  /**
   * Build a snapshot for a signal that carries no limit details of its own.
   *
   * Details are inherited only from a `rate_limit_event` that actually reported
   * pressure: a bucket last seen at 20% utilization tells us nothing about
   * whichever limit just rejected us, and naming it would fabricate a limit
   * type and reset time the client would act on. Utilization is never carried
   * — a stale figure sitting next to a rejection contradicts itself.
   *
   * Read-only by design: writing back to `this.last` would make an inherited
   * value the basis for the next derive, propagating one stale limit type
   * indefinitely across a run of `api_retry` messages.
   */
  private derive(
    status: RateLimitStatus,
    source: RateLimitSnapshot["source"],
    retry?: RateLimitSnapshot["retry"],
  ): RateLimitSnapshot {
    const prev = this.last;
    const inherit = prev?.status === "allowed_warning" || prev?.status === "rejected";
    return {
      status,
      ...(inherit ? { rateLimitType: prev?.rateLimitType, resetsAt: prev?.resetsAt } : {}),
      ...(retry !== undefined ? { retry } : {}),
      source,
    };
  }
}

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
export function renderRateLimitMessage(snapshot: RateLimitSnapshot): string {
  // Credits exhausted is not a clock problem: no reset time will restore
  // capacity, so naming one would send the client off to wait for nothing.
  const creditsRequired = snapshot.errorCode === "credits_required";
  const label = snapshot.rateLimitType ? RATE_LIMIT_TYPE_LABELS[snapshot.rateLimitType] : undefined;
  const parts: string[] = creditsRequired
    ? ["Rate limit reached — additional credits are required to continue."]
    : [label ? `Rate limit reached (${label}).` : "Rate limit reached."];

  if (!creditsRequired && snapshot.resetsAt !== undefined) {
    parts.push(`Resets at ${new Date(snapshot.resetsAt).toISOString()}.`);
  }

  // The task is always terminal: the SDK cannot resume an interrupted turn, so
  // a follow-up is a new prompt either way. Continuity comes from the contextId
  // → Claude session mapping, not from holding the task open.
  parts.push("Retry on the same contextId to continue this conversation.");

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
  if (snapshot.errorCode !== undefined) meta.errorCode = snapshot.errorCode;
  if (snapshot.canPurchaseCredits !== undefined) meta.canPurchaseCredits = snapshot.canPurchaseCredits;
  return meta;
}
