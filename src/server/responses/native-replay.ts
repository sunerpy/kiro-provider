import type {
  ResponsesCustomToolCallItem,
  ResponsesFunctionCallItem,
  ResponsesInputItem,
  ResponsesRequest,
} from "../request-schema.js";
import { ResponseContextError } from "./continuation.js";
import type { PipelineResponseStore, StoredResponse } from "./store.js";
import { createResponsesToolBridge } from "./tool-bridge.js";

export function nativeInputItems(input: ResponsesRequest["input"]): ResponsesInputItem[] {
  return typeof input === "string" ? [{ role: "user", content: input }] : [...input];
}

function legacyWireItems(stored: StoredResponse): ResponsesInputItem[] {
  const context = stored.continuation;
  if (context?.wireSnapshot) return [...context.wireSnapshot.input, ...context.wireSnapshot.output];
  let input = context
    ? nativeInputItems(context.request.input)
    : (stored.inputItems as ResponsesInputItem[]);
  const output = context?.output ?? (stored.response.output as ResponsesInputItem[]);
  if (context?.instruction && input[0]?.role === context.instruction.role) {
    const content = input[0]?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content) && content.length === 1
          ? content[0]?.text
          : undefined;
    if (text !== context.instruction.text)
      throw new ResponseContextError("Stored instruction scope cannot be reconstructed");
    input = input.slice(1);
  }
  if (!context?.tools?.length) return [...input, ...output];
  if (
    output.some((item) => item.type === "reasoning" && typeof item.encrypted_content === "string")
  ) {
    throw new ResponseContextError("Legacy adapted reasoning is missing its exact wire snapshot");
  }
  const built = createResponsesToolBridge(
    { model: stored.response.model, stream: false, input: output },
    [],
    {
      stable: true,
      bindings: context.tools,
      allowHistoricalWithoutDeclarations: true,
    },
  );
  if (!built.ok) throw new ResponseContextError("Stored tool mappings cannot be reconstructed");
  return [...input, ...output].map((item) => {
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const lowered = built.bridge.lowerCall(
        item as ResponsesFunctionCallItem | ResponsesCustomToolCallItem,
      );
      const { namespace: _namespace, input: _input, ...rest } = item;
      return {
        ...rest,
        type: "function_call",
        name: lowered.function.name,
        arguments: lowered.function.arguments,
      } as ResponsesFunctionCallItem;
    }
    return item.type === "custom_tool_call_output"
      ? { ...item, type: "function_call_output" as const }
      : item;
  });
}

/** Iterative legacy recovery; new snapshots do not depend on retained ancestor rows. */
export function nativeReplayHistory(
  previous: StoredResponse,
  store: PipelineResponseStore | undefined,
  tenant: string,
): ResponsesInputItem[] {
  const chunks: ResponsesInputItem[][] = [];
  const seen = new Set<string>();
  let current: StoredResponse | undefined = previous;
  while (current) {
    if (seen.has(current.response.id) || seen.size >= 10000 || current.transport === "stateless") {
      throw new ResponseContextError("Stored native history is cyclic or crosses transports");
    }
    seen.add(current.response.id);
    const snapshot = current.continuation?.nativeReplay;
    if (snapshot) {
      chunks.push([...snapshot.input, ...snapshot.output]);
      break;
    }
    chunks.push(legacyWireItems(current));
    const parent: string | null | undefined =
      current.continuation?.request.previous_response_id ?? current.response.previous_response_id;
    if (!parent) break;
    current = store?.get(tenant, parent);
    if (!current)
      throw new ResponseContextError("An ancestor needed for native replay is unavailable");
  }
  return chunks.reverse().flat();
}
