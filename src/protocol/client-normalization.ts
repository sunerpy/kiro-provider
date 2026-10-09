import { createHash } from "node:crypto";
import {
  assistantOutputFingerprint,
  type CanonicalAssistantOutput,
  canonicalFingerprint,
} from "./canonical.js";

export interface ClientNormalization {
  readonly kind: "claude-code-bash-v1";
  readonly workingDirectoryHash: string;
}

export function isClientNormalization(value: unknown): value is ClientNormalization {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).every((key) => key === "kind" || key === "workingDirectoryHash") &&
    "kind" in value &&
    value.kind === "claude-code-bash-v1" &&
    "workingDirectoryHash" in value &&
    typeof value.workingDirectoryHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.workingDirectoryHash)
  );
}

export function workingDirectoryHash(directory: string): string {
  return createHash("sha256")
    .update("kiro-provider-working-directory-v1\0")
    .update(directory)
    .digest("hex");
}

export function literalBashCdPrefix(
  command: string,
): { readonly directory: string; readonly length: number } | undefined {
  // Recognize only a literal, absolute cd prefix.
  // No expansion, shell execution, path resolution or general command rewriting.
  const prefix =
    /^[ \t\r\n]*cd[ \t]+(?:--[ \t]+)?(?:'([^'\r\n]*)'|"([^"$`\\\r\n]*)"|(\/[A-Za-z0-9_./:@%+,-]+))[ \t]*&&[ \t\r\n]*/.exec(
      command,
    );
  const directory = prefix?.[1] ?? prefix?.[2] ?? prefix?.[3];
  if (!prefix || !directory?.startsWith("/") || directory.includes("\0")) return undefined;
  return { directory, length: prefix[0].length };
}

function normalizedCommand(command: string, context: ClientNormalization): string {
  const prefix = literalBashCdPrefix(command);
  if (!prefix || workingDirectoryHash(prefix.directory) !== context.workingDirectoryHash)
    return command;
  const remainder = command.slice(prefix.length);
  return remainder.length > 0 ? remainder : command;
}

export function normalizedAssistantOutputFingerprint(
  output: CanonicalAssistantOutput,
  context: ClientNormalization,
): string {
  const toolCalls = output.toolCalls.map((call) => {
    if (call.name !== "Bash") return call;
    let input: unknown;
    try {
      input = JSON.parse(call.input);
    } catch {
      return call;
    }
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      !("command" in input) ||
      typeof input.command !== "string"
    )
      return call;
    return {
      ...call,
      input: JSON.stringify({ ...input, command: normalizedCommand(input.command, context) }),
    };
  });
  return canonicalFingerprint({
    normalization: context,
    output: assistantOutputFingerprint({ ...output, toolCalls }),
  });
}
