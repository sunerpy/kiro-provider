/** Retry-After delta-seconds or HTTP date; absent/invalid values remain unknown. */
export function retryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Number(text) * 1_000;
    return Number.isFinite(milliseconds) ? Math.min(milliseconds, 2_147_483_647) : undefined;
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(text)) return undefined;
  const date = Date.parse(text.endsWith("GMT") ? text : `${text} GMT`);
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), 2_147_483_647) : undefined;
}
