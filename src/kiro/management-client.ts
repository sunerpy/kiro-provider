import { fetchProxyOption } from "../core/proxy.js";
import { KIRO_CONSTANTS } from "./constants.js";
import type { KiroAuthDetails } from "./types.js";

export type KiroSupportedInputType = "TEXT" | "IMAGE";

export interface KiroAvailableModel {
  readonly modelId: string;
  readonly modelName: string;
  readonly description?: string;
  readonly supportedInputTypes: readonly KiroSupportedInputType[];
  readonly tokenLimits: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
  };
  readonly rateMultiplier?: number;
  readonly additionalModelRequestFieldsSchema?: Readonly<Record<string, unknown>>;
}

export interface KiroAvailableModelsResponse {
  readonly defaultModelId?: string;
  readonly models: readonly KiroAvailableModel[];
}

export class KiroManagementError extends Error {
  readonly name = "KiroManagementError";

  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseModel(value: unknown): KiroAvailableModel | undefined {
  if (!isRecord(value)) return undefined;
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  const modelName = typeof value.modelName === "string" ? value.modelName.trim() : "";
  if (modelId.length === 0 || modelName.length === 0 || !isRecord(value.tokenLimits)) {
    return undefined;
  }
  const maxInputTokens = positiveInteger(value.tokenLimits.maxInputTokens);
  const maxOutputTokens = positiveInteger(value.tokenLimits.maxOutputTokens);
  if (maxInputTokens === undefined || maxOutputTokens === undefined) return undefined;
  const supportedInputTypes = Array.isArray(value.supportedInputTypes)
    ? value.supportedInputTypes.filter(
        (item): item is KiroSupportedInputType => item === "TEXT" || item === "IMAGE",
      )
    : [];
  return {
    modelId,
    modelName,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    supportedInputTypes,
    tokenLimits: { maxInputTokens, maxOutputTokens },
    ...(typeof value.rateMultiplier === "number" ? { rateMultiplier: value.rateMultiplier } : {}),
    ...(isRecord(value.additionalModelRequestFieldsSchema)
      ? { additionalModelRequestFieldsSchema: value.additionalModelRequestFieldsSchema }
      : {}),
  };
}

function parseResponse(value: unknown): KiroAvailableModelsResponse {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new KiroManagementError("Kiro model catalog response has an invalid shape");
  }
  const models = value.models.flatMap((model) => {
    const parsed = parseModel(model);
    return parsed === undefined ? [] : [parsed];
  });
  if (models.length === 0) {
    throw new KiroManagementError("Kiro model catalog response contains no valid models");
  }
  const defaultModelId =
    isRecord(value.defaultModel) && typeof value.defaultModel.modelId === "string"
      ? value.defaultModel.modelId
      : undefined;
  return {
    ...(defaultModelId !== undefined ? { defaultModelId } : {}),
    models,
  };
}

export async function listAvailableModels(
  auth: KiroAuthDetails,
  region: string,
  options: {
    readonly proxyUrl?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
): Promise<KiroAvailableModelsResponse> {
  const endpoint = new URL(`https://management.${region}.kiro.dev/`);
  endpoint.searchParams.set("origin", KIRO_CONSTANTS.ORIGIN_AI_EDITOR);
  if (auth.profileArn) endpoint.searchParams.set("profileArn", auth.profileArn);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.access}`,
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonCodeWhispererService.ListAvailableModels",
        "user-agent": KIRO_CONSTANTS.USER_AGENT,
      },
      body: JSON.stringify({
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
        ...(auth.profileArn ? { profileArn: auth.profileArn } : {}),
      }),
      signal,
      ...fetchProxyOption(options.proxyUrl),
    });
  } catch (error) {
    throw new KiroManagementError("Unable to reach the Kiro model catalog service", undefined, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new KiroManagementError(
      `Kiro model catalog returned HTTP ${response.status}`,
      response.status,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new KiroManagementError("Kiro model catalog returned invalid JSON", response.status, {
      cause: error,
    });
  }
  return parseResponse(payload);
}
