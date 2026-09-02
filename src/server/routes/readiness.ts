import type {
  PipelineAccountManager,
  PipelineModelCapabilities,
  PipelineReasoningReplayStore,
} from "../../core/pipeline.js";

function notReady(reason: string, extra: Readonly<Record<string, unknown>> = {}): Response {
  return Response.json({ status: "not_ready", reason, ...extra }, { status: 503 });
}

export function handleReadiness(
  accountManager: PipelineAccountManager,
  reasoningReplayStore?: PipelineReasoningReplayStore,
  modelCapabilities?: PipelineModelCapabilities,
): Response {
  let accountCount: number;
  try {
    accountManager.reconcileFromDb();
    accountCount = accountManager.getAccountCount();
  } catch {
    return notReady("authentication_store_unavailable");
  }
  if (accountCount === 0) return notReady("no_active_accounts");
  if (reasoningReplayStore) {
    let readiness: ReturnType<PipelineReasoningReplayStore["readiness"]>;
    try {
      readiness = reasoningReplayStore.readiness();
    } catch {
      return notReady("reasoning_replay_store_unavailable");
    }
    if (!readiness.writable) {
      return notReady("reasoning_replay_database_not_writable");
    }
    if (!readiness.keyringAvailable) {
      return notReady("reasoning_replay_keyring_unavailable");
    }
    if (readiness.missingKeyIds.length > 0) {
      return notReady("reasoning_replay_key_coverage_incomplete", {
        missing_key_ids: readiness.missingKeyIds,
      });
    }
  }
  let modelCatalog: unknown;
  if (modelCapabilities) {
    try {
      modelCatalog = modelCapabilities.readiness();
    } catch {
      return notReady("model_catalog_unavailable");
    }
  }
  return Response.json({
    status: "ready",
    ...(modelCapabilities ? { model_catalog: modelCatalog } : {}),
  });
}
