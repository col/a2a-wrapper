import { describe, it, expect, vi, afterEach } from "vitest";
import { SessionManager } from "../session-manager.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig } from "../../config/types.js";

function mgr(session: Partial<Required<AgentConfig>["session"]> = {}): SessionManager {
  const config = { ...DEFAULTS, session: { ...DEFAULTS.session, ...session } } as Required<AgentConfig>;
  return new SessionManager(config);
}

afterEach(() => vi.useRealTimers());

describe("SessionManager", () => {
  it("creates a session with null sessionId and reuses it by contextId", () => {
    const m = mgr();
    const s1 = m.getOrCreate("ctx-1");
    expect(s1.sessionId).toBeNull();
    s1.sessionId = "sess-abc";
    const s2 = m.getOrCreate("ctx-1");
    expect(s2).toBe(s1);
    expect(s2.sessionId).toBe("sess-abc");
  });

  it("creates a fresh session when reuseByContext is false", () => {
    const m = mgr({ reuseByContext: false });
    const s1 = m.getOrCreate("ctx-1");
    const s2 = m.getOrCreate("ctx-1");
    expect(s2).not.toBe(s1);
  });

  it("expires sessions past TTL", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: 1000 });
    const s1 = m.getOrCreate("ctx-1");
    vi.advanceTimersByTime(1500);
    const s2 = m.getOrCreate("ctx-1");
    expect(s2).not.toBe(s1);
  });

  it("never expires sessions when ttl is 0", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: 0 });
    const s1 = m.getOrCreate("ctx-1");
    s1.sessionId = "sess-abc";
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000); // one week
    const s2 = m.getOrCreate("ctx-1");
    expect(s2).toBe(s1);
    expect(s2.sessionId).toBe("sess-abc");
  });

  it("treats a negative ttl as disabled", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: -1 });
    const s1 = m.getOrCreate("ctx-1");
    vi.advanceTimersByTime(86_400_000);
    expect(m.getOrCreate("ctx-1")).toBe(s1);
  });

  it("tracks, retrieves, and untracks executions", () => {
    const m = mgr();
    const ac = new AbortController();
    m.trackExecution("t1", "ctx-1", ac);
    expect(m.getExecution("t1")?.abortController).toBe(ac);
    expect(m.getActiveTasksForContext("ctx-1")).toEqual(["t1"]);
    m.untrackExecution("t1");
    expect(m.getExecution("t1")).toBeUndefined();
  });

  it("attaches a query handle to an active execution", async () => {
    const m = mgr();
    m.trackExecution("t1", "ctx-1", new AbortController());
    const fakeQuery = { interrupt: async () => {}, [Symbol.asyncIterator]: async function* () {} };
    m.attachQuery("t1", fakeQuery);
    expect(m.getExecution("t1")?.query).toBe(fakeQuery);
  });

  it("cleanup removes stale sessions but skips those with active executions", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: 1000 });
    const stale = m.getOrCreate("ctx-stale");
    const busy = m.getOrCreate("ctx-busy");
    m.trackExecution("t-busy", "ctx-busy", new AbortController());
    m.startCleanup(500, 1000);
    vi.advanceTimersByTime(2000);
    m.stopCleanup();
    expect(m.getOrCreate("ctx-stale")).not.toBe(stale); // was cleaned
    expect(m.getOrCreate("ctx-busy")).toBe(busy);       // was preserved
  });

  it("does not evict during cleanup when ttl is 0", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: 0 });
    const s1 = m.getOrCreate("ctx-1");
    m.startCleanup(500, 0);
    vi.advanceTimersByTime(60_000);
    m.stopCleanup();
    expect(m.getOrCreate("ctx-1")).toBe(s1);
  });

  it("installs no cleanup timer when ttl is 0", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: 0 });
    m.startCleanup(500, 0);
    expect(vi.getTimerCount()).toBe(0);
    m.stopCleanup();
  });

  it("treats an unset ttl as disabled in both eviction paths", () => {
    vi.useFakeTimers();
    const m = mgr({ ttl: undefined });
    const s1 = m.getOrCreate("ctx-1");
    m.startCleanup(500, 0);
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    m.stopCleanup();
    expect(m.getOrCreate("ctx-1")).toBe(s1);
  });
});
