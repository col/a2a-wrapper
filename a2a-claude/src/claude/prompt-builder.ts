/**
 * Prompt Builder
 *
 * Extracts the user text from an A2A RequestContext message.
 * Joins all text parts with newlines.
 *
 * Also owns `promptStream`, the SDK input stream for one A2A Task.
 */

import type { Message as A2AMessage } from "@a2a-js/sdk";
import type { SDKUserMessageLike } from "./client-factory.js";

export function extractUserText(message: A2AMessage): string {
  return message.parts
    .filter((p) => {
      const part = p as unknown as Record<string, unknown>;
      return part.kind === "text" || "text" in part;
    })
    .map((p) => (p as unknown as { text: string }).text)
    .join("\n");
}

/**
 * The SDK input stream for one A2A Task: the user's prompt, then a park.
 *
 * Passing an async iterable (rather than a string) is what stops the SDK
 * closing the CLI's stdin on the first result, which is the only reason a
 * second turn — and therefore a background-task report — can ever arrive.
 * Resolving `closed` ends the stream, which ends the CLI's input, which lets
 * the process exit and the message iterator complete.
 *
 * The caller MUST resolve `closed` on every exit path or the generator parks
 * forever.
 */
export async function* promptStream(
  text: string,
  closed: Promise<void>,
): AsyncGenerator<SDKUserMessageLike> {
  yield { type: "user", parent_tool_use_id: null, message: { role: "user", content: text } };
  await closed;
}
