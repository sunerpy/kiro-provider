import type {
	PipelineAccountManager,
	PipelineModelCapabilities,
	PipelineReasoningReplayStore,
} from "../../core/pipeline.js";

export function handleReadiness(
	accountManager: PipelineAccountManager,
	reasoningReplayStore?: PipelineReasoningReplayStore,
	modelCapabilities?: PipelineModelCapabilities,
): Response {
	try {
		accountManager.reconcileFromDb();
		const accountCount = accountManager.getAccountCount();
		if (accountCount === 0) {
			return Response.json(
				{ status: "not_ready", reason: "no_active_accounts" },
				{ status: 503 },
			);
		}
		if (reasoningReplayStore) {
			const readiness = reasoningReplayStore.readiness();
			if (!readiness.writable) {
				return Response.json(
					{ status: "not_ready", reason: "reasoning_replay_database_not_writable" },
					{ status: 503 },
				);
			}
			if (!readiness.keyringAvailable) {
				return Response.json(
					{ status: "not_ready", reason: "reasoning_replay_keyring_unavailable" },
					{ status: 503 },
				);
			}
			if (readiness.missingKeyIds.length > 0) {
				return Response.json(
					{
						status: "not_ready",
						reason: "reasoning_replay_key_coverage_incomplete",
						missing_key_ids: readiness.missingKeyIds,
					},
					{ status: 503 },
				);
			}
		}
		return Response.json({
			status: "ready",
			...(modelCapabilities
				? { model_catalog: modelCapabilities.readiness() }
				: {}),
		});
	} catch {
		return Response.json(
			{ status: "not_ready", reason: "authentication_store_unavailable" },
			{ status: 503 },
		);
	}
}
