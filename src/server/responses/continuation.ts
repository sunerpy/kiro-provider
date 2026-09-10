import { z } from "zod";
import { RegionSchema } from "../../kiro/regions.js";
import { type CanonicalRequest, isCanonicalRequest } from "../../protocol/canonical.js";
import { ResponsesInputItemSchema, ResponsesRequestSchema } from "../request-schema.js";
import type { ResponseStateObject } from "./state.js";

const ToolIdentitySchema = z.union([
  z.object({ kind: z.enum(["function", "custom"]), name: z.string() }),
  z.object({
    kind: z.literal("namespace"),
    namespace: z.string(),
    name: z.string(),
    toolType: z.enum(["function", "custom"]),
  }),
]);
// Stored output can legitimately contain an incomplete call. Preserve its bytes;
// executable request validation happens when a caller attempts to replay it.
const RecordedItemSchema = z.union([
  z.object({ type: z.string() }).passthrough(),
  ResponsesInputItemSchema,
]);

export const ResponseContinuationSchema = z.object({
  transport: z.enum(["native", "native-adapted", "stateless"]),
  request: ResponsesRequestSchema,
  /** V1 had only canonical history; retain those facts without inventing wire items. */
  legacyRequest: z.custom<CanonicalRequest>(isCanonicalRequest).optional(),
  owner: z
    .object({
      accountId: z.string().min(1),
      region: RegionSchema,
      profileArn: z.string().optional(),
      responseId: z.string().min(1),
    })
    .optional(),
  instruction: z.object({ role: z.enum(["system", "developer"]), text: z.string() }).optional(),
  tools: z.array(z.object({ wireName: z.string(), identity: ToolIdentitySchema })).optional(),
  /** Complete logical assistant output, including private opaque replay attachments. */
  output: z.array(RecordedItemSchema).optional(),
  /** Exact wire history for runtimes that accept but do not implement previous_response_id. */
  nativeReplay: z
    .object({
      input: z.array(RecordedItemSchema),
      output: z.array(RecordedItemSchema),
    })
    .optional(),
});

export type ResponseContinuationContext = z.infer<typeof ResponseContinuationSchema>;
export type NativeResponseOwner = NonNullable<ResponseContinuationContext["owner"]>;

export function publicResponseState(
  state: ResponseStateObject,
  includeEncrypted: boolean,
): ResponseStateObject {
  if (includeEncrypted) return state;
  return {
    ...state,
    output: state.output.map((item) => {
      if (item.type !== "reasoning") return item;
      const { encrypted_content: _privateReplay, ...publicItem } = item;
      return publicItem;
    }),
  };
}

export class ResponseContextError extends Error {
  readonly code = "response_context_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "ResponseContextError";
  }
}
