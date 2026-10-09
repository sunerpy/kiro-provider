import { auditLog } from "../../../core/audit-log.js";
import type { RequestDiagnostics } from "../../../core/request-diagnostics.js";
import type { SdkStreamEvent } from "./sdk-stream-runtime.js";

/** Observes opaque values in memory; only enums, positions and lengths leave it. */
export function createReasoningSignatureObserver(
  model: string,
  diagnostics?: RequestDiagnostics,
): (event: SdkStreamEvent) => void {
  let rawEventIndex = 0;
  let reasoningEventIndex = 0;
  let signatureEventIndex = 0;
  let previousSignature: string | undefined;
  let reasoningChars = 0;
  let charsAtPreviousSignature = 0;
  let assistantOutput = false;
  return (event) => {
    rawEventIndex++;
    const material = event.reasoningContentEvent;
    if (material !== undefined) {
      reasoningEventIndex++;
      reasoningChars += material.text?.length ?? 0;
      const signature = material.signature;
      if (signature !== undefined && signature.length > 0) {
        const relation =
          previousSignature === undefined
            ? "first"
            : signature === previousSignature
              ? "duplicate"
              : signature.startsWith(previousSignature)
                ? "extends"
                : previousSignature.startsWith(signature)
                  ? "shorter-prefix"
                  : "distinct";
        auditLog("info", "sdk_reasoning_signature_observed", {
          ...(diagnostics ? { request_id: diagnostics.requestId } : {}),
          model,
          raw_event_index: rawEventIndex,
          reasoning_event_index: reasoningEventIndex,
          signature_event_index: ++signatureEventIndex,
          signature_bytes: Buffer.byteLength(signature, "utf8"),
          previous_signature_bytes:
            previousSignature === undefined ? 0 : Buffer.byteLength(previousSignature, "utf8"),
          signature_relation: relation,
          reasoning_chars: reasoningChars,
          event_reasoning_chars: material.text?.length ?? 0,
          reasoning_chars_since_signature: reasoningChars - charsAtPreviousSignature,
          phase: assistantOutput ? "after-assistant" : "before-assistant",
        });
        previousSignature = signature;
        charsAtPreviousSignature = reasoningChars;
      }
    }
    assistantOutput ||=
      Boolean(event.assistantResponseEvent?.content) || event.toolUseEvent !== undefined;
  };
}
