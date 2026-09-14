import type { CanonicalRequest, ResolvedReasoningReplay } from "../../protocol/canonical.js";
import { extractRegionFromArn } from "../constants.js";
import { resolveEffectiveEffort } from "../effort.js";
import { resolveOutputTokenLimit } from "../output-token-limit.js";
import type { Effort, KiroAuthDetails, SdkPreparedRequest } from "../types.js";
import { RequestTransformError } from "./errors.js";
import { buildCodeWhispererRequest } from "./request-core.js";

export interface EffortConfig {
  readonly effort?: Effort;
  readonly autoEffortMapping?: boolean;
  readonly conversationId?: string;
  readonly nativeSystemPromptEnabled?: boolean;
  readonly resolvedReasoningReplays?: readonly ResolvedReasoningReplay[];
}

export function transformToSdkRequest(
  body: CanonicalRequest,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20_000,
  effortConfig?: EffortConfig,
): SdkPreparedRequest {
  const { request, resolved, convId, systemPrompt, diagnostics } = buildCodeWhispererRequest(
    body,
    model,
    auth,
    {
      conversationId: effortConfig?.conversationId,
      nativeSystemPromptEnabled: effortConfig?.nativeSystemPromptEnabled,
      resolvedReasoningReplays: effortConfig?.resolvedReasoningReplays,
    },
  );
  const effort = resolveEffectiveEffort({
    model,
    think,
    budget,
    reasoningEffort:
      body.protocol === "responses" && body.requestedReasoningEffort === "none"
        ? "none"
        : body.reasoningEffort,
    requestFirst: body.protocol === "responses",
    configEffort: effortConfig?.effort,
    autoEffortMapping: effortConfig?.autoEffortMapping,
  });
  const outputTokenLimit = body.outputTokenLimit;
  const outputTokenProjection =
    outputTokenLimit === undefined ? undefined : resolveOutputTokenLimit(model, outputTokenLimit);
  if (outputTokenProjection?.ok === false) {
    throw new RequestTransformError(outputTokenProjection.message, outputTokenProjection.code);
  }
  const additionalModelRequestFields: Record<string, unknown> = {
    ...(outputTokenProjection?.ok === true
      ? outputTokenProjection.additionalModelRequestFields
      : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
  };

  return {
    conversationState: request.conversationState,
    ...(request.profileArn ? { profileArn: request.profileArn } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    runtimeProtocol:
      systemPrompt !== undefined ||
      body.projectionMode === "v3-auto" ||
      body.projectionMode === "native-context-safe"
        ? "kiro-runtime"
        : "codewhisperer",
    ...(Object.keys(additionalModelRequestFields).length > 0
      ? { additionalModelRequestFields }
      : {}),
    streaming: true,
    effectiveModel: resolved,
    conversationId: convId,
    region: extractRegionFromArn(auth.profileArn) ?? auth.region,
    ...(effort ? { effort } : {}),
    diagnostics,
  };
}
