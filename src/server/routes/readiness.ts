import type { PipelineAccountManager } from "../../core/pipeline.js";

export function handleReadiness(
	accountManager: PipelineAccountManager,
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
		return Response.json({ status: "ready" });
	} catch {
		return Response.json(
			{ status: "not_ready", reason: "authentication_store_unavailable" },
			{ status: 503 },
		);
	}
}
