import { fetchProxyOption } from "../core/proxy.js";
import { KIRO_CONSTANTS } from "./constants.js";
import type { KiroAuthDetails } from "./types.js";

export type KiroSupportedInputType = "TEXT" | "IMAGE";

export interface KiroPromptCachingCapability {
  readonly supportsPromptCaching: boolean;
  readonly maximumCacheCheckpointsPerRequest?: number;
  readonly minimumTokensPerCacheCheckpoint?: number;
}

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
  readonly promptCaching?: KiroPromptCachingCapability;
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
  const promptCaching = isRecord(value.promptCaching)
    ? {
        supportsPromptCaching: value.promptCaching.supportsPromptCaching === true,
        ...(positiveInteger(value.promptCaching.maximumCacheCheckpointsPerRequest) !== undefined
          ? {
              maximumCacheCheckpointsPerRequest: positiveInteger(
                value.promptCaching.maximumCacheCheckpointsPerRequest,
              ) as number,
            }
          : {}),
        ...(positiveInteger(value.promptCaching.minimumTokensPerCacheCheckpoint) !== undefined
          ? {
              minimumTokensPerCacheCheckpoint: positiveInteger(
                value.promptCaching.minimumTokensPerCacheCheckpoint,
              ) as number,
            }
          : {}),
      }
    : undefined;
  return {
    modelId,
    modelName,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    supportedInputTypes,
    tokenLimits: { maxInputTokens, maxOutputTokens },
    ...(typeof value.rateMultiplier === "number" ? { rateMultiplier: value.rateMultiplier } : {}),
    ...(promptCaching !== undefined ? { promptCaching } : {}),
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

export interface KiroAvailableProfile {
  readonly arn: string;
  readonly profileName?: string;
  readonly startUrl?: string;
  readonly status?: string;
}

type KiroAvailableProfilesPage = {
  readonly profiles: readonly KiroAvailableProfile[];
  readonly nextToken?: string;
};

const MAX_PROFILE_PAGES = 10;

function parseProfile(value: unknown): KiroAvailableProfile | undefined {
  if (!isRecord(value)) return undefined;
  const arn = typeof value.arn === "string" ? value.arn.trim() : "";
  if (!/^arn:[^:]+:codewhisperer:[^:]+:[^:]+:profile\/.+$/u.test(arn)) return undefined;
  const profileName = typeof value.profileName === "string" ? value.profileName.trim() : "";
  const startUrl = typeof value.startUrl === "string" ? value.startUrl.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim() : "";
  return {
    arn,
    ...(profileName ? { profileName } : {}),
    ...(startUrl ? { startUrl } : {}),
    ...(status ? { status } : {}),
  };
}

function parseProfilesPage(value: unknown): KiroAvailableProfilesPage {
  if (!isRecord(value) || !Array.isArray(value.profiles)) {
    throw new KiroManagementError("Kiro profile catalog response has an invalid shape");
  }
  const profiles: KiroAvailableProfile[] = [];
  for (const profile of value.profiles) {
    const parsed = parseProfile(profile);
    if (parsed === undefined) {
      throw new KiroManagementError("Kiro profile catalog response contains an invalid profile");
    }
    profiles.push(parsed);
  }
  if (
    value.nextToken !== undefined &&
    value.nextToken !== null &&
    typeof value.nextToken !== "string"
  ) {
    throw new KiroManagementError("Kiro profile catalog response has an invalid next token");
  }
  return {
    profiles,
    ...(typeof value.nextToken === "string" && value.nextToken.length > 0
      ? { nextToken: value.nextToken }
      : {}),
  };
}

export async function listAvailableProfiles(
  auth: KiroAuthDetails,
  region: string,
  options: {
    readonly proxyUrl?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {},
): Promise<readonly KiroAvailableProfile[]> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const endpoint = new URL(`https://management.${region}.kiro.dev/List-Available-Profiles`);
  const profiles: KiroAvailableProfile[] = [];
  const seenTokens = new Set<string>();
  let nextToken: string | undefined;

  for (let page = 0; page < MAX_PROFILE_PAGES; page += 1) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${auth.access}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "user-agent": KIRO_CONSTANTS.USER_AGENT,
          "amz-sdk-request": "attempt=1; max=1",
        },
        body: JSON.stringify(nextToken === undefined ? {} : { nextToken }),
        ...fetchProxyOption(options.proxyUrl),
      });
    } catch (error) {
      throw new KiroManagementError("Unable to reach the Kiro profile catalog service", undefined, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new KiroManagementError(
        `Kiro profile catalog returned HTTP ${response.status}`,
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new KiroManagementError("Kiro profile catalog returned invalid JSON", response.status, {
        cause: error,
      });
    }
    const parsed = parseProfilesPage(payload);
    profiles.push(...parsed.profiles);
    if (parsed.nextToken === undefined) return profiles;
    if (seenTokens.has(parsed.nextToken)) {
      throw new KiroManagementError("Kiro profile catalog repeated a pagination token");
    }
    seenTokens.add(parsed.nextToken);
    nextToken = parsed.nextToken;
  }

  throw new KiroManagementError(`Kiro profile catalog exceeded ${MAX_PROFILE_PAGES} pages`);
}
