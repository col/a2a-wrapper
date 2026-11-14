import { describe, it, expect } from "vitest";
import { EventMapper } from "../event-mapper.js";
import { DEFAULTS } from "../../config/defaults.js";
import type { AgentConfig, FeatureFlags } from "../../config/types.js";
import type { AgentEventEmitter } from "@a2a-wrapper/core";

type Emitted = { event: string; data: Record<string, unknown> };

function makeMapper(features: Partial<FeatureFlags> = {}) {
  const emitted: Emitted[] = [];
  const emitter = {
    emit: (event: string, data: Record<string, unknown>) => { emitted.push({ event, data }); },
  } as unknown as AgentEventEmitter;
  const config = { ...DEFAULTS, features: { ...DEFAULTS.features, ...features } } as Required<AgentConfig>;
  return { mapper: new EventMapper(emitter, config), emitted };
}

describe("EventMapper", () => {
  it("replaces NUL bytes in command output with U+FFFD", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleItem(
      { type: "command_execution", id: "c1", command: "find . -print0", aggregated_output: "a\u0000b", exit_code: 0, status: "completed" },
      "completed",
    );
    expect(emitted[0].event).toBe("tool_call_end");
    const output = emitted[0].data.output as string;
    expect(output).toBe("a�b");
    expect(output.includes("\u0000")).toBe(false);
  });

  it("leaves other control characters untouched", () => {
    const { mapper, emitted } = makeMapper();
    mapper.handleItem(
      { type: "command_execution", id: "c2", command: "x", aggregated_output: "a\u0001\tb\n", status: "completed" },
      "completed",
    );
    expect(emitted[0].data.output).toBe("a\u0001\tb\n");
  });
});
