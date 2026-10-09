import type { CanonicalAssistantOutput, CanonicalMessage } from "./canonical.js";
import {
  type ClientNormalization,
  normalizedAssistantOutputFingerprint,
} from "./client-normalization.js";

export interface ClientReplayRepair {
  readonly normalizedOutputFingerprint: string;
  readonly kind: "edit-default" | "bash-cd" | "combined";
  readonly toolInputs: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
}

const MAX_CANDIDATES = 32;
const MAX_WORK_BYTES = 8 << 20;

/** Candidate hints never grant trust: a complete token must authenticate them. */
function nativeDirectories(messages: readonly CanonicalMessage[]): string[] {
  const directories = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const part of message.content) {
      if (part.type !== "text") continue;
      const pattern =
        /(?:^|\n)[ \t]*(?:Primary working directory|Working directory):[ \t]*(\/[^\r\n]+)|<cwd>(\/[^<>\r\n]+)<\/cwd>/g;
      for (const match of part.text.matchAll(pattern)) {
        const directory = (match[1] ?? match[2])?.trim();
        if (!directory || directory.length > 4096 || directory.includes("\0")) continue;
        directories.add(directory);
        if (directories.size === 4) return [...directories];
      }
    }
  }
  return [...directories];
}

/**
 * Reconstruct only evidenced native-client changes. Nothing is applied until
 * the original output fingerprint, ciphertext and normalization scope verify.
 */
export function claudeReplayRepairCandidates(
  output: CanonicalAssistantOutput,
  context: ClientNormalization,
  messages: readonly CanonicalMessage[],
): readonly ClientReplayRepair[] {
  // Include IDs/names and JSON escaping before parsing or cloning inputs.
  const materialBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
  if (materialBytes === 0 || materialBytes > MAX_WORK_BYTES) return [];
  const parsed = output.toolCalls.map((call) => {
    try {
      const value: unknown = JSON.parse(call.input);
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  });
  const edits = output.toolCalls.flatMap((call, index) =>
    call.name === "Edit" && parsed[index]?.replace_all === false ? [index] : [],
  );
  const bash = output.toolCalls.flatMap((call, index) =>
    call.name === "Bash" &&
    typeof parsed[index]?.command === "string" &&
    !/^\s*cd\s/.test(String(parsed[index]?.command))
      ? [index]
      : [],
  );
  if (edits.length === 0 && bash.length === 0) return [];
  const candidates: ClientReplayRepair[] = [];
  let workBytes = 0;
  const add = (removed: readonly number[], prefix?: string): void => {
    // Six bytes per prefix byte conservatively covers JSON control escapes.
    const cost = materialBytes + (prefix ? 6 * Buffer.byteLength(prefix) * bash.length : 0);
    if (candidates.length >= MAX_CANDIDATES || workBytes + cost > MAX_WORK_BYTES) return;
    const inputs: ClientReplayRepair["toolInputs"][number][] = [];
    const toolCalls = output.toolCalls.map((call, index) => {
      const value = parsed[index];
      if (!value || (!removed.includes(index) && !(prefix && bash.includes(index)))) return call;
      const restored = { ...value };
      if (removed.includes(index)) delete restored.replace_all;
      if (prefix && bash.includes(index)) restored.command = prefix + String(value.command);
      inputs.push({ id: call.id, name: call.name, input: restored });
      return { ...call, input: JSON.stringify(restored) };
    });
    if (inputs.length === 0) return;
    workBytes += cost;
    candidates.push({
      normalizedOutputFingerprint: normalizedAssistantOutputFingerprint(
        { text: output.text, toolCalls },
        context,
      ),
      kind: prefix ? (removed.length > 0 ? "combined" : "bash-cd") : "edit-default",
      toolInputs: inputs,
    });
  };
  // All defaults omitted is the common parallel-Edit shape. Bounded subsets
  // retain compatibility with turns mixing explicit and implicit false values.
  const subsets: number[][] = [[]];
  if (edits.length > 0) subsets.push(edits);
  if (edits.length <= 4)
    for (let mask = 1; mask < (1 << edits.length) - 1; mask++)
      subsets.push(edits.filter((_index, bit) => (mask & (1 << bit)) !== 0));
  for (const subset of subsets) if (subset.length > 0) add(subset);
  if (bash.length > 0)
    for (const directory of nativeDirectories(messages)) {
      const literals: string[] = [];
      if (/^\/[A-Za-z0-9_./:@%+,-]+$/.test(directory)) literals.push(directory);
      if (!directory.includes("'")) literals.push(`'${directory}'`);
      if (!/["$`\\]/.test(directory)) literals.push(`"${directory}"`);
      for (const literal of literals)
        for (const subset of subsets) add(subset, `cd ${literal} && `);
    }
  return candidates;
}
