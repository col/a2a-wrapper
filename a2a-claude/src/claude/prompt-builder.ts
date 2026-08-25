/**
 * Prompt Builder
 *
 * Re-exports the shared `extractUserText` helper from `@a2a-wrapper/core`
 * (see `packages/core/src/events/part-utils.ts`) so this wrapper's
 * import paths stay stable. Inbound `Part` parsing is an A2A protocol
 * concern and lives in core, not here.
 *
 * Also owns `promptStream`, the SDK input stream for one A2A Task.
 */

import type { SDKUserMessageLike } from "./client-factory.js";

export { extractUserText } from "@a2a-wrapper/core";

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
