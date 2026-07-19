import { describe, expect, test } from 'bun:test'
import {
  type CodeWhispererStreamingClient,
  GenerateAssistantResponseCommand
} from '@aws/codewhisperer-streaming-client'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { HttpRequest } from '@smithy/protocol-http'
import { createProxyAgent } from '../src/core/proxy.js'
import { buildClientConfig, clearSdkClientCache, createSdkClient } from '../src/core/sdk-client.js'
import type { KiroAuthDetails } from '../src/kiro/types.js'

class CapturedRequestError extends Error {
  readonly name = 'CapturedRequestError'

  constructor() {
    super('request captured before transport')
  }
}

function makeAuth(): KiroAuthDetails {
  return {
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3_600_000,
    authMethod: 'idc',
    region: 'us-east-1',
    email: 'sdk-client@example.com'
  }
}

async function captureBuiltRequest(
  client: CodeWhispererStreamingClient,
  wireModel: string
): Promise<HttpRequest> {
  let capturedRequest: HttpRequest | undefined
  client.middlewareStack.add(
    () => async (args) => {
      if (!(args.request instanceof HttpRequest)) {
        throw new TypeError('expected a Smithy HttpRequest')
      }
      capturedRequest = args.request
      throw new CapturedRequestError()
    },
    { step: 'finalizeRequest', name: `captureRequest-${wireModel}`, priority: 'high' }
  )

  const command = new GenerateAssistantResponseCommand({
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'sdk-client-test',
      currentMessage: {
        userInputMessage: {
          content: 'hello',
          modelId: wireModel,
          origin: 'AI_EDITOR'
        }
      }
    }
  })

  try {
    await client.send(command)
  } catch (error) {
    if (!(error instanceof CapturedRequestError)) throw error
  }

  if (!capturedRequest) throw new TypeError('request middleware was not invoked')
  return capturedRequest
}

function parseRequestBody(request: HttpRequest): Record<string, unknown> {
  let bodyText: string
  if (typeof request.body === 'string') {
    bodyText = request.body
  } else if (request.body instanceof Uint8Array) {
    bodyText = new TextDecoder().decode(request.body)
  } else {
    throw new TypeError('expected a string or Uint8Array request body')
  }

  const parsed: unknown = JSON.parse(bodyText)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('expected a JSON object request body')
  }
  return parsed as Record<string, unknown>
}

async function resolveHandlerConfig(
  client: CodeWhispererStreamingClient
): Promise<ReturnType<NodeHttpHandler['httpHandlerConfigs']>> {
  const requestHandler = client.config.requestHandler
  if (!(requestHandler instanceof NodeHttpHandler)) {
    throw new TypeError('expected a NodeHttpHandler')
  }

  const abortController = new AbortController()
  abortController.abort()
  try {
    await requestHandler.handle(
      new HttpRequest({ protocol: 'http:', hostname: '127.0.0.1', method: 'GET', path: '/' }),
      { abortSignal: abortController.signal }
    )
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') throw error
  }

  return requestHandler.httpHandlerConfigs()
}

describe('createSdkClient', () => {
  test('sets Kiro headers and respects the injected endpoint', async () => {
    clearSdkClientCache()
    const client = createSdkClient(
      makeAuth(),
      'us-east-1',
      undefined,
      'http://127.0.0.1:43127/mock'
    )

    const request = await captureBuiltRequest(client, 'claude-sonnet-4.6')

    expect(request.headers['x-amzn-kiro-agent-mode']).toBe('vibe')
    expect(request.protocol).toBe('http:')
    expect(request.hostname).toBe('127.0.0.1')
    expect(request.port).toBe(43127)
    expect(request.path.startsWith('/mock')).toBe(true)
    expect(await client.config.maxAttempts()).toBe(3)
    const retryMode = client.config.retryMode
    expect(typeof retryMode === 'function' ? await retryMode() : retryMode).toBe('standard')
    clearSdkClientCache()
  })

  test('injects GPT effort using reasoning.effort for the wire model', async () => {
    clearSdkClientCache()
    const client = createSdkClient(makeAuth(), 'us-east-1', 'high')

    const request = await captureBuiltRequest(client, 'gpt-5.6-sol')
    const body = parseRequestBody(request)

    expect(body.additionalModelRequestFields).toEqual({ reasoning: { effort: 'high' } })
    clearSdkClientCache()
  })

  test('injects Claude effort using output_config.effort for the wire model', async () => {
    clearSdkClientCache()
    const client = createSdkClient(makeAuth(), 'us-east-1', 'max')

    const request = await captureBuiltRequest(client, 'claude-opus-4.8')
    const body = parseRequestBody(request)

    expect(body.additionalModelRequestFields).toEqual({ output_config: { effort: 'max' } })
    clearSdkClientCache()
  })

  test('configures the same proxy agent for HTTP and HTTPS endpoints', async () => {
    clearSdkClientCache()
    const proxyUrl = 'http://127.0.0.1:43128'
    const client = createSdkClient(
      makeAuth(),
      'us-east-1',
      undefined,
      'http://127.0.0.1:43127/mock',
      proxyUrl
    )

    const handlerConfig = await resolveHandlerConfig(client)
    const proxyAgent = createProxyAgent(proxyUrl)

    expect(handlerConfig.httpAgent).toBe(proxyAgent)
    expect(handlerConfig.httpsAgent).toBe(proxyAgent)
    clearSdkClientCache()
  })

  test('keeps the default request handler when no proxy is configured', async () => {
    clearSdkClientCache()
    const auth = makeAuth()
    const directConfig = buildClientConfig(auth, 'us-east-1', 'https://q.us-east-1.amazonaws.com')
    const client = createSdkClient(makeAuth(), 'us-east-1')

    expect('requestHandler' in directConfig).toBe(false)
    expect(client.config.requestHandler).toBeInstanceOf(NodeHttpHandler)
    clearSdkClientCache()
  })

  test('separates proxied and direct clients while caching identical proxy arguments', () => {
    clearSdkClientCache()
    const auth = makeAuth()
    const endpoint = 'http://127.0.0.1:43127/mock'
    const proxyUrl = 'http://127.0.0.1:43128'

    const proxiedClient = createSdkClient(auth, 'us-east-1', 'high', endpoint, proxyUrl)
    const cachedProxiedClient = createSdkClient(auth, 'us-east-1', 'high', endpoint, proxyUrl)
    const directClient = createSdkClient(auth, 'us-east-1', 'high', endpoint)

    expect(cachedProxiedClient).toBe(proxiedClient)
    expect(directClient).not.toBe(proxiedClient)
    clearSdkClientCache()
  })
})
