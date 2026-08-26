import { canonicalFingerprint } from "../../protocol/canonical.js";
import type {
  ResponsesAdditionalToolsItem,
  ResponsesCustomToolCallItem,
  ResponsesCustomToolCallOutputItem,
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesInputItem,
  ResponsesKnownTool,
  ResponsesRequest,
  ResponsesTool,
} from "../request-schema.js";
import type { ResponseToolCallItem } from "./events.js";

export type InternalTool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
};

export type InternalToolCall = {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
};

export type BridgedToolDeclaration = {
  readonly publicType: "function" | "custom";
  readonly publicName: string;
  readonly wireName: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
  readonly path: string;
  readonly origin: "request" | "input";
  readonly strict?: false;
  readonly sourceMetadata?: Readonly<Record<string, unknown>>;
};

export type RestorableToolCall = {
  readonly itemId: string;
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

type PublicToolIdentity =
  | { readonly kind: "function"; readonly name: string }
  | { readonly kind: "custom"; readonly name: string }
  | {
      readonly kind: "namespace";
      readonly namespace: string;
      readonly name: string;
      readonly toolType: "function" | "custom";
    };

type BridgeErrorCode =
  | "invalid_tool_declaration"
  | "invalid_tool_history"
  | "missing_tool_declaration"
  | "invalid_custom_tool_input"
  | "unknown_tool_alias";

export type BridgeFailure = {
  readonly ok: false;
  readonly code: BridgeErrorCode;
  readonly message: string;
};

type BridgeBuildFailure = {
  readonly ok: false;
  readonly code:
    | "invalid_tool_declaration"
    | "invalid_tool_history"
    | "missing_tool_declaration";
  readonly message: string;
};

export type BridgeBuildResult =
  | { readonly ok: true; readonly bridge: ResponsesToolBridge }
  | BridgeBuildFailure;

type Declaration = {
  readonly identity: PublicToolIdentity;
  readonly tool: InternalTool;
  readonly path: string;
  readonly origin: "request" | "input";
  readonly strict?: false;
  readonly sourceMetadata?: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
};

type HistoricalCall = {
  readonly index: number;
  readonly identity: PublicToolIdentity;
};

const CUSTOM_ALIAS_PREFIX = "kiro_custom_";
const NAMESPACE_ALIAS_PREFIX = "kiro_ns_";

function identityKey(identity: PublicToolIdentity): string {
  switch (identity.kind) {
    case "function":
      return JSON.stringify(["function", identity.name]);
    case "custom":
      return JSON.stringify(["custom", identity.name]);
    case "namespace":
      return JSON.stringify(["namespace", identity.toolType, identity.namespace, identity.name]);
  }
}

function descriptions(...values: readonly (string | undefined)[]): string | undefined {
  const present = values.filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return present.length > 0 ? present.join("\n\n") : undefined;
}

function customSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  };
}

function functionTool(tool: Extract<ResponsesKnownTool, { type: "function" }>): InternalTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    },
  };
}

function callIdentity(
  item: ResponsesFunctionCallItem | ResponsesCustomToolCallItem,
): PublicToolIdentity {
  if (item.namespace !== undefined) {
    return {
      kind: "namespace",
      namespace: item.namespace,
      name: item.name,
      toolType: item.type === "custom_tool_call" ? "custom" : "function",
    };
  }
  if (item.type === "custom_tool_call") return { kind: "custom", name: item.name };
  return { kind: "function", name: item.name };
}

function isCustomIdentity(identity: PublicToolIdentity): boolean {
  return (
    identity.kind === "custom" || (identity.kind === "namespace" && identity.toolType === "custom")
  );
}

function isCallItem(
  item: ResponsesInputItem,
): item is ResponsesFunctionCallItem | ResponsesCustomToolCallItem {
  return item.type === "function_call" || item.type === "custom_tool_call";
}

function isAdditionalToolsItem(item: ResponsesInputItem): item is ResponsesAdditionalToolsItem {
  return item.type === "additional_tools";
}

function isKnownTool(tool: ResponsesTool): tool is ResponsesKnownTool {
  return tool.type === "function" || tool.type === "custom" || tool.type === "namespace";
}

function isOutputItem(
  item: ResponsesInputItem,
): item is ResponsesFunctionCallOutputItem | ResponsesCustomToolCallOutputItem {
  return item.type === "function_call_output" || item.type === "custom_tool_call_output";
}

function normalizedFunctionArguments(argumentsText: string): string {
  return argumentsText.trim().length === 0 ? "{}" : argumentsText;
}

function exactCustomInput(
  argumentsText: string,
): { readonly ok: true; readonly input: string } | BridgeFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        code: "invalid_custom_tool_input",
        message: "Custom tool arguments must be valid JSON",
      };
    }
    throw error;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof (parsed as Record<string, unknown>).input !== "string"
  ) {
    return {
      ok: false,
      code: "invalid_custom_tool_input",
      message: 'Custom tool arguments must contain exactly {"input": string}',
    };
  }
  return { ok: true, input: (parsed as { readonly input: string }).input };
}

export class ResponsesToolBridge {
  readonly internalTools: readonly InternalTool[];
  readonly declarations: readonly BridgedToolDeclaration[];
  readonly #wireNameByIdentity: ReadonlyMap<string, string>;
  readonly #identityByWireName: ReadonlyMap<string, PublicToolIdentity>;

  constructor(input: {
    readonly internalTools: readonly InternalTool[];
    readonly declarations: readonly BridgedToolDeclaration[];
    readonly wireNameByIdentity: ReadonlyMap<string, string>;
    readonly identityByWireName: ReadonlyMap<string, PublicToolIdentity>;
  }) {
    this.internalTools = input.internalTools;
    this.declarations = input.declarations;
    this.#wireNameByIdentity = input.wireNameByIdentity;
    this.#identityByWireName = input.identityByWireName;
  }

  lowerCall(item: ResponsesFunctionCallItem | ResponsesCustomToolCallItem): InternalToolCall {
    const identity = callIdentity(item);
    const name = this.#wireNameByIdentity.get(identityKey(identity)) ?? item.name;
    return {
      id: item.call_id,
      type: "function",
      function: {
        name,
        arguments:
          item.type === "custom_tool_call" ? JSON.stringify({ input: item.input }) : item.arguments,
      },
    };
  }

  restoreCalls(
    calls: readonly RestorableToolCall[],
  ): { readonly ok: true; readonly items: readonly ResponseToolCallItem[] } | BridgeFailure {
    const items: ResponseToolCallItem[] = [];
    for (const call of calls) {
      const identity = this.#identityByWireName.get(call.name);
      if (!identity) {
        return {
          ok: false,
          code: "unknown_tool_alias",
          message: `Upstream returned undeclared tool ${call.name}`,
        };
      }
      if (isCustomIdentity(identity)) {
        const parsed = exactCustomInput(call.arguments);
        if (!parsed.ok) return parsed;
        items.push({
          id: call.itemId,
          type: "custom_tool_call",
          call_id: call.id,
          ...(identity.kind === "namespace" ? { namespace: identity.namespace } : {}),
          name: identity.name,
          input: parsed.input,
        });
        continue;
      }
      items.push({
        id: call.itemId,
        type: "function_call",
        call_id: call.id,
        ...(identity.kind === "namespace" ? { namespace: identity.namespace } : {}),
        name: identity.name,
        arguments: normalizedFunctionArguments(call.arguments),
      });
    }
    return { ok: true, items };
  }
}

function malformedNamespace(tool: Extract<ResponsesKnownTool, { type: "namespace" }>): boolean {
  const childNames = new Set<string>();
  for (const child of tool.tools) {
    if (childNames.has(child.name)) return true;
    childNames.add(child.name);
  }
  return false;
}

export function createResponsesToolBridge(req: ResponsesRequest): BridgeBuildResult {
  const declarations = new Map<string, Declaration>();
  const ordinaryKindsByName = new Map<string, "function" | "custom">();
  const ordinaryNames = new Set<string>();
  const historical: HistoricalCall[] = [];
  const inputs = typeof req.input === "string" ? [] : req.input;

  for (const item of inputs) {
    if (isCallItem(item) && item.type === "function_call" && item.namespace === undefined) {
      ordinaryNames.add(item.name);
    }
  }

  const registerDeclaration = (declaration: Declaration): BridgeBuildFailure | undefined => {
    const key = identityKey(declaration.identity);
    const existing = declarations.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint === declaration.fingerprint) return undefined;
      return {
        ok: false,
        code: "invalid_tool_declaration",
        message: `Tool ${declaration.path} conflicts with ${existing.path}`,
      };
    }
    declarations.set(key, declaration);
    return undefined;
  };

  const addDeclaration = (
    tool: ResponsesKnownTool,
    path: string,
    origin: "request" | "input",
    sourceRole?: string,
  ): BridgeBuildFailure | undefined => {
    if (tool.type === "namespace") {
      if (malformedNamespace(tool)) {
        return {
          ok: false,
          code: "invalid_tool_declaration",
          message: `Namespace ${tool.name} contains duplicate child names`,
        };
      }
      for (const [childIndex, child] of tool.tools.entries()) {
        const identity: PublicToolIdentity = {
          kind: "namespace",
          namespace: tool.name,
          name: child.name,
          toolType: child.type,
        };
        const childPath = `${path}.tools.${childIndex}`;
        const internalTool: InternalTool = {
          type: "function",
          function: {
            name: "",
            ...(descriptions(tool.description, child.description) !== undefined
              ? { description: descriptions(tool.description, child.description) }
              : {}),
            parameters:
              child.type === "custom"
                ? customSchema()
                : (child.parameters ?? { type: "object" }),
          },
        };
        const failure = registerDeclaration({
          identity,
          tool: internalTool,
          path: childPath,
          origin,
          ...(sourceRole !== undefined ? { sourceMetadata: { role: sourceRole } } : {}),
          ...(child.type === "function" ? { strict: false as const } : {}),
          fingerprint: canonicalFingerprint({ identity, tool: internalTool, origin, sourceRole }),
        });
        if (failure) return failure;
      }
      return undefined;
    }
    const existingKind = ordinaryKindsByName.get(tool.name);
    if (existingKind !== undefined && existingKind !== tool.type) {
      return {
        ok: false,
        code: "invalid_tool_declaration",
        message: `Tool name ${tool.name} is declared as both function and custom`,
      };
    }
    ordinaryKindsByName.set(tool.name, tool.type);
    if (tool.type === "function") ordinaryNames.add(tool.name);
    const identity: PublicToolIdentity = { kind: tool.type, name: tool.name };
    const internalTool: InternalTool =
      tool.type === "function"
        ? functionTool(tool)
        : {
            type: "function",
            function: {
              name: "",
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              parameters: customSchema(),
            },
          };
    return registerDeclaration({
      identity,
      tool: internalTool,
      path,
      origin,
      ...(sourceRole !== undefined ? { sourceMetadata: { role: sourceRole } } : {}),
      ...(tool.type === "function" ? { strict: false as const } : {}),
      fingerprint: canonicalFingerprint({ identity, tool: internalTool, origin, sourceRole }),
    });
  };

  for (const [index, tool] of (req.tools ?? []).entries()) {
    if (!isKnownTool(tool)) continue;
    const failure = addDeclaration(tool, `tools.${index}`, "request");
    if (failure) return failure;
  }
  for (const [inputIndex, item] of inputs.entries()) {
    if (!isAdditionalToolsItem(item)) continue;
    for (const [toolIndex, tool] of item.tools.entries()) {
      if (!isKnownTool(tool)) continue;
      const failure = addDeclaration(
        tool,
        `input.${inputIndex}.tools.${toolIndex}`,
        "input",
        item.role,
      );
      if (failure) return failure;
    }
  }

  const callsById = new Map<string, HistoricalCall>();
  for (const [index, item] of inputs.entries()) {
    if (!isCallItem(item)) continue;
    if (callsById.has(item.call_id)) {
      return {
        ok: false,
        code: "invalid_tool_history",
        message: `Duplicate tool call id ${item.call_id}`,
      };
    }
    const call = { index, identity: callIdentity(item) };
    callsById.set(item.call_id, call);
    historical.push(call);
  }

  const outputIds = new Set<string>();
  for (const [index, item] of inputs.entries()) {
    if (!isOutputItem(item)) continue;
    if (outputIds.has(item.call_id)) {
      return {
        ok: false,
        code: "invalid_tool_history",
        message: `Duplicate tool output id ${item.call_id}`,
      };
    }
    outputIds.add(item.call_id);
    const call = callsById.get(item.call_id);
    if (!call) {
      return {
        ok: false,
        code: "invalid_tool_history",
        message: `Tool output ${item.call_id} has no matching call`,
      };
    }
    const callIsCustom = isCustomIdentity(call.identity);
    const compatible =
      (item.type === "custom_tool_call_output" && callIsCustom) ||
      (item.type === "function_call_output" && !callIsCustom);
    if (call.index >= index || !compatible) {
      return {
        ok: false,
        code: "invalid_tool_history",
        message: `Tool output ${item.call_id} is out of order or has the wrong type`,
      };
    }
  }

  const ordered = [...declarations.values()];
  for (const call of historical) {
    const key = identityKey(call.identity);
    if (declarations.has(key)) continue;
    return {
      ok: false,
      code: "missing_tool_declaration",
      message:
        `Historical ${call.identity.kind} tool call has no exact declaration; ` +
        "resend the original tool declaration",
    };
  }

  const usedWireNames = new Set(ordinaryNames);
  const wireNameByIdentity = new Map<string, string>();
  const identityByWireName = new Map<string, PublicToolIdentity>();
  let customIndex = 0;
  let namespaceIndex = 0;
  const nextAlias = (kind: "custom" | "namespace"): string => {
    for (;;) {
      const candidate =
        kind === "custom"
          ? `${CUSTOM_ALIAS_PREFIX}${customIndex++}`
          : `${NAMESPACE_ALIAS_PREFIX}${namespaceIndex++}`;
      if (usedWireNames.has(candidate)) continue;
      usedWireNames.add(candidate);
      return candidate;
    }
  };
  const internalTools: InternalTool[] = [];
  const bridgedDeclarations: BridgedToolDeclaration[] = [];
  for (const declaration of ordered) {
    const key = identityKey(declaration.identity);
    const wireName =
      declaration.identity.kind === "function"
        ? declaration.identity.name
        : nextAlias(declaration.identity.kind);
    wireNameByIdentity.set(key, wireName);
    identityByWireName.set(wireName, declaration.identity);
    internalTools.push({
      type: "function",
      function: { ...declaration.tool.function, name: wireName },
    });
    bridgedDeclarations.push({
      publicType: isCustomIdentity(declaration.identity) ? "custom" : "function",
      publicName:
        declaration.identity.kind === "namespace"
          ? `${declaration.identity.namespace}.${declaration.identity.name}`
          : declaration.identity.name,
      wireName,
      ...(declaration.tool.function.description !== undefined
        ? { description: declaration.tool.function.description }
        : {}),
      parameters: declaration.tool.function.parameters ?? {},
      path: declaration.path,
      origin: declaration.origin,
      ...(declaration.strict !== undefined ? { strict: declaration.strict } : {}),
      ...(declaration.sourceMetadata !== undefined
        ? { sourceMetadata: declaration.sourceMetadata }
        : {}),
    });
  }
  for (const name of ordinaryNames) {
    const identity: PublicToolIdentity = { kind: "function", name };
    wireNameByIdentity.set(identityKey(identity), name);
    identityByWireName.set(name, identity);
  }

  return {
    ok: true,
    bridge: new ResponsesToolBridge({
      internalTools,
      declarations: bridgedDeclarations,
      wireNameByIdentity,
      identityByWireName,
    }),
  };
}
