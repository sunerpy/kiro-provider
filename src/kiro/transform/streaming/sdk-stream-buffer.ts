import { findRealTag } from './stream-helpers.js'
import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from './stream-state.js'
import {
  type StreamEvent,
  type StreamState,
  THINKING_END_TAG,
  THINKING_START_TAG
} from './types.js'

export function processAssistantText(text: string, streamState: StreamState): StreamEvent[] {
  streamState.buffer += text
  const events: StreamEvent[] = []

  while (streamState.buffer.length > 0) {
    if (!streamState.inThinking && !streamState.thinkingExtracted) {
      const startPosition = findRealTag(streamState.buffer, THINKING_START_TAG)
      if (startPosition !== -1) {
        const visibleText = streamState.buffer.slice(0, startPosition)
        events.push(...createTextDeltaEvents(visibleText, streamState))
        streamState.buffer = streamState.buffer.slice(startPosition + THINKING_START_TAG.length)
        streamState.inThinking = true
        continue
      }

      const safeLength = Math.max(0, streamState.buffer.length - THINKING_START_TAG.length)
      if (safeLength > 0) {
        events.push(...createTextDeltaEvents(streamState.buffer.slice(0, safeLength), streamState))
        streamState.buffer = streamState.buffer.slice(safeLength)
      }
      break
    }

    if (streamState.inThinking) {
      const endPosition = findRealTag(streamState.buffer, THINKING_END_TAG)
      if (endPosition !== -1) {
        events.push(
          ...createThinkingDeltaEvents(streamState.buffer.slice(0, endPosition), streamState)
        )
        streamState.buffer = streamState.buffer.slice(endPosition + THINKING_END_TAG.length)
        streamState.inThinking = false
        streamState.thinkingExtracted = true
        events.push(...createThinkingDeltaEvents('', streamState))
        events.push(...stopBlock(streamState.thinkingBlockIndex, streamState))
        if (streamState.buffer.startsWith('\n\n')) {
          streamState.buffer = streamState.buffer.slice(2)
        }
        continue
      }

      const safeLength = Math.max(0, streamState.buffer.length - THINKING_END_TAG.length)
      if (safeLength > 0) {
        events.push(
          ...createThinkingDeltaEvents(streamState.buffer.slice(0, safeLength), streamState)
        )
        streamState.buffer = streamState.buffer.slice(safeLength)
      }
      break
    }

    const visibleText = streamState.buffer
    streamState.buffer = ''
    events.push(...createTextDeltaEvents(visibleText, streamState))
  }

  return events
}

export function flushAssistantBuffer(streamState: StreamState): StreamEvent[] {
  if (!streamState.buffer) return []

  const bufferedText = streamState.buffer
  streamState.buffer = ''
  if (!streamState.inThinking) {
    return createTextDeltaEvents(bufferedText, streamState)
  }

  return [
    ...createThinkingDeltaEvents(bufferedText, streamState),
    ...createThinkingDeltaEvents('', streamState),
    ...stopBlock(streamState.thinkingBlockIndex, streamState)
  ]
}
