import {
  InvalidShopError,
  NoSessionError,
  NotRefreshableError,
  ReauthorizeRequiredError,
  RefreshRejectedError,
  TransientRefreshError,
} from './errors.js';
import type { FetchLike, TokenGuardOptions, TokenRecord, TokenResponseBody } from './types.js';

// Doc URLs cited next to the request shapes below.
const DOC_REFRESH =
  'https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange#refresh-an-expiring-offline-token';
const DOC_MIGRATE =
  'https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens#migrate-existing-tokens-without-a-user-session';
const DOC_ROTATION =
  'https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens#token-refresh';
void DOC_ROTATION;

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Accepts only `<name>.myshopify.com` (case-insensitive). The token endpoint is
 * documented as `https://{shop}.myshopify.com/admin/oauth/access_token`, and the
 * request carries your client secret, so any other host is refused.
 */
export function normalizeShop(shop: string): string {
  const s = String(shop ?? '').trim().toLowerCase();
  if (!SHOP_RE.test(s)) throw new InvalidShopError(String(shop));
  return s;
}

/** True when the record holds an expiring token that is due (or whose expiry is unknown). */
export function needsRefresh(record: TokenRecord, now: number, marginSeconds = 60): boolean {
  if (!record.refreshToken) return false; // non-expiring token: nothing to refresh
  if (record.expiresAt == null || !Number.isFinite(record.expiresAt)) return true; // #3400: unknown expiry => refresh, never "never"
  return now >= record.expiresAt - marginSeconds * 1000;
}

/**
 * Matches the documented 403 for non-expiring tokens after the deadline. The docs
 * say the `errors` value "contains `Non-expiring access tokens are no longer
 * accepted for the Admin API`, followed by a migration link, so match on that
 * phrase rather than the whole string" and that a missing scope also returns 403.
 * https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens#handle-errors-during-the-transition
 */
export function isNonExpiringTokenRejected(errorsValue: unknown): boolean {
  let text: string;
  try {
    text = typeof errorsValue === 'string' ? errorsValue : JSON.stringify(errorsValue);
  } catch {
    return false;
  }
  return typeof text === 'string' && text.includes('Non-expiring access tokens are no longer accepted');
}

/** Finite number of seconds (string or number), or null when absent/unusable. */
function finiteSeconds(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Default rule for "this call was rejected as unauthorized" in withValidToken. */
export function defaultIsUnauthorized(value: unknown): boolean {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const resp = v['response'] as Record<string, unknown> | undefined;
  return (
    v['status'] === 401 ||
    v['statusCode'] === 401 ||
    v['networkStatusCode'] === 401 ||
    (resp != null && typeof resp === 'object' && resp['status'] === 401)
  );
}

class ShopMutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export interface WithValidTokenOptions {
  /** Decide whether fn's result (or thrown error) means "401 Unauthorized". Default checks status/statusCode/networkStatusCode/response.status === 401. */
  isUnauthorized?: (resultOrError: unknown) => boolean;
}

export type MigrationResult =
  | { status: 'migrated'; record: TokenRecord }
  | { status: 'already-expiring'; record: TokenRecord };

export interface TokenGuard {
  /**
   * Refreshes the shop's expiring offline token. Concurrent callers for the same
   * shop share one in-flight request. Without `force`, a token that is not yet due
   * is returned as is (no network call). With `force`, it refreshes unless another
   * caller already replaced the access token this caller saw.
   */
  refreshOfflineToken(shop: string, opts?: { force?: boolean }): Promise<TokenRecord>;
  /** One-time exchange of a stored non-expiring token for an expiring pair. */
  migrateToExpiring(shop: string): Promise<MigrationResult>;
  /** Ensures a fresh token, calls fn(accessToken); on a 401 refreshes once and retries fn once. */
  withValidToken<T>(shop: string, fn: (accessToken: string) => Promise<T>, opts?: WithValidTokenOptions): Promise<T>;
  /**
   * Runs YOUR token acquisition (ID-token exchange or authorization code grant,
   * with `expiring=1`) inside the same per-shop lock as refresh, then stores the
   * result. Shopify: "Don't do the two at the same time for the same store.
   * Acquiring a token and refreshing one each retire the other's result."
   */
  acquireToken(shop: string, exchange: () => Promise<TokenResponseBody>): Promise<TokenRecord>;
}

export function createTokenGuard(options: TokenGuardOptions): TokenGuard {
  const {
    clientId,
    clientSecret,
    storage,
    lock,
    refreshMarginSeconds = 60,
    assumedTtlSeconds = 900,
    maxAttempts = 3,
    timeoutMs = 30_000,
    deleteOnReauthorize = true,
  } = options;
  if (!clientId || !clientSecret) throw new TypeError('clientId and clientSecret are required');
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw new TypeError('storage with get(shop) and set(shop, record) is required');
  }
  const fetchImpl: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== 'function') throw new TypeError('No fetch available; pass options.fetch');
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoffMs = options.backoffMs ?? ((n: number) => 500 * 2 ** (n - 1));

  const mutex = new ShopMutex();
  const inflight = new Map<string, Promise<TokenRecord>>();

  const locked = <T>(shop: string, fn: () => Promise<T>): Promise<T> =>
    mutex.run(shop, () => (lock ? lock.withLock(shop, fn) : fn()));

  /** POST to the documented token endpoint, retrying only transient failures. */
  async function postToken(shop: string, params: URLSearchParams): Promise<{ status: number; body: unknown }> {
    const url = `https://${shop}/admin/oauth/access_token`;
    let lastStatus: number | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
      if (attempt > 1) await sleep(backoffMs(attempt - 1));
      let res: { status: number; text(): Promise<string> };
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: params.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastError = err; // network error or timeout: the docs say retrying with the same token is safe
        lastStatus = undefined;
        continue;
      }
      // "Transient failures, such as network errors, timeouts, 5xx responses, and 429
      // responses, are safe to retry with the same refresh_token." (DOC_REFRESH)
      if (res.status === 429 || res.status >= 500) {
        lastStatus = res.status;
        lastError = undefined;
        continue;
      }
      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        lastError = err;
        lastStatus = undefined;
        continue;
      }
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      return { status: res.status, body };
    }
    throw new TransientRefreshError(
      shop,
      `Token request for ${shop} failed after ${maxAttempts} attempt(s)` + (lastStatus ? ` (last status ${lastStatus})` : ''),
      { status: lastStatus, cause: lastError },
    );
  }

  /**
   * Builds a record from a documented token response. Returns null when the body
   * lacks the fields we need, so the caller can refuse to persist it.
   */
  function recordFromBody(
    shop: string,
    body: unknown,
    requireRefreshToken: boolean,
    extra: Partial<TokenRecord> = {},
  ): TokenRecord | null {
    if (body == null || typeof body !== 'object') return null;
    const b = body as TokenResponseBody;
    const accessToken = nonEmptyString(b.access_token);
    const refreshToken = nonEmptyString(b.refresh_token);
    if (!accessToken) return null;
    if (requireRefreshToken && !refreshToken) return null;
    const t = now();
    // Lifetimes are the time LEFT on the pair: a repeated migration request on a real
    // dev store returned the same pair with expires_in counting down. A value <= 0
    // therefore means "already expired" (due now), not "unknown".
    const ttlRaw = finiteSeconds(b.expires_in);
    const rttlRaw = finiteSeconds(b.refresh_token_expires_in);
    const ttl = ttlRaw == null ? null : Math.max(0, ttlRaw);
    const rttl = rttlRaw == null ? null : Math.max(0, rttlRaw);
    const record: TokenRecord = {
      shop,
      accessToken,
      refreshToken: refreshToken ?? null,
      // With a refresh token, a missing expires_in must not mean "never expires"
      // (shopify-app-js #3400). Assume a short lifetime so it is refreshed early.
      // Without a refresh token it is a non-expiring token and has no expiry.
      expiresAt: ttl != null ? t + ttl * 1000 : refreshToken ? t + assumedTtlSeconds * 1000 : null,
      expiresAtAssumed: ttl == null && refreshToken != null ? true : undefined,
      refreshTokenExpiresAt: rttl != null ? t + rttl * 1000 : null,
      updatedAt: t,
      ...extra,
    };
    const scope = nonEmptyString(b.scope);
    if (scope) record.scope = scope;
    if (record.expiresAtAssumed === undefined) delete record.expiresAtAssumed;
    return record;
  }

  async function doRefresh(shop: string, force: boolean, seenAccessToken: string | undefined): Promise<TokenRecord> {
    return locked(shop, async () => {
      // Re-read inside the lock: another caller or process may have refreshed already.
      const current = await storage.get(shop);
      if (!current) throw new NoSessionError(shop);
      if (!current.refreshToken) throw new NotRefreshableError(shop);
      if (seenAccessToken !== undefined && current.accessToken !== seenAccessToken) return current;
      if (!force && !needsRefresh(current, now(), refreshMarginSeconds)) return current;

      const presented = current.refreshToken;
      // Request shape, exactly as documented at DOC_REFRESH:
      //   POST https://{shop}.myshopify.com/admin/oauth/access_token
      //   Content-Type: application/x-www-form-urlencoded
      //   client_id, client_secret, grant_type=refresh_token, refresh_token
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: presented,
      });
      const { status, body } = await postToken(shop, params);

      if (status === 401) {
        // DOC_REFRESH: "Treat that 401 as final: stop retrying, and re-authenticate".
        // Delete only if the stored record still holds the token we presented, so a
        // newer pair written by an acquisition is never wiped.
        if (deleteOnReauthorize && typeof storage.delete === 'function') {
          const again = await storage.get(shop);
          if (again && again.refreshToken === presented) await storage.delete(shop);
        }
        throw new ReauthorizeRequiredError(shop, status);
      }
      if (status < 200 || status >= 300) {
        throw new RefreshRejectedError(shop, `Refresh for ${shop} rejected with HTTP ${status}`, { status, body });
      }
      const next = recordFromBody(shop, body, true, current.migratedAt ? { migratedAt: current.migratedAt } : {});
      if (!next) {
        // Not persisted. Per the rotation rules (DOC_ROTATION) the refresh token we
        // presented "stays usable until your app uses the one Shopify issued in its
        // place", so keeping the old record lets a later attempt succeed.
        throw new RefreshRejectedError(shop, `Refresh for ${shop} returned no access_token/refresh_token; nothing stored`, {
          status,
          body: '[redacted]',
        });
      }
      if (next.scope === undefined && current.scope) next.scope = current.scope;
      // One upsert replaces the old pair with the new one. If this write throws, the
      // old record (and its still-usable refresh token) is what remains stored.
      await storage.set(shop, next);
      return next;
    });
  }

  function singleFlight(shop: string, force: boolean, seen: string | undefined): Promise<TokenRecord> {
    const p = doRefresh(shop, force, seen).finally(() => {
      if (inflight.get(shop) === p) inflight.delete(shop);
    });
    inflight.set(shop, p);
    return p;
  }

  async function refreshInternal(shop: string, force: boolean, seen: string | undefined): Promise<TokenRecord> {
    const existing = inflight.get(shop);
    if (existing) {
      const r = await existing;
      // Joined result is good enough unless we were forcing past a token that is still the same one.
      if (!force || seen === undefined || r.accessToken !== seen) return r;
      // The shared refresh did not replace the token we saw; run our own (or join a newer one).
      const newer = inflight.get(shop);
      if (newer && newer !== existing) return refreshInternal(shop, force, seen);
    }
    return singleFlight(shop, force, seen);
  }

  return {
    async refreshOfflineToken(shopIn, opts = {}) {
      const shop = normalizeShop(shopIn);
      const force = opts.force === true;
      let seen: string | undefined;
      if (force) {
        const rec = await storage.get(shop);
        if (!rec) throw new NoSessionError(shop);
        seen = rec.accessToken;
      }
      return refreshInternal(shop, force, seen);
    },

    async migrateToExpiring(shopIn) {
      const shop = normalizeShop(shopIn);
      return locked(shop, async (): Promise<MigrationResult> => {
        const current = await storage.get(shop);
        if (!current) throw new NoSessionError(shop);
        if (current.refreshToken) return { status: 'already-expiring', record: current };

        // Request shape, exactly as documented at DOC_MIGRATE:
        //   POST https://{shop}.myshopify.com/admin/oauth/access_token
        //   Content-Type: application/x-www-form-urlencoded
        //   grant_type=urn:ietf:params:oauth:grant-type:token-exchange, client_id, client_secret,
        //   subject_token={non_expiring_offline_token},
        //   subject_token_type=urn:shopify:params:oauth:token-type:offline-access-token,
        //   requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token,
        //   expiring=1
        // Retrying transient failures is safe: "repeat the same migration request with
        // the original non-expiring token ... within seven days of the initial
        // exchange. Eligible retries return the same token pair." (DOC_MIGRATE)
        const params = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: clientId,
          client_secret: clientSecret,
          subject_token: current.accessToken,
          subject_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
          requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
          expiring: '1',
        });
        const { status, body } = await postToken(shop, params);
        if (status < 200 || status >= 300) {
          // Documented 400s: invalid_subject_token / invalid_requested_token_type.
          // The stored record is left exactly as it was.
          throw new RefreshRejectedError(shop, `Migration for ${shop} rejected with HTTP ${status}`, { status, body });
        }
        const next = recordFromBody(shop, body, true, { migratedAt: now() });
        if (!next) {
          throw new RefreshRejectedError(shop, `Migration for ${shop} returned no access_token/refresh_token; nothing stored`, {
            status,
            body: '[redacted]',
          });
        }
        if (next.scope === undefined && current.scope) next.scope = current.scope;
        // Persist the new pair (with migratedAt) in one write, and only then is the old
        // token gone. If this write throws, the old record stays, and the same request
        // can be repeated within 7 days to get the same pair back (DOC_MIGRATE).
        await storage.set(shop, next);
        return { status: 'migrated', record: next };
      });
    },

    async withValidToken<T>(shopIn: string, fn: (accessToken: string) => Promise<T>, opts: WithValidTokenOptions = {}): Promise<T> {
      const shop = normalizeShop(shopIn);
      const isUnauthorized = opts.isUnauthorized ?? defaultIsUnauthorized;
      let record = await storage.get(shop);
      if (!record) throw new NoSessionError(shop);
      if (needsRefresh(record, now(), refreshMarginSeconds)) record = await refreshInternal(shop, false, undefined);

      let firstResult: unknown;
      let firstError: unknown;
      let threw = false;
      try {
        firstResult = await fn(record.accessToken);
      } catch (err) {
        threw = true;
        firstError = err;
      }
      const unauthorized = isUnauthorized(threw ? firstError : firstResult);
      if (!unauthorized || !record.refreshToken) {
        if (threw) throw firstError;
        return firstResult as T;
      }
      // One refresh (shared with any concurrent caller), then exactly one retry.
      const fresh = await refreshInternal(shop, true, record.accessToken);
      return fn(fresh.accessToken);
    },

    async acquireToken(shopIn, exchange) {
      const shop = normalizeShop(shopIn);
      return locked(shop, async () => {
        const body = await exchange();
        const prev = await storage.get(shop);
        const next = recordFromBody(shop, body, false);
        if (!next) throw new RefreshRejectedError(shop, `Token acquisition for ${shop} returned no access_token; nothing stored`);
        if (next.scope === undefined && prev?.scope) next.scope = prev.scope;
        await storage.set(shop, next);
        return next;
      });
    },
  };
}
