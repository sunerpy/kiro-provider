import { describe, expect, test } from 'bun:test'
import { collectSdkResponse } from '../src/kiro/transform/sdk-collector.js'
import type {
  SdkReasoningCapture,
  SdkStreamEvent
} from '../src/kiro/transform/streaming/sdk-stream-runtime.js'
import type { CanonicalAssistantOutput } from '../src/protocol/canonical.js'
import { makeSdkResponse } from './sdk-stream-test-helpers.js'

const SIGNED_REASONING: readonly SdkStreamEvent[] = [
  { reasoningContentEvent: { text: 'plan ' } },
  { reasoningContentEvent: { text: 'carefully', signature: 'sig-1' } },
  { assistantResponseEvent: { content: 'answer' } },
  { toolUseEvent: { name: 'read', toolUseId: 'tool-1', input: '{"path":"a"}', stop: true } }
]

describe('collectSdkResponse consumes the SDK output transformer', () => {
  test('rejects conflicting reasoning signatures with invalid_upstream_reasoning', async () => {
    await expect(
      collectSdkResponse(
        makeSdkResponse([
          { reasoningContentEvent: { text: 'reason', signature: 'sig-a' } },
          { reasoningContentEvent: { signature: 'sig-b' } }
        ]),
        'claude-opus-5',
        'conflict',
        undefined,
        { emitAnthropicReasoningMetadata: true }
      )
    ).rejects.toMatchObject({
      name: 'SdkStreamProtocolError',
      code: 'invalid_upstream_reasoning'
    })
  })

  test('rejects mixed visible and redacted reasoning with invalid_upstream_reasoning', async () => {
    await expect(
      collectSdkResponse(
        makeSdkResponse([
          { reasoningContentEvent: { text: 'visible', signature: 'sig' } },
          { reasoningContentEvent: { redactedContent: Uint8Array.from([1, 2, 3]) } }
        ]),
        'claude-opus-5',
        'mixed',
        undefined,
        { emitAnthropicReasoningMetadata: true }
      )
    ).rejects.toMatchObject({ code: 'invalid_upstream_reasoning' })
  })

  test('keeps dropping ambiguous reasoning metadata silently for non-Anthropic protocols', async () => {
    const completion = await collectSdkResponse(
      makeSdkResponse([
        { reasoningContentEvent: { text: 'reason', signature: 'sig-a' } },
        { reasoningContentEvent: { signature: 'sig-b' } },
        { assistantResponseEvent: { content: 'answer' } }
      ]),
      'auto',
      'lenient'
    )

    expect(completion.text).toBe('answer')
    expect(completion.reasoning).toEqual({ text: 'reason' })
  })

  test('folds Anthropic signature and redacted metadata into the completion', async () => {
    const signed = await collectSdkResponse(
      makeSdkResponse(SIGNED_REASONING),
      'claude-opus-5',
      'signed',
      undefined,
      { emitAnthropicReasoningMetadata: true }
    )
    expect(signed.reasoning).toEqual({ text: 'plan carefully', signature: 'sig-1' })
    expect(signed.text).toBe('answer')
    expect(signed.toolCalls).toEqual([{ id: 'tool-1', name: 'read', input: '{"path":"a"}' }])
    expect(signed.finishReason).toBe('tool_calls')

    const redacted = await collectSdkResponse(
      makeSdkResponse([
        { reasoningContentEvent: { redactedContent: Uint8Array.from([1, 2, 3]) } },
        { assistantResponseEvent: { content: 'answer' } }
      ]),
      'claude-opus-5',
      'redacted',
      undefined,
      { emitAnthropicReasoningMetadata: true }
    )
    expect(redacted.reasoning).toEqual({
      redactedContent: Buffer.from([1, 2, 3]).toString('base64')
    })

    const withoutMetadata = await collectSdkResponse(
      makeSdkResponse(SIGNED_REASONING),
      'claude-opus-5',
      'plain'
    )
    expect(withoutMetadata.reasoning).toEqual({ text: 'plan carefully' })
  })

  test('invokes capture callbacks once with the transformer output and fingerprint', async () => {
    const captures: Array<{ capture: SdkReasoningCapture; fingerprint: string }> = []
    const outputs: Array<{ output: CanonicalAssistantOutput; fingerprint: string }> = []
    const completion = await collectSdkResponse(
      makeSdkResponse(SIGNED_REASONING),
      'claude-opus-5',
      'callbacks',
      undefined,
      {
        emitEncryptedReasoning: true,
        fingerprintOutput: () => 'fingerprint-1',
        captureReasoning: (capture, fingerprint) => {
          captures.push({ capture, fingerprint })
          return `kr1.${fingerprint}`
        },
        captureOutput: (output, fingerprint) => {
          outputs.push({ output, fingerprint })
        }
      }
    )

    expect(captures).toEqual([
      {
        capture: { text: 'plan carefully', signature: 'sig-1' },
        fingerprint: 'fingerprint-1'
      }
    ])
    expect(outputs).toEqual([
      {
        output: {
          text: 'answer',
          toolCalls: [{ id: 'tool-1', name: 'read', input: '{"path":"a"}' }]
        },
        fingerprint: 'fingerprint-1'
      }
    ])
    expect(completion.reasoning).toEqual({
      text: 'plan carefully',
      encryptedContent: 'kr1.fingerprint-1'
    })
  })

  test('exposes the raw-event and completion-witness audit hooks', async () => {
    const rawEvents: string[][] = []
    const witnesses: string[] = []
    await collectSdkResponse(
      makeSdkResponse([
        { assistantResponseEvent: { content: 'answer' } },
        { toolUseEvent: { name: 'read', toolUseId: 'tool-1', input: '{}', stop: true } }
      ]),
      'auto',
      'audit',
      undefined,
      {
        onRawEvent: (eventTypes) => {
          rawEvents.push([...eventTypes])
        },
        onCompletionWitness: (kind) => {
          witnesses.push(kind)
        }
      }
    )

    expect(rawEvents).toEqual([['assistantResponseEvent'], ['toolUseEvent'], ['metadataEvent']])
    expect(witnesses).toEqual(['token-usage-metadata'])
  })

  test('reports a missing event stream with the collector error class', async () => {
    await expect(collectSdkResponse({}, 'auto', 'missing')).rejects.toMatchObject({
      name: 'MissingSdkEventStreamError'
    })
  })
})
