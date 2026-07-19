import { DSML_MARKER, parseTextToolCalls } from '../tool-call-parser.js'
import type { ToolCall } from '../../types.js'

const OPENING_MARKERS = ['<function_calls', '<invoke name=', DSML_MARKER] as const
const MAX_MARKER_LENGTH = Math.max(...OPENING_MARKERS.map((marker) => marker.length))

function firstMarkerIndex(text: string): number {
  let earliest = -1
  for (const marker of OPENING_MARKERS) {
    const index = text.indexOf(marker)
    if (index !== -1 && (earliest === -1 || index < earliest)) earliest = index
  }
  return earliest
}

function partialMarkerTail(text: string): number {
  const maximumLength = Math.min(text.length, MAX_MARKER_LENGTH - 1)
  for (let length = maximumLength; length > 0; length--) {
    const tail = text.slice(text.length - length)
    for (const marker of OPENING_MARKERS) {
      if (marker.length > length && marker.startsWith(tail)) return length
    }
  }
  return 0
}

export interface DialectGateResult {
  readonly toolCalls: readonly ToolCall[]
  readonly remainderText: string
}

/** Suppresses streamed text-dialect tool calls until they can be parsed as a whole. */
export class DialectGate {
  private accumulated = ''
  private emitted = 0
  private markerSeen = false

  push(text: string): string {
    if (!text) return ''
    this.accumulated += text

    if (!this.markerSeen && firstMarkerIndex(this.accumulated) !== -1) {
      this.markerSeen = true
    }

    let safeEnd: number
    if (this.markerSeen) {
      const markerIndex = firstMarkerIndex(this.accumulated)
      safeEnd = markerIndex === -1 ? this.accumulated.length : markerIndex
    } else {
      safeEnd = this.accumulated.length - partialMarkerTail(this.accumulated)
    }

    if (safeEnd <= this.emitted) return ''
    const output = this.accumulated.slice(this.emitted, safeEnd)
    this.emitted = safeEnd
    return output
  }

  get suppressing(): boolean {
    return this.markerSeen
  }

  finalize(): DialectGateResult {
    const { toolCalls, cleanedText } = parseTextToolCalls(this.accumulated)
    const remainderText = cleanedText.length > this.emitted ? cleanedText.slice(this.emitted) : ''
    return { toolCalls, remainderText }
  }
}
