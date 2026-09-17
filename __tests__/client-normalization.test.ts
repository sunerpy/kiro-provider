import { describe, expect, test } from "bun:test";
import type { CanonicalAssistantOutput } from "../src/protocol/canonical.js";
import {
  isClientNormalization,
  normalizedAssistantOutputFingerprint,
  workingDirectoryHash,
} from "../src/protocol/client-normalization.js";

const context = {
  kind: "claude-code-bash-v1" as const,
  workingDirectoryHash: workingDirectoryHash("/fixture/project"),
};
function output(
  command: string,
  name = "Bash",
  id = "call",
  text = "done",
): CanonicalAssistantOutput {
  return {
    text,
    toolCalls: [{ id, name, input: JSON.stringify({ command, description: "fixture" }) }],
  };
}
const fingerprint = (command: string) =>
  normalizedAssistantOutputFingerprint(output(command), context);

describe("bounded native Bash normalization", () => {
  test.each([
    "cd /fixture/project && printf fixture",
    "cd '/fixture/project' && printf fixture",
    'cd "/fixture/project" && printf fixture',
    "cd -- /fixture/project && printf fixture",
  ])("recognizes the declared directory without evaluating shell input: %s", (command) => {
    expect(fingerprint(command)).toBe(fingerprint("printf fixture"));
  });

  test.each([
    "cd /another/project && printf fixture",
    'cd "$PWD" && printf fixture',
    "cd `pwd` && printf fixture",
    "cd /fixture/project-other && printf fixture",
    "cd /fixture/project; printf fixture",
    "cd -P /fixture/project && printf fixture",
    "cd /fixture/project && ",
  ])("keeps every unverified command spelling distinct: %s", (command) => {
    expect(fingerprint(command)).not.toBe(fingerprint("printf fixture"));
  });

  test("binds directory context, text, call identity and remaining arguments", () => {
    const original = normalizedAssistantOutputFingerprint(output("printf fixture"), context);
    for (const changed of [
      output("printf different"),
      output("printf fixture", "Other"),
      output("printf fixture", "Bash", "other-call"),
      output("printf fixture", "Bash", "call", "different"),
      {
        text: "done",
        toolCalls: [
          {
            id: "call",
            name: "Bash",
            input: '{"command":"printf fixture","description":"different"}',
          },
        ],
      },
    ])
      expect(normalizedAssistantOutputFingerprint(changed, context)).not.toBe(original);
    expect(
      normalizedAssistantOutputFingerprint(output("printf fixture"), {
        ...context,
        workingDirectoryHash: workingDirectoryHash("/different"),
      }),
    ).not.toBe(original);
  });

  test("does not turn malformed or unrelated argument values into a Bash command", () => {
    for (const input of ["invalid-json", "null", "[]", "12", "{}", '{"command":1}']) {
      const result = normalizedAssistantOutputFingerprint(
        { text: "", toolCalls: [{ id: "call", name: "Bash", input }] },
        context,
      );
      expect(result).toMatch(/^[0-9a-f]{64}$/);
      expect(result).not.toBe(fingerprint("printf fixture"));
    }
  });

  test("validates the complete normalization contract", () => {
    expect(isClientNormalization(context)).toBe(true);
    for (const invalid of [
      undefined,
      null,
      {},
      [],
      { kind: "other", workingDirectoryHash: context.workingDirectoryHash },
      { kind: context.kind, workingDirectoryHash: "short" },
      { ...context, workingDirectoryHash: context.workingDirectoryHash.toUpperCase() },
      { ...context, extra: true },
    ])
      expect(isClientNormalization(invalid)).toBe(false);
  });
});
