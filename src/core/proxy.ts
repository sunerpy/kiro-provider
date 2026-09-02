export function resolveProxyUrl(config: {
  readonly proxy_url?: string | null;
}): string | undefined {
  return config.proxy_url || undefined;
}

export function fetchProxyOption(proxyUrl?: string): { proxy?: string } {
  return proxyUrl === undefined ? {} : { proxy: proxyUrl };
}
