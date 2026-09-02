import type {
	OutputTextContent,
	ResponseError,
	ResponseOutputItem,
	ResponseRequestConfiguration,
	ResponseStateObject,
	ResponseUsage,
	SummaryText,
} from "./state.js";
import { responseState } from "./state.js";

export type {
	CustomToolCallOutputItem,
	FunctionCallOutputItem,
	MessageOutputItem,
	OutputTextContent,
	ReasoningOutputItem,
	ResponseError,
	ResponseOutputItem,
	ResponseToolCallItem,
	ResponseUsage,
	SummaryText,
} from "./state.js";

export const CODEX_RECOGNIZED_TYPES = [
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.delta",
  "response.output_text.done",
  "response.content_part.done",
  "response.output_item.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.completed",
  "response.failed",
] as const;

// Codex ignores these event types; they exist only for stricter Responses clients.
export const OPTIONAL_IGNORED_TYPES = [
  "response.reasoning_summary_part.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta",
  "response.custom_tool_call_input.done",
] as const;

export type CodexRecognizedType = (typeof CODEX_RECOGNIZED_TYPES)[number];
export type OptionalIgnoredType = (typeof OPTIONAL_IGNORED_TYPES)[number];

export type ResponseCreatedEvent = {
  readonly type: "response.created";
  readonly sequence_number: number;
  readonly response: ResponseStateObject;
};

export type ResponseInProgressEvent = {
  readonly type: "response.in_progress";
  readonly sequence_number: number;
  readonly response: ResponseStateObject;
};

export type OutputItemAddedEvent = {
  readonly type: "response.output_item.added";
  readonly sequence_number: number;
  readonly output_index: number;
  readonly item: ResponseOutputItem;
};

export type OutputTextDeltaEvent = {
  readonly type: "response.output_text.delta";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly delta: string;
};

export type ContentPartAddedEvent = {
  readonly type: "response.content_part.added";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly part: OutputTextContent;
};

export type OutputTextDoneEvent = {
  readonly type: "response.output_text.done";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly text: string;
};

export type ContentPartDoneEvent = {
  readonly type: "response.content_part.done";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
  readonly part: OutputTextContent;
};

export type ReasoningSummaryPartAddedEvent = {
  readonly type: "response.reasoning_summary_part.added";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly summary_index: number;
  readonly part: SummaryText;
};

export type ReasoningSummaryPartDoneEvent = {
  readonly type: "response.reasoning_summary_part.done";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly summary_index: number;
  readonly part: SummaryText;
};

export type ReasoningSummaryTextDeltaEvent = {
  readonly type: "response.reasoning_summary_text.delta";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly summary_index: number;
  readonly delta: string;
};

export type ReasoningSummaryTextDoneEvent = {
  readonly type: "response.reasoning_summary_text.done";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly summary_index: number;
  readonly text: string;
};

export type OutputItemDoneEvent = {
  readonly type: "response.output_item.done";
  readonly sequence_number: number;
  readonly output_index: number;
  readonly item: ResponseOutputItem;
};

export type ResponseCompletedEvent = {
  readonly type: "response.completed";
  readonly sequence_number: number;
  readonly response: ResponseStateObject;
};

export type ResponseFailedEvent = {
  readonly type: "response.failed";
  readonly sequence_number: number;
  readonly response: ResponseStateObject;
};

export type FunctionCallArgumentsDeltaEvent = {
  readonly type: "response.function_call_arguments.delta";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly delta: string;
};

export type FunctionCallArgumentsDoneEvent = {
  readonly type: "response.function_call_arguments.done";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly arguments: string;
};

export type CustomToolCallInputDeltaEvent = {
  readonly type: "response.custom_tool_call_input.delta";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly delta: string;
};

export type CustomToolCallInputDoneEvent = {
  readonly type: "response.custom_tool_call_input.done";
  readonly sequence_number: number;
  readonly item_id: string;
  readonly output_index: number;
  readonly input: string;
};

export type ResponsesEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | OutputItemAddedEvent
  | ContentPartAddedEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | ContentPartDoneEvent
  | ReasoningSummaryPartAddedEvent
  | ReasoningSummaryPartDoneEvent
  | ReasoningSummaryTextDeltaEvent
  | ReasoningSummaryTextDoneEvent
  | OutputItemDoneEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent
  | CustomToolCallInputDeltaEvent
  | CustomToolCallInputDoneEvent;

export function responseCreated(input: {
  readonly responseId: string;
  readonly model: string;
  readonly sequenceNumber: number;
  readonly createdAt?: number;
  readonly configuration?: ResponseRequestConfiguration;
}): ResponseCreatedEvent {
  return {
    type: "response.created",
    sequence_number: input.sequenceNumber,
    response: responseState({
      id: input.responseId,
      model: input.model,
      status: "in_progress",
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.configuration !== undefined ? { configuration: input.configuration } : {}),
    }),
  };
}

export function responseInProgress(input: {
  readonly responseId: string;
  readonly model: string;
  readonly sequenceNumber: number;
  readonly createdAt?: number;
  readonly configuration?: ResponseRequestConfiguration;
}): ResponseInProgressEvent {
  return {
    type: "response.in_progress",
    sequence_number: input.sequenceNumber,
    response: responseState({
      id: input.responseId,
      model: input.model,
      status: "in_progress",
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.configuration !== undefined ? { configuration: input.configuration } : {}),
    }),
  };
}

export function outputItemAdded(input: {
  readonly item: ResponseOutputItem;
  readonly outputIndex: number;
  readonly sequenceNumber: number;
}): OutputItemAddedEvent {
  return {
    type: "response.output_item.added",
    sequence_number: input.sequenceNumber,
    output_index: input.outputIndex,
    item: input.item,
  };
}

export function outputTextDelta(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly contentIndex: number;
  readonly delta: string;
  readonly sequenceNumber: number;
}): OutputTextDeltaEvent {
  return {
    type: "response.output_text.delta",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    content_index: input.contentIndex,
    delta: input.delta,
  };
}

export function contentPartAdded(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly contentIndex: number;
  readonly part: OutputTextContent;
  readonly sequenceNumber: number;
}): ContentPartAddedEvent {
  return {
    type: "response.content_part.added",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    content_index: input.contentIndex,
    part: input.part,
  };
}

export function outputTextDone(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly contentIndex: number;
  readonly text: string;
  readonly sequenceNumber: number;
}): OutputTextDoneEvent {
  return {
    type: "response.output_text.done",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    content_index: input.contentIndex,
    text: input.text,
  };
}

export function contentPartDone(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly contentIndex: number;
  readonly part: OutputTextContent;
  readonly sequenceNumber: number;
}): ContentPartDoneEvent {
  return {
    type: "response.content_part.done",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    content_index: input.contentIndex,
    part: input.part,
  };
}

export function reasoningSummaryPartAdded(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly summaryIndex: number;
  readonly part: SummaryText;
  readonly sequenceNumber: number;
}): ReasoningSummaryPartAddedEvent {
  return {
    type: "response.reasoning_summary_part.added",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    summary_index: input.summaryIndex,
    part: input.part,
  };
}

export function reasoningSummaryPartDone(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly summaryIndex: number;
  readonly part: SummaryText;
  readonly sequenceNumber: number;
}): ReasoningSummaryPartDoneEvent {
  return {
    type: "response.reasoning_summary_part.done",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    summary_index: input.summaryIndex,
    part: input.part,
  };
}

export function reasoningSummaryTextDelta(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly summaryIndex: number;
  readonly delta: string;
  readonly sequenceNumber: number;
}): ReasoningSummaryTextDeltaEvent {
  return {
    type: "response.reasoning_summary_text.delta",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    summary_index: input.summaryIndex,
    delta: input.delta,
  };
}

export function reasoningSummaryTextDone(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly summaryIndex: number;
  readonly text: string;
  readonly sequenceNumber: number;
}): ReasoningSummaryTextDoneEvent {
  return {
    type: "response.reasoning_summary_text.done",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    summary_index: input.summaryIndex,
    text: input.text,
  };
}

export function outputItemDone(input: {
  readonly item: ResponseOutputItem;
  readonly outputIndex: number;
  readonly sequenceNumber: number;
}): OutputItemDoneEvent {
  return {
    type: "response.output_item.done",
    sequence_number: input.sequenceNumber,
    output_index: input.outputIndex,
    item: input.item,
  };
}

export function responseCompleted(input: {
  readonly responseId: string;
  readonly model: string;
  readonly output: readonly ResponseOutputItem[];
  readonly usage: ResponseUsage;
  readonly sequenceNumber: number;
  readonly createdAt?: number;
  readonly completedAt?: number;
  readonly configuration?: ResponseRequestConfiguration;
}): ResponseCompletedEvent {
  return {
    type: "response.completed",
    sequence_number: input.sequenceNumber,
    response: responseState({
      id: input.responseId,
      model: input.model,
      status: "completed",
      output: input.output,
      usage: input.usage,
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
      ...(input.configuration !== undefined ? { configuration: input.configuration } : {}),
    }),
  };
}

export function responseFailed(input: {
  readonly responseId: string;
  readonly model: string;
  readonly error: ResponseError;
  readonly sequenceNumber: number;
  readonly createdAt?: number;
  readonly configuration?: ResponseRequestConfiguration;
}): ResponseFailedEvent {
  return {
    type: "response.failed",
    sequence_number: input.sequenceNumber,
    response: responseState({
      id: input.responseId,
      model: input.model,
      status: "failed",
      error: input.error,
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.configuration !== undefined ? { configuration: input.configuration } : {}),
    }),
  };
}

export function functionCallArgumentsDelta(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly delta: string;
  readonly sequenceNumber: number;
}): FunctionCallArgumentsDeltaEvent {
  return {
    type: "response.function_call_arguments.delta",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    delta: input.delta,
  };
}

export function customToolCallInputDelta(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly delta: string;
  readonly sequenceNumber: number;
}): CustomToolCallInputDeltaEvent {
  return {
    type: "response.custom_tool_call_input.delta",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    delta: input.delta,
  };
}

export function functionCallArgumentsDone(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly arguments: string;
  readonly sequenceNumber: number;
}): FunctionCallArgumentsDoneEvent {
  return {
    type: "response.function_call_arguments.done",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    arguments: input.arguments,
  };
}

export function customToolCallInputDone(input: {
  readonly itemId: string;
  readonly outputIndex: number;
  readonly input: string;
  readonly sequenceNumber: number;
}): CustomToolCallInputDoneEvent {
  return {
    type: "response.custom_tool_call_input.done",
    sequence_number: input.sequenceNumber,
    item_id: input.itemId,
    output_index: input.outputIndex,
    input: input.input,
  };
}

export function formatSseEvent(event: ResponsesEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
