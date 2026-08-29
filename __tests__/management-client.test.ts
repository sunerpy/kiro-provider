import { afterEach, describe, expect, test } from 'bun:test'
import {
  KiroManagementError,
  listAvailableModels
} from '../src/kiro/management-client.js'
import type { KiroAuthDetails } from '../src/kiro/types.js'

const originalFetch = globalThis.fetch
type FetchHandler = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>

const auth: KiroAuthDetails = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  authMethod: 'desktop',
  region: 'us-east-1',
  email: 'test@example.com',
  profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/test'
}

function useFetch(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Kiro management model catalog client', () => {
  test('sends the truthful management request and parses only valid model entries', async () => {
    const externalSignal = new AbortController().signal
    useFetch(async (input, init) => {
        const url = new URL(String(input))
        const headers = new Headers(init?.headers)
        const body = JSON.parse(String(init?.body))

        expect(url.origin).toBe('https://management.us-east-1.kiro.dev')
        expect(url.searchParams.get('origin')).toBe('AI_EDITOR')
        expect(url.searchParams.get('profileArn')).toBe(auth.profileArn ?? null)
        expect(init?.method).toBe('POST')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        expect(headers.get('authorization')).toBe('Bearer access-token')
        expect(headers.get('content-type')).toBe('application/x-amz-json-1.0')
        expect(headers.get('x-amz-target')).toBe(
          'AmazonCodeWhispererService.ListAvailableModels'
        )
        expect(headers.get('user-agent')).toBeTruthy()
        expect(body).toEqual({
          origin: 'AI_EDITOR',
          profileArn: auth.profileArn
        })
        expect((init as RequestInit & { proxy?: string }).proxy).toBe(
          'http://127.0.0.1:3128'
        )

        return Response.json({
          defaultModel: { modelId: 'model-1' },
          models: [
            {
              modelId: ' model-1 ',
              modelName: ' Model One ',
              description: 'description',
              supportedInputTypes: ['TEXT', 'IMAGE', 'AUDIO'],
              tokenLimits: {
                maxInputTokens: 100_000,
                maxOutputTokens: 20_000
              },
              rateMultiplier: 0.5,
              additionalModelRequestFieldsSchema: {
                type: 'object'
              }
            },
            null,
            {
              modelId: 'invalid',
              modelName: 'Invalid',
              tokenLimits: { maxInputTokens: 0, maxOutputTokens: 1 }
            }
          ]
        })
      })

    const result = await listAvailableModels(auth, 'us-east-1', {
      proxyUrl: 'http://127.0.0.1:3128',
      signal: externalSignal,
      timeoutMs: 1_000
    })

    expect(result).toEqual({
      defaultModelId: 'model-1',
      models: [
        {
          modelId: 'model-1',
          modelName: 'Model One',
          description: 'description',
          supportedInputTypes: ['TEXT', 'IMAGE'],
          tokenLimits: {
            maxInputTokens: 100_000,
            maxOutputTokens: 20_000
          },
          rateMultiplier: 0.5,
          additionalModelRequestFieldsSchema: {
            type: 'object'
          }
        }
      ]
    })
  })

  test('omits profile fields when the account has no profile ARN', async () => {
    useFetch(async (input, init) => {
        const url = new URL(String(input))
        expect(url.searchParams.has('profileArn')).toBe(false)
        expect(JSON.parse(String(init?.body))).toEqual({
          origin: 'AI_EDITOR'
        })
        return Response.json({
          models: [
            {
              modelId: 'model-2',
              modelName: 'Model Two',
              supportedInputTypes: [],
              tokenLimits: {
                maxInputTokens: 1,
                maxOutputTokens: 1
              }
            }
          ]
        })
      })

    const result = await listAvailableModels(
      { ...auth, profileArn: undefined },
      'eu-central-1'
    )

    expect(result.defaultModelId).toBeUndefined()
    expect(result.models[0]?.modelId).toBe('model-2')
  })

  test('wraps transport, HTTP, JSON, and shape failures', async () => {
    useFetch(async () => {
      throw new Error('offline')
    })
    await expect(listAvailableModels(auth, 'us-east-1')).rejects.toMatchObject({
      name: 'KiroManagementError',
      message: 'Unable to reach the Kiro model catalog service',
      status: undefined,
      cause: expect.any(Error)
    })

    useFetch(async () => new Response('busy', { status: 503 }))
    await expect(listAvailableModels(auth, 'us-east-1')).rejects.toMatchObject({
      name: 'KiroManagementError',
      message: 'Kiro model catalog returned HTTP 503',
      status: 503
    })

    useFetch(async () => new Response('{', { status: 200 }))
    await expect(listAvailableModels(auth, 'us-east-1')).rejects.toMatchObject({
      name: 'KiroManagementError',
      message: 'Kiro model catalog returned invalid JSON',
      status: 200,
      cause: expect.any(Error)
    })

    for (const payload of [
      { models: {} },
      {
        models: [
          {
            modelId: '',
            modelName: 'Invalid',
            tokenLimits: {
              maxInputTokens: 1,
              maxOutputTokens: 1
            }
          }
        ]
      }
    ]) {
      useFetch(async () => Response.json(payload))
      await expect(listAvailableModels(auth, 'us-east-1')).rejects.toBeInstanceOf(
        KiroManagementError
      )
    }
  })
})
