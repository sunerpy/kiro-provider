import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import { RequestTransformError } from "../kiro/transform/errors.js";
import { SdkStreamProtocolError } from "../kiro/transform/streaming/sdk-stream-runtime.js";

export interface ToolOutputSchema {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly path?: string;
  readonly publicType?: "function" | "custom";
}

export interface ValidateToolArguments {
  (name: string, value: unknown): void;
  readonly assertName: (name: string) => void;
}

/**
 * Validate observed arguments locally; never coerce, fill defaults, remove
 * properties, fetch remote schemas, or claim upstream strict generation support.
 */
export function toolOutputValidator(
  tools: readonly ToolOutputSchema[],
  callsAllowed = true,
): ValidateToolArguments {
  const validators = new Map<string, (value: unknown) => boolean>();
  const compilers = new Map<string, Ajv | Ajv2019 | Ajv2020>();
  for (const [index, tool] of tools.entries()) {
    try {
      if (tool.schema.$async === true || validators.has(tool.name))
        throw new Error("invalid schema");
      if (tool.publicType === "custom") {
        // Preserve the existing bridge's exact custom-wrapper validation and code.
        validators.set(tool.name, () => true);
        continue;
      }
      const dialect = typeof tool.schema.$schema === "string" ? tool.schema.$schema : "";
      const family = dialect.includes("2020-12")
        ? "2020"
        : dialect.includes("2019-09")
          ? "2019"
          : "7";
      let compiler = compilers.get(family);
      if (!compiler) {
        const options = {
          strict: false,
          allErrors: false,
          validateFormats: false,
          ownProperties: true,
          coerceTypes: false,
          useDefaults: false,
          removeAdditional: false,
          addUsedSchema: false,
        } as const;
        compiler =
          family === "2020"
            ? new Ajv2020(options)
            : family === "2019"
              ? new Ajv2019(options)
              : new Ajv(options);
        compilers.set(family, compiler);
      }
      validators.set(tool.name, compiler.compile(tool.schema));
    } catch {
      throw new RequestTransformError(
        "Tool schema cannot be validated; external references and asynchronous schemas are not supported",
        "invalid_tool_schema",
        tool.path ?? `tools[${index}].parameters`,
      );
    }
  }
  const assertName = (name: string): void => {
    if (!callsAllowed) {
      throw new SdkStreamProtocolError(
        "Upstream called a tool despite tool_choice=none",
        "upstream_tool_choice_violation",
      );
    }
    if (!validators.has(name)) {
      throw new SdkStreamProtocolError(
        "Upstream returned an undeclared tool call",
        "unknown_upstream_tool",
      );
    }
  };
  const validateArguments = (name: string, value: unknown): void => {
    assertName(name);
    const validate = validators.get(name) as (value: unknown) => boolean;
    if (!validate(value)) {
      throw new SdkStreamProtocolError(
        "Upstream tool arguments do not match the declared schema",
        "upstream_tool_schema_violation",
      );
    }
  };
  return Object.assign(validateArguments, { assertName });
}
