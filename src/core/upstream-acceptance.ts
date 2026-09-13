import type { GenerateAssistantResponseCommand } from "@aws/codewhisperer-streaming-client";
import { MissingSdkOutputStreamError } from "../kiro/transform/streaming/sdk-output-transformer.js";
import type { SdkStreamResponse } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import { SdkStreamProtocolError } from "../kiro/transform/streaming/sdk-stream-runtime.js";
import type { PipelineSdkClient } from "./pipeline-types.js";

export interface UpstreamHeaders {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface SdkSendOptions {
  readonly abortSignal: AbortSignal;
  readonly onResponseHeaders?: (metadata: UpstreamHeaders) => void;
}

/**
 * Smithy's EventStream decoder may await its first event before send() resolves.
 * Observe the actual HTTP response independently; defer decoding to the stream.
 * Rejected HTTP responses still await normal SDK error decoding before publication.
 */
export async function sendAcceptedStream(
  client: PipelineSdkClient,
  command: GenerateAssistantResponseCommand,
  options: SdkSendOptions,
): Promise<SdkStreamResponse> {
  const accepted = Promise.withResolvers<UpstreamHeaders>();
  const sent = Promise.resolve().then(() =>
    client.send(command, {
      ...options,
      onResponseHeaders(metadata) {
        options.onResponseHeaders?.(metadata);
        const contentType = Object.entries(metadata.headers).find(
          ([name]) => name.toLowerCase() === "content-type",
        )?.[1];
        if (
          metadata.status >= 200 &&
          metadata.status < 300 &&
          contentType?.split(";")[0]?.trim().toLowerCase() === "application/vnd.amazon.eventstream"
        ) {
          accepted.resolve(metadata);
        } else if (metadata.status >= 200 && metadata.status < 300) {
          accepted.reject(
            new SdkStreamProtocolError(
              "Upstream did not return an AWS EventStream response",
              "invalid_upstream_response",
            ),
          );
        }
      },
    }),
  );
  // Cancellation before the downstream starts reading still observes send's rejection.
  void sent.catch(() => undefined);
  const first = await Promise.race([
    sent.then((response) => ({ kind: "decoded" as const, response })),
    accepted.promise.then((metadata) => ({ kind: "accepted" as const, metadata })),
  ]);
  if (first.kind === "decoded") return first.response;
  return {
    generateAssistantResponseResponse: {
      async *[Symbol.asyncIterator]() {
        const response = await sent;
        const stream = response.generateAssistantResponseResponse;
        if (!stream) throw new MissingSdkOutputStreamError();
        yield* stream;
      },
    },
  };
}
