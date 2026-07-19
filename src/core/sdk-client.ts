import {
  CodeWhispererStreamingClient,
  type CodeWhispererStreamingClientConfig
} from '@aws/codewhisperer-streaming-client'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { HttpRequest } from '@smithy/protocol-http'
import { KIRO_CONSTANTS } from '../kiro/constants.js'
import { buildEffortRequestFields } from '../kiro/effort.js'
import type { Effort, KiroAuthDetails } from '../kiro/types.js'
import { createProxyAgent } from './proxy.js'

interface ClientCacheEntry {
  readonly client: CodeWhispererStreamingClient
  readonly token: string
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wireModelFromBody(body: Record<string, unknown>): string | undefined {
  const conversationState = body.conversationState
  if (!isRecord(conversationState)) return undefined
  const currentMessage = conversationState.currentMessage
  if (!isRecord(currentMessage)) return undefined
  const userInputMessage = currentMessage.userInputMessage
  if (!isRecord(userInputMessage)) return undefined
  const modelId = userInputMessage.modelId
  return typeof modelId === 'string' ? modelId : undefined
}

export function buildClientConfig(
  auth: KiroAuthDetails,
  region: string,
  resolvedEndpoint: string,
  proxyUrl?: string
): CodeWhispererStreamingClientConfig {
  const requestHandler = proxyUrl
    ? (() => {
        const proxyAgent = createProxyAgent(proxyUrl)
        return new NodeHttpHandler({ httpAgent: proxyAgent, httpsAgent: proxyAgent })
      })()
    : undefined

  return {
    region,
    endpoint: resolvedEndpoint,
    token: () => Promise.resolve({ token: auth.access }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]],
    ...(requestHandler ? { requestHandler } : {})
  }
}

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  endpoint?: string,
  proxyUrl?: string
): CodeWhispererStreamingClient {
  const resolvedEndpoint = endpoint ?? `https://q.${region}.amazonaws.com`
  const cacheKey = JSON.stringify([
    region,
    auth.email ?? null,
    effort ?? null,
    resolvedEndpoint,
    proxyUrl ?? null
  ])
  const cached = clientCache.get(cacheKey)
  if (cached?.token === auth.access) return cached.client

  const client = new CodeWhispererStreamingClient(
    buildClientConfig(auth, region, resolvedEndpoint, proxyUrl)
  )

  client.middlewareStack.add(
    (next) => async (args) => {
      if (args.request instanceof HttpRequest) {
        args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      }
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  if (effort) {
    client.middlewareStack.add(
      (next) => async (args) => {
        if (args.request instanceof HttpRequest && typeof args.request.body === 'string') {
          try {
            const parsed: unknown = JSON.parse(args.request.body)
            if (isRecord(parsed)) {
              const wireModel = wireModelFromBody(parsed)
              if (wireModel) {
                parsed.additionalModelRequestFields = buildEffortRequestFields(wireModel, effort)
                args.request.body = JSON.stringify(parsed)
              }
            }
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'high' }
    )
  }

  clientCache.set(cacheKey, { client, token: auth.access })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) entry.client.destroy()
  clientCache.clear()
}
