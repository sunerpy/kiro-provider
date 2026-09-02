import type { KiroAuthDetails } from "../src/kiro/types.js";
import type {
  CanonicalContentPart,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalRole,
  CanonicalTextPart,
  CanonicalToolDeclaration,
} from "../src/protocol/canonical.js";
import { parseResponsesRequest, type ResponsesRequest } from "../src/server/request-schema.js";

export const TEST_MODEL = "gpt-5.6-sol";

export const TEST_AUTH: KiroAuthDetails = {
  refresh: "refresh-token",
  access: "access-token",
  expires: Date.now() + 60_000,
  authMethod: "desktop",
  region: "us-east-1",
};

export function textPart(text: string, path = "content.0"): CanonicalTextPart {
  return { type: "text", text, path };
}

export function message(
  role: CanonicalRole,
  content: readonly CanonicalContentPart[] | string,
  path = "messages.0",
): CanonicalMessage {
  return {
    role,
    content: typeof content === "string" ? [textPart(content, `${path}.content`)] : content,
    toolCalls: [],
    path,
  };
}

export function functionTool(
  name: string,
  path = "tools.0",
  inputSchema: Readonly<Record<string, unknown>> = { type: "object" },
): CanonicalToolDeclaration {
  return {
    publicType: "function",
    name,
    wireName: name,
    inputSchema,
    path,
  };
}

export function canonicalRequest(
  messages: readonly CanonicalMessage[],
  overrides: Partial<CanonicalRequest> = {},
): CanonicalRequest {
  return {
    canonicalVersion: 1,
    protocol: "responses",
    projectionMode: "safe",
    model: TEST_MODEL,
    stream: false,
    messages,
    tools: [],
    toolChoice: "auto",
    reasoningReplays: [],
    includeEncryptedReasoning: false,
    ...overrides,
  };
}

export function parsedResponses(raw: unknown): ResponsesRequest {
  const parsed = parseResponsesRequest(raw);
  if (!parsed.ok) {
    throw new TypeError("Expected a valid Responses request");
  }
  return parsed.value;
}
