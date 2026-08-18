/**
 * Local response-artifact publishers that can additionally carry a structured
 * JSON data part.
 *
 * These live in a2a-claude rather than @a2a-wrapper/core because the fork's
 * published @col/a2a-claude depends on the public @a2a-wrapper/core@1.7.0,
 * which does not carry the data-part logic. Keeping it local lets the
 * structured-output feature ship in an a2a-claude-only release without
 * re-releasing core. With no structuredData, output is byte-identical to
 * core's publishFinalArtifact / publishLastChunkMarker.
 */
import type { TaskArtifactUpdateEvent, Part } from "@a2a-js/sdk";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import { v4 as uuidv4 } from "uuid";

/**
 * Build the response artifact's parts: the text part, plus — when
 * `structuredData` is a non-null, non-array object — an application/json data
 * part. Text part stays first so text-only clients are unaffected.
 */
function responseParts(text: string, structuredData?: unknown): Part[] {
  const parts: Part[] = [{ kind: "text", text }];
  if (
    typeof structuredData === "object" &&
    structuredData !== null &&
    !Array.isArray(structuredData)
  ) {
    parts.push({
      kind: "data",
      data: structuredData as Record<string, unknown>,
      metadata: { mimeType: "application/json" },
    });
  }
  return parts;
}

/** Buffered response artifact (append:false, lastChunk:true), optional data part. */
export function publishFinalArtifactWithData(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  text: string,
  structuredData?: unknown,
): void {
  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    append: false,
    lastChunk: true,
    artifact: {
      artifactId: `response-${uuidv4()}`,
      name: "response",
      parts: responseParts(text, structuredData),
    },
  };
  bus.publish(event);
}

/** Final streaming chunk marker (append:true, lastChunk:true), optional data part. */
export function publishLastChunkMarkerWithData(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  artifactId: string,
  fullText: string,
  structuredData?: unknown,
): void {
  const event: TaskArtifactUpdateEvent = {
    kind: "artifact-update",
    taskId,
    contextId,
    append: true,
    lastChunk: true,
    artifact: {
      artifactId,
      name: "response",
      parts: responseParts(fullText, structuredData),
    },
  };
  bus.publish(event);
}
