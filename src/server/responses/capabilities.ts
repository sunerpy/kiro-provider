import type { KiroRegion } from "../../kiro/types.js";

export type ResponsesNativeFeature =
  | "instruction_lift"
  | "namespace_functions"
  | "custom_freeform"
  | "native_previous_response"
  | "instruction_priority";
export interface ResponsesCapabilityEvidence {
  readonly feature: ResponsesNativeFeature;
  readonly model: string;
  readonly region: KiroRegion;
  readonly status: "verified" | "unsupported" | "unverified";
  readonly evidence: string;
}

// Admission is evidence-driven, never inferred from a successful HTTP status.
// Add only model/region cells that pass the complete live continuation matrix.
export const RESPONSES_CAPABILITY_EVIDENCE: readonly ResponsesCapabilityEvidence[] = [
  {
    feature: "namespace_functions",
    model: "claude-opus-5",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "custom_freeform",
    model: "claude-opus-5",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "namespace_functions",
    model: "claude-sonnet-5",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "custom_freeform",
    model: "claude-sonnet-5",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "namespace_functions",
    model: "gpt-5.6-sol",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "custom_freeform",
    model: "gpt-5.6-sol",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "namespace_functions",
    model: "gpt-5.6-terra",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "custom_freeform",
    model: "gpt-5.6-terra",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "namespace_functions",
    model: "gpt-5.6-luna",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "custom_freeform",
    model: "gpt-5.6-luna",
    region: "us-east-1",
    status: "verified",
    evidence:
      "docs/audits/evidence/responses-fidelity-2026-09-10: JSON and SSE, 3 repetitions each",
  },
  {
    feature: "instruction_priority",
    model: "claude-opus-5",
    region: "us-east-1",
    status: "unverified",
    evidence: "2026-09-10: one of three conflicting-user probes did not follow instructions",
  },
  {
    feature: "instruction_priority",
    model: "claude-sonnet-5",
    region: "us-east-1",
    status: "unverified",
    evidence: "2026-09-10: three conflicting-user probes did not follow instructions",
  },
  {
    feature: "native_previous_response",
    model: "claude-opus-5",
    region: "us-east-1",
    status: "unsupported",
    evidence:
      "2026-09-10: previous ID echoed without marker recall; tool outputs lack tool_use history",
  },
  {
    feature: "native_previous_response",
    model: "claude-sonnet-5",
    region: "us-east-1",
    status: "unsupported",
    evidence: "2026-09-10: previous ID echoed without marker recall",
  },
];

export function responsesCapability(
  feature: ResponsesNativeFeature,
  model: string,
  region: KiroRegion,
): ResponsesCapabilityEvidence["status"] {
  return (
    RESPONSES_CAPABILITY_EVIDENCE.find(
      (cell) => cell.feature === feature && cell.model === model && cell.region === region,
    )?.status ?? "unverified"
  );
}
