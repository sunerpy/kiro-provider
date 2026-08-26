import { describe, expect, test } from "bun:test";
import {
	CODEX_RECOGNIZED_TYPES,
	contentPartAdded,
	contentPartDone,
	customToolCallInputDelta,
	customToolCallInputDone,
	formatSseEvent,
	functionCallArgumentsDelta,
	functionCallArgumentsDone,
	OPTIONAL_IGNORED_TYPES,
	outputItemAdded,
	outputItemDone,
	outputTextDelta,
	outputTextDone,
	reasoningSummaryTextDelta,
	reasoningSummaryTextDone,
	responseCompleted,
	responseCreated,
	responseFailed,
	responseInProgress,
} from "../src/server/responses/events.js";

const messageDone = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: "Hello", annotations: [] }],
} as const;

describe("Responses state events", () => {
	test("created, in_progress, completed, and failed share a complete response shape", () => {
		const createdAt = 1_700_000_000;
		const configuration = {
			instructions: "exact instructions",
			maxOutputTokens: 4_096,
			reasoningEffort: "minimal",
			toolChoice: "none",
			tools: [
				{
					type: "function",
					name: "read",
					parameters: { type: "object" },
					strict: false,
				},
				{ type: "custom", name: "shell" },
			],
		} as const;
		const created = responseCreated({
			responseId: "resp_1",
			model: "auto",
			sequenceNumber: 0,
			createdAt,
			configuration,
		});
		const inProgress = responseInProgress({
			responseId: "resp_1",
			model: "auto",
			sequenceNumber: 1,
			createdAt,
			configuration,
		});
		const usage = { input_tokens: 10, output_tokens: 4, total_tokens: 14 };
		const completed = responseCompleted({
			responseId: "resp_1",
			model: "auto",
			output: [messageDone],
			usage,
			sequenceNumber: 2,
			createdAt,
			completedAt: createdAt + 2,
			configuration,
		});
		const failed = responseFailed({
			responseId: "resp_1",
			model: "auto",
			error: { code: "upstream_error", message: "failed" },
			sequenceNumber: 3,
			createdAt,
			configuration,
		});

		for (const event of [created, inProgress, completed, failed]) {
			expect(event.response).toMatchObject({
				id: "resp_1",
				object: "response",
				created_at: createdAt,
				model: "auto",
				background: false,
				incomplete_details: null,
				instructions: "exact instructions",
				max_output_tokens: 4_096,
				max_tool_calls: null,
				metadata: {},
				parallel_tool_calls: true,
				previous_response_id: null,
				reasoning: { effort: "minimal", summary: null },
				service_tier: null,
				store: false,
				text: { format: { type: "text" } },
				tool_choice: "none",
				tools: configuration.tools,
				temperature: null,
				top_logprobs: null,
				top_p: null,
				truncation: "disabled",
				user: null,
			});
		}
		expect(created.response).toMatchObject({
			status: "in_progress",
			completed_at: null,
			output: [],
			usage: null,
		});
		expect(inProgress.response.status).toBe("in_progress");
		expect(completed.response).toMatchObject({
			status: "completed",
			completed_at: createdAt + 2,
			output: [messageDone],
			usage,
		});
		expect(failed.response).toMatchObject({
			status: "failed",
			completed_at: null,
			error: { code: "upstream_error", message: "failed" },
		});
	});
});

describe("Responses item/content lifecycle events", () => {
	test("constructors preserve ids, indices, bytes, and monotonically supplied sequence", () => {
		const part = { type: "output_text", text: "", annotations: [] } as const;
		const events = [
			outputItemAdded({
				item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] },
				outputIndex: 0,
				sequenceNumber: 0,
			}),
			contentPartAdded({
				itemId: "msg_1",
				outputIndex: 0,
				contentIndex: 0,
				part,
				sequenceNumber: 1,
			}),
			outputTextDelta({
				itemId: "msg_1",
				outputIndex: 0,
				contentIndex: 0,
				delta: "Hello {",
				sequenceNumber: 2,
			}),
			outputTextDone({
				itemId: "msg_1",
				outputIndex: 0,
				contentIndex: 0,
				text: "Hello {",
				sequenceNumber: 3,
			}),
			contentPartDone({
				itemId: "msg_1",
				outputIndex: 0,
				contentIndex: 0,
				part: { ...part, text: "Hello {" },
				sequenceNumber: 4,
			}),
			outputItemDone({ item: messageDone, outputIndex: 0, sequenceNumber: 5 }),
		];

		expect(events.map((event) => event.sequence_number)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(events.map((event) => event.type)).toEqual([
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_text.done",
			"response.content_part.done",
			"response.output_item.done",
		]);
		expect(events[2]).toMatchObject({ delta: "Hello {" });
	});

	test("reasoning and function/custom tool done events retain complete accumulated values", () => {
		expect(
			reasoningSummaryTextDelta({
				itemId: "rs_1",
				outputIndex: 0,
				summaryIndex: 0,
				delta: "plan",
				sequenceNumber: 0,
			}),
		).toMatchObject({ type: "response.reasoning_summary_text.delta", delta: "plan" });
		expect(
			reasoningSummaryTextDone({
				itemId: "rs_1",
				outputIndex: 0,
				summaryIndex: 0,
				text: "plan",
				sequenceNumber: 1,
			}),
		).toMatchObject({ type: "response.reasoning_summary_text.done", text: "plan" });
		expect(
			functionCallArgumentsDelta({
				itemId: "fc_1",
				outputIndex: 1,
				delta: '{"x":',
				sequenceNumber: 2,
			}),
		).toMatchObject({ type: "response.function_call_arguments.delta", delta: '{"x":' });
		expect(
			functionCallArgumentsDone({
				itemId: "fc_1",
				outputIndex: 1,
				arguments: '{"x":1}',
				sequenceNumber: 3,
			}),
		).toMatchObject({ type: "response.function_call_arguments.done", arguments: '{"x":1}' });
		expect(
			customToolCallInputDelta({
				itemId: "ctc_1",
				outputIndex: 2,
				delta: "raw {",
				sequenceNumber: 4,
			}),
		).toMatchObject({ type: "response.custom_tool_call_input.delta", delta: "raw {" });
		expect(
			customToolCallInputDone({
				itemId: "ctc_1",
				outputIndex: 2,
				input: "raw {",
				sequenceNumber: 5,
			}),
		).toMatchObject({ type: "response.custom_tool_call_input.done", input: "raw {" });
	});
});

describe("Responses event type registry and SSE serialization", () => {
	test("lists every emitted core and optional tool lifecycle type", () => {
		expect(CODEX_RECOGNIZED_TYPES).toEqual([
			"response.created",
			"response.in_progress",
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_text.done",
			"response.content_part.done",
			"response.output_item.done",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.done",
			"response.completed",
			"response.failed",
		]);
		expect(OPTIONAL_IGNORED_TYPES).toEqual([
			"response.function_call_arguments.delta",
			"response.function_call_arguments.done",
			"response.custom_tool_call_input.delta",
			"response.custom_tool_call_input.done",
		]);
	});

	test("formats matching event and data type lines", () => {
		const event = outputItemDone({ item: messageDone, outputIndex: 0, sequenceNumber: 9 });
		const serialized = formatSseEvent(event);
		expect(serialized).toBe(
			`event: response.output_item.done\ndata: ${JSON.stringify(event)}\n\n`,
		);
	});
});
