/**
 * Post-retrieval domain filtering for hosted web search.
 *
 * InvokeMCP accepts only a query, so filters are applied to the retrieved
 * sources before the model sees them; the query is never rewritten. Matching
 * uses the normalized host of each source URL, never the backend `domain`
 * field. Rules follow the public contracts:
 *
 * - an entry is a bare ASCII host with an optional path, no scheme or port;
 * - a host entry also matches its subdomains (`example.com` covers
 *   `docs.example.com`), while `docs.example.com` matches only that subtree;
 * - a path matches on segment boundaries (`/blog` matches `/blog/x`, not
 *   `/blogger`); `*` is allowed in the path only and matches any characters.
 */

export const MAX_DOMAIN_FILTER_ENTRIES = 100;
const MAX_HOST_LENGTH = 253;
const MAX_PATH_LENGTH = 1024;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export interface DomainRule {
  readonly host: string;
  /** Path prefix pattern starting with `/`, without a trailing slash. */
  readonly path?: string;
}

export interface DomainFilter {
  readonly mode: "allow" | "block";
  readonly rules: readonly DomainRule[];
}

export type DomainRuleParse =
  | { readonly ok: true; readonly rule: DomainRule }
  | { readonly ok: false; readonly reason: string };

export function parseDomainRule(entry: unknown, allowPath: boolean): DomainRuleParse {
  if (typeof entry !== "string") return { ok: false, reason: "must be a string" };
  const value = entry.trim();
  if (value.length === 0 || value !== entry) {
    return { ok: false, reason: "must be a non-empty bare domain" };
  }
  if (!/^[\x21-\x7e]+$/.test(value)) {
    // Non-ASCII hosts can impersonate ASCII ones; require the punycode form.
    return { ok: false, reason: "must contain only printable ASCII characters" };
  }
  if (value.includes("://")) return { ok: false, reason: "must not include a URL scheme" };
  if (/[?#\\]/.test(value)) return { ok: false, reason: "must not include a query or fragment" };
  const slash = value.indexOf("/");
  const host = (slash < 0 ? value : value.slice(0, slash)).toLowerCase().replace(/\.$/, "");
  const rawPath = slash < 0 ? undefined : value.slice(slash);
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    return { ok: false, reason: "must name a host" };
  }
  if (host.includes("*")) return { ok: false, reason: "wildcards are only allowed in the path" };
  if (host.includes(":") || host.includes("@")) {
    return { ok: false, reason: "must not include a port or credentials" };
  }
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => !HOST_LABEL.test(label))) {
    return { ok: false, reason: "must be a valid domain name" };
  }
  if (rawPath === undefined) return { ok: true, rule: { host } };
  if (!allowPath) return { ok: false, reason: "paths are not supported for this tool" };
  if (rawPath.length > MAX_PATH_LENGTH || rawPath.includes("//")) {
    return { ok: false, reason: "has an invalid path" };
  }
  const path = rawPath.replace(/\/+$/, "");
  return { ok: true, rule: path.length === 0 ? { host } : { host, path } };
}

function hostMatches(rule: DomainRule, host: string): boolean {
  return host === rule.host || host.endsWith(`.${rule.host}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function pathMatches(rule: DomainRule, path: string): boolean {
  if (rule.path === undefined) return true;
  const pattern = rule.path
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");
  return new RegExp(`^${pattern}(?:/.*)?$`, "s").test(path);
}

/** Normalized host and path of an http(s) source URL, or undefined when unusable. */
export function sourceLocation(
  url: string,
): { readonly host: string; readonly path: string } | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    path = parsed.pathname;
  }
  return { host, path: path.length === 0 ? "/" : path };
}

export function ruleMatches(rule: DomainRule, url: string): boolean {
  const location = sourceLocation(url);
  return (
    location !== undefined && hostMatches(rule, location.host) && pathMatches(rule, location.path)
  );
}

/** True when the source survives the filter; an unparsable URL never does. */
export function domainFilterAccepts(filter: DomainFilter | undefined, url: string): boolean {
  if (sourceLocation(url) === undefined) return false;
  if (filter === undefined || filter.rules.length === 0) return true;
  const matched = filter.rules.some((rule) => ruleMatches(rule, url));
  return filter.mode === "allow" ? matched : !matched;
}
