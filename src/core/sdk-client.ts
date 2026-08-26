import { createHash } from 'node:crypto'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import {
  CodeWhispererStreamingClient,
  type CodeWhispererStreamingClientConfig
} from '@aws/codewhisperer-streaming-client'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { HttpRequest } from '@smithy/protocol-http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { KIRO_CONSTANTS } from '../kiro/constants.js'
import { buildEffortRequestFields } from '../kiro/effort.js'
import type { Effort, KiroAuthDetails } from '../kiro/types.js'
import { auditHash, auditLog } from './audit-log.js'

interface ClientCacheEntry {
  readonly client: CodeWhispererStreamingClient
  readonly tokenState: { value: string }
}

interface TransportCacheEntry {
  readonly handler: NodeHttpHandler
}

const clientCache = new Map<string, ClientCacheEntry>()
const transportCache = new Map<string, TransportCacheEntry>()
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

function mergeModelRequestFields(
  existing: unknown,
  additions: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged = isRecord(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(additions)) {
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value)
        ? mergeModelRequestFields(current, value)
        : value;
  }
  return merged;
}

export function buildClientConfig(
  auth: KiroAuthDetails,
  region: string,
  resolvedEndpoint: string,
  proxyUrl?: string,
  requestHandler: NodeHttpHandler = createRequestHandler(proxyUrl),
  tokenState: { value: string } = { value: auth.access }
): CodeWhispererStreamingClientConfig {
  return {
    region,
    endpoint: resolvedEndpoint,
    token: () => Promise.resolve({ token: tokenState.value }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]],
    requestHandler
  }
}

function createRequestHandler(proxyUrl?: string): NodeHttpHandler {
  if (proxyUrl) {
    const proxyAgent = new HttpsProxyAgent(proxyUrl, {
      keepAlive: true,
      maxSockets: 50
    })
    return new NodeHttpHandler({
      httpAgent: proxyAgent,
      httpsAgent: proxyAgent
    })
  }
  return new NodeHttpHandler({
    httpAgent: new HttpAgent({ keepAlive: true, maxSockets: 50 }),
    httpsAgent: new HttpsAgent({ keepAlive: true, maxSockets: 50 })
  })
}

function fallbackAccountKey(auth: KiroAuthDetails): string {
  return createHash('sha256')
    .update('kiro-provider-sdk-account-v1\0')
    .update(auth.email ?? auth.refresh)
    .digest('hex')
}

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  endpoint?: string,
  proxyUrl?: string,
  accountId?: string
): CodeWhispererStreamingClient {
  const resolvedEndpoint = endpoint ?? `https://q.${region}.amazonaws.com`
  const transportKey = JSON.stringify([
    accountId ?? fallbackAccountKey(auth),
    region,
    resolvedEndpoint,
    proxyUrl ?? null
  ])
  let transport = transportCache.get(transportKey)
  const transportPoolHit = transport !== undefined
  if (!transport) {
    transport = { handler: createRequestHandler(proxyUrl) }
    transportCache.set(transportKey, transport)
  }
  const cacheKey = JSON.stringify([transportKey, effort ?? null])
  const cached = clientCache.get(cacheKey)
  if (accountId !== undefined) {
    auditLog('info', 'sdk_connection_pool_selected', {
      account_hash: auditHash(accountId),
      region,
      effort: effort ?? null,
      transport_pool_hit: transportPoolHit,
      sdk_client_pool_hit: cached !== undefined
    })
  }
  if (cached) {
    cached.tokenState.value = auth.access
    return cached.client
  }

  const tokenState = { value: auth.access }
  const client = new CodeWhispererStreamingClient(
    buildClientConfig(
      auth,
      region,
      resolvedEndpoint,
      proxyUrl,
      transport.handler,
      tokenState
    )
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
                parsed.additionalModelRequestFields = mergeModelRequestFields(
                  parsed.additionalModelRequestFields,
                  buildEffortRequestFields(wireModel, effort)
                )
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

  clientCache.set(cacheKey, { client, tokenState })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of transportCache.values()) entry.handler.destroy()
  clientCache.clear()
  transportCache.clear()
}
