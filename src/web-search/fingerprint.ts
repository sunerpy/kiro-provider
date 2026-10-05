import { type CanonicalAssistantOutput, canonicalFingerprint } from "../protocol/canonical.js";

/**
 * Fingerprint for one generation segment that contains hosted search calls.
 *
 * It is versioned so a reasoning token minted for a hosted segment only
 * verifies when the segment is rebuilt around authenticated search snapshots,
 * never as an ordinary client tool turn. Tool calls are ordered by id because a
 * protocol may publish hosted calls ahead of the client calls of their group,
 * and hosted calls are reduced to their query, the only argument the provider
 * executes and publishes.
 */
export function hostedSegmentFingerprint(
  output: CanonicalAssistantOutput,
  hostedCallIds: readonly string[],
): string {
  const hosted = new Set(hostedCallIds);
  const input = (value: string): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  };
  return canonicalFingerprint({
    version: "kiro-hosted-segment-v1",
    text: output.text,
    toolCalls: [...output.toolCalls]
      .map((call) => {
        const parsed = input(call.input);
        return {
          id: call.id,
          name: call.name,
          input: hosted.has(call.id)
            ? {
                query:
                  typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                    ? ((parsed as { readonly query?: unknown }).query ?? null)
                    : null,
              }
            : parsed,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id)),
    hosted: [...hosted].sort(),
  });
}
