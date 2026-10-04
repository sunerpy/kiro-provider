import { MODEL_MAPPING } from "../kiro/constants.js";
import { resolveModelVariant, VARIANT_BASE_ALLOWLIST } from "../kiro/models.js";

/** Public spelling/effort is independent of the signed upstream model identity. */
export function replayModelIdentity(publicModelId: string): string {
  try {
    return resolveModelVariant(publicModelId).wireId;
  } catch {
    // A management-discovered model may no longer be in the process registry.
    // Its exact wire ID remains an identity; never guess aliases by suffix.
    return publicModelId;
  }
}

const HISTORICAL_PUBLIC_MODELS = Object.freeze([
  ...Object.keys(MODEL_MAPPING),
  ...[...VARIANT_BASE_ALLOWLIST].flatMap((base) =>
    ["low", "medium", "high", "xhigh", "max"].map((effort) => `${base}-${effort}`),
  ),
]);

/** Only server-owned aliases may supply a legacy token's original AAD model. */
export function replayAuthenticationModels(
  publicModelId: string,
  mode: "strict" | "compatible",
): readonly string[] {
  const identity = replayModelIdentity(publicModelId);
  return [
    ...new Set([
      publicModelId,
      identity,
      ...HISTORICAL_PUBLIC_MODELS.filter(
        (candidate) => mode === "compatible" || replayModelIdentity(candidate) === identity,
      ),
    ]),
  ];
}
