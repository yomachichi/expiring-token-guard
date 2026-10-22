/**
 * One stored offline token per shop. Your storage keeps exactly one record per
 * shop key: `set` REPLACES, it never appends (see TokenStorage).
 */
export interface TokenRecord {
  shop: string;
  accessToken: string;
  /** Present only for expiring tokens. A record without it is a non-expiring token. */
  refreshToken?: string | null;
  /** Epoch ms when the access token expires. null/undefined on an expiring record means "unknown": treated as due for refresh. */
  expiresAt?: number | null;
  /** Epoch ms when the refresh token expires, from `refresh_token_expires_in`, if Shopify sent it. */
  refreshTokenExpiresAt?: number | null;
  /** True when Shopify's response had no usable `expires_in` and we assumed a short lifetime instead. */
  expiresAtAssumed?: boolean;
  scope?: string;
  /** Epoch ms when this record was produced by the one-time migration exchange. */
  migratedAt?: number;
  /** Epoch ms when this record was written by this library. */
  updatedAt?: number;
}

/**
 * Pluggable storage. Must be keyed by shop: `set` is an upsert that replaces the
 * previous record for that shop. If your backend keeps a secondary index (for
 * example a KV "shop -> session ids" list, the shape behind
 * https://github.com/Shopify/shopify-app-js/issues/3478), add the id only if it is
 * not already present.
 */
export interface TokenStorage {
  get(shop: string): Promise<TokenRecord | undefined | null>;
  set(shop: string, record: TokenRecord): Promise<void>;
  /** Optional. Used after a terminal 401 on refresh and on app/uninstalled. */
  delete?(shop: string): Promise<void>;
}

/**
 * Optional cross-process lock (Redis, Postgres advisory lock, Durable Object...).
 * An in-process per-shop mutex is always applied as well. Without this, two app
 * instances can still refresh the same shop at the same time, which Shopify's docs
 * warn against ("Refresh one store at a time").
 */
export interface ShopLock {
  withLock<T>(shop: string, fn: () => Promise<T>): Promise<T>;
}

/** The subset of `fetch` this library uses. The global `fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Body of a token response, as documented (field names snake_case, as Shopify sends them). */
export interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  refresh_token_expires_in?: unknown;
  scope?: unknown;
  [key: string]: unknown;
}

export interface TokenGuardOptions {
  clientId: string;
  clientSecret: string;
  storage: TokenStorage;
  lock?: ShopLock;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Refresh this many seconds before expiry. Default 60 (the value Shopify's own Node example uses). */
  refreshMarginSeconds?: number;
  /**
   * Lifetime to assume when a response carries a refresh token but no usable
   * `expires_in`. Default 900 (15 minutes), well under the documented 1 hour, so
   * the token is refreshed early instead of never (shopify-app-js #3400).
   */
  assumedTtlSeconds?: number;
  /** Attempts per token request for transient failures (network, timeout, 429, 5xx). Default 3. */
  maxAttempts?: number;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Backoff before attempt n+1 (n starts at 1). Default 500ms * 2^(n-1). */
  backoffMs?: (attempt: number) => number;
  /** Delete the stored record after a terminal 401 on refresh (as Shopify's Node example does). Default true. */
  deleteOnReauthorize?: boolean;
  /** Clock, for tests. */
  now?: () => number;
  /** Sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
}
