import type { ValidateToolArguments } from "../../core/tool-output-validation.js";
import { SdkStreamProtocolError } from "../../kiro/transform/streaming/sdk-stream-runtime.js";
import { isRecord } from "../../protocol/adapter-utils.js";

type Tool = {
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly type: "function_call" | "custom_tool_call";
  readonly index: number;
  arguments: string;
  deltas: boolean;
  done: boolean;
  incomplete: boolean;
  argumentsDone: boolean;
};

function invalid(message: string, code = "invalid_upstream_tool_call"): never {
  throw new SdkStreamProtocolError(message, code);
}

/** Validate native tool identities and completion without rewriting any delta. */
export class NativeToolValidation {
  readonly #tools = new Map<string, Tool>();
  #bytes = 0;

  constructor(
    private readonly maximumBytes: number,
    private readonly validateArguments?: ValidateToolArguments,
  ) {}

  accept(event: Record<string, unknown>): void {
    if (
      event.type === "response.output_item.added" &&
      isRecord(event.item) &&
      (event.item.type === "function_call" || event.item.type === "custom_tool_call")
    ) {
      const item = event.item;
      if (
        typeof item.id !== "string" ||
        !item.id ||
        typeof item.call_id !== "string" ||
        !item.call_id ||
        typeof item.name !== "string" ||
        !item.name ||
        !Number.isSafeInteger(event.output_index) ||
        (event.output_index as number) < 0 ||
        this.#tools.has(item.id) ||
        [...this.#tools.values()].some(
          (tool) => tool.callId === item.call_id || tool.index === event.output_index,
        )
      ) {
        invalid("Native upstream announced an invalid or duplicate tool identity");
      }
      const args = item.type === "function_call" ? item.arguments : item.input;
      this.validateArguments?.assertName(item.name);
      if (args !== undefined && typeof args !== "string")
        invalid("Native tool arguments must be a string");
      this.addBytes(
        Buffer.byteLength(String(args ?? ""), "utf8") +
          Buffer.byteLength(item.id + item.call_id + item.name, "utf8"),
      );
      this.#tools.set(item.id, {
        id: item.id,
        callId: item.call_id,
        name: item.name,
        type: item.type as Tool["type"],
        index: event.output_index as number,
        arguments: (args as string | undefined) ?? "",
        deltas: false,
        done: false,
        incomplete: false,
        argumentsDone: false,
      });
      return;
    }
    if (
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.custom_tool_call_input.delta"
    ) {
      const tool = typeof event.item_id === "string" ? this.#tools.get(event.item_id) : undefined;
      if (
        !tool ||
        tool.done ||
        tool.argumentsDone ||
        tool.index !== event.output_index ||
        typeof event.delta !== "string" ||
        (tool.type === "function_call") !==
          (event.type === "response.function_call_arguments.delta")
      ) {
        invalid("Native upstream changed a tool identity or emitted arguments after completion");
      }
      this.addBytes(Buffer.byteLength(event.delta as string, "utf8"));
      tool.arguments += event.delta;
      tool.deltas = true;
      return;
    }
    if (
      event.type === "response.function_call_arguments.done" ||
      event.type === "response.custom_tool_call_input.done"
    ) {
      const tool = typeof event.item_id === "string" ? this.#tools.get(event.item_id) : undefined;
      const args =
        event.type === "response.function_call_arguments.done" ? event.arguments : event.input;
      if (
        !tool ||
        tool.argumentsDone ||
        tool.done ||
        tool.index !== event.output_index ||
        typeof args !== "string" ||
        (tool.type === "function_call") !== (event.type === "response.function_call_arguments.done")
      ) {
        invalid("Native upstream completed an unannounced tool");
      }
      // A truncated response can close its argument stream before reporting
      // item.status=incomplete. Syntax/schema gate a completed item, not this
      // parameter boundary; identity and size must already be consistent.
      this.finishArguments(tool, args as string, false);
      tool.argumentsDone = true;
      return;
    }
    if (
      event.type === "response.output_item.done" &&
      isRecord(event.item) &&
      (event.item.type === "function_call" || event.item.type === "custom_tool_call")
    ) {
      this.finishItem(event.item, event.output_index, true);
      return;
    }
    if (
      event.type === "response.completed" &&
      isRecord(event.response) &&
      Array.isArray(event.response.output)
    ) {
      this.complete(event.response.output);
    }
  }

  complete(output: readonly unknown[]): void {
    const seen = new Set<string>();
    const calls = new Set<string>();
    for (const item of output) {
      if (!isRecord(item) || (item.type !== "function_call" && item.type !== "custom_tool_call"))
        continue;
      if (typeof item.id !== "string" || seen.has(item.id))
        invalid("Native response repeated a tool item");
      if (typeof item.call_id !== "string" || calls.has(item.call_id))
        invalid("Native response repeated a tool call");
      seen.add(item.id);
      calls.add(item.call_id);
      this.finishItem(item);
    }
    if ([...this.#tools.keys()].some((id) => !seen.has(id))) {
      invalid(
        "Native completed response omitted an announced tool",
        "incomplete_upstream_tool_call",
      );
    }
  }

  private finishItem(
    item: Record<string, unknown>,
    index?: unknown,
    allowIncomplete = false,
  ): void {
    const incomplete = allowIncomplete && item.status === "incomplete";
    if (
      typeof item.id !== "string" ||
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      !item.id ||
      !item.call_id ||
      !item.name ||
      (item.status !== undefined && item.status !== "completed" && !incomplete)
    ) {
      invalid("Native upstream returned an incomplete tool", "incomplete_upstream_tool_call");
    }
    const tool = this.#tools.get(item.id as string);
    if (!tool && index !== undefined) invalid("Native upstream completed an unannounced tool");
    const args = item.type === "function_call" ? item.arguments : item.input;
    if (typeof args !== "string") invalid("Native tool arguments must be a string");
    if (tool) {
      if (tool.incomplete)
        invalid(
          "Native completed response contains an incomplete tool",
          "incomplete_upstream_tool_call",
        );
      if (tool.done && index !== undefined) invalid("Native upstream repeated a tool completion");
      if (
        tool.callId !== item.call_id ||
        tool.name !== item.name ||
        tool.type !== item.type ||
        (index !== undefined && index !== tool.index)
      )
        invalid("Native upstream changed a tool identity");
      this.finishArguments(tool, args as string, !incomplete);
      tool.done = true;
      tool.incomplete = incomplete;
    } else {
      this.addBytes(
        Buffer.byteLength(args as string, "utf8") +
          Buffer.byteLength(`${item.id}${item.call_id}${item.name}`, "utf8"),
      );
      this.validate(item.type as Tool["type"], item.name as string, args as string);
    }
  }

  private finishArguments(tool: Tool, args: string, validate = true): void {
    if ((tool.deltas || tool.arguments.length > 0) && args !== tool.arguments)
      invalid("Native completed arguments disagree with their deltas");
    if (!tool.deltas && !tool.arguments.length) this.addBytes(Buffer.byteLength(args, "utf8"));
    if (validate) this.validate(tool.type, tool.name, args);
    tool.arguments = args;
  }

  private validate(type: Tool["type"], name: string, args: string): void {
    this.validateArguments?.assertName(name);
    if (type === "custom_tool_call") return;
    let value: unknown;
    try {
      value = JSON.parse(args);
    } catch {
      invalid(
        "Native upstream returned malformed tool arguments",
        "malformed_upstream_tool_arguments",
      );
    }
    this.validateArguments?.(name, value);
  }

  private addBytes(bytes: number): void {
    this.#bytes += bytes;
    if (this.#bytes > this.maximumBytes)
      invalid(
        "Upstream tool arguments exceeded the configured request-body budget",
        "upstream_tool_arguments_too_large",
      );
  }
}
