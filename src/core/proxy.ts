import { HttpsProxyAgent } from 'https-proxy-agent'

const proxyAgents = new Map<string, HttpsProxyAgent<string>>()

export function resolveProxyUrl(config: {
  readonly proxy_url?: string | null
}): string | undefined {
  return config.proxy_url || undefined
}

export function createProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  const cachedAgent = proxyAgents.get(proxyUrl)
  if (cachedAgent !== undefined) return cachedAgent

  const agent = new HttpsProxyAgent(proxyUrl, {
    keepAlive: true,
    maxSockets: 50
  })
  proxyAgents.set(proxyUrl, agent)
  return agent
}

export function fetchProxyOption(proxyUrl?: string): { proxy?: string } {
  return proxyUrl === undefined ? {} : { proxy: proxyUrl }
}
