/**
 * Stateful fakes. FakeShopify models the documented token rules closely enough to
 * catch ordering bugs:
 * - refresh rotation (offline-access-tokens#token-refresh): the presented refresh
 *   token stays usable until the app uses the newer one; using the newer one
 *   retires it. Retired/unknown tokens get 401 {"error":"invalid_request"}.
 * - migration (migrate-to-expiring-offline-access-tokens): migrating invalidates
 *   the old token for API calls; repeating the same request within 7 days returns
 *   the same pair until that pair is refreshed.
 * It is a model, not Shopify. Real behavior must be checked against a dev store.
 */
import type { FetchLike, ShopLock, TokenRecord, TokenStorage } from '../src/index.js';

export class FakeClock {
  t = 1_800_000_000_000;
  now = () => this.t;
  advance(seconds: number) {
    this.t += seconds * 1000;
  }
}

export class FakeStorage implements TokenStorage {
  records = new Map<string, TokenRecord>();
  setKeys: string[] = [];
  deletes: string[] = [];
  failNextSets = 0;
  async get(shop: string) {
    const r = this.records.get(shop);
    return r ? { ...r } : undefined;
  }
  async set(shop: string, record: TokenRecord) {
    if (this.failNextSets > 0) {
      this.failNextSets--;
      throw new Error('storage write failed');
    }
    this.setKeys.push(shop);
    this.records.set(shop, { ...record });
  }
  async delete(shop: string) {
    this.deletes.push(shop);
    this.records.delete(shop);
  }
}

/** A cross-process lock shared by several guard instances (one per "process"). */
export class FakeSharedLock implements ShopLock {
  private tails = new Map<string, Promise<void>>();
  async withLock<T>(shop: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(shop) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tails.set(shop, prev.then(() => mine));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface RefreshTok {
  shop: string;
  /** epoch ms; 90 days after issue */
  exp: number;
  predecessor?: string;
  retired: boolean;
  /** pair produced the first time this token was presented */
  issuedFromMe?: string;
}

export type Fault = 'network' | 500 | 503 | 429 | 400 | 403;

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  params: Record<string, string>;
}

export class FakeShopify {
  clock: FakeClock;
  calls: Call[] = [];
  faults: Fault[] = [];
  /** Make the success body omit expires_in (the #3400 response). */
  omitExpiresIn = false;
  omitRefreshToken = false;
  /** Shops that uninstalled the app: every refresh is 401. */
  uninstalled = new Set<string>();
  delayMs = 0;
  /** Hook run after the request is "processed" by Shopify, before the response returns. */
  beforeRespond?: (call: Call) => Promise<void> | void;

  private seq = 0;
  refreshTokens = new Map<string, RefreshTok>();
  /** access token -> expiry ms (non-expiring: Infinity) */
  accessTokens = new Map<string, { shop: string; exp: number; legacy: boolean; valid: boolean }>();
  migrations = new Map<string, { access: string; refresh: string; at: number }>();

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  issuePair(shop: string, predecessor?: string) {
    const n = ++this.seq;
    // Real prefixes seen on a dev store 2026-10-22: shpua_ (access, both legacy and expiring), shprt_ (refresh).
    const access = `shpua_exp_${shop}_${n}`;
    const refresh = `shprt_${shop}_${n}`;
    this.accessTokens.set(access, { shop, exp: this.clock.now() + 3600_000, legacy: false, valid: true });
    this.refreshTokens.set(refresh, { shop, exp: this.clock.now() + 7776000_000, predecessor, retired: false });
    return { access, refresh };
  }

  addLegacyToken(shop: string) {
    const access = `shpua_legacy_${shop}_${++this.seq}`;
    this.accessTokens.set(access, { shop, exp: Infinity, legacy: true, valid: true });
    return access;
  }

  /** Simulates an Admin API call: 200 when the access token is valid, else 401. */
  api(token: string): { status: number } {
    const t = this.accessTokens.get(token);
    if (!t || !t.valid || this.clock.now() >= t.exp) return { status: 401 };
    return { status: 200 };
  }

  get tokenCalls() {
    return this.calls.length;
  }

  fetch: FetchLike = async (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(init.body));
    const call: Call = { url, method: init.method, headers: { ...init.headers }, params };
    this.calls.push(call);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const fault = this.faults.shift();
    if (fault === 'network') throw new TypeError('fetch failed');
    if (typeof fault === 'number') return resp(fault, { error: 'fault' });

    const shop = new URL(url).hostname;
    let out: { status: number; body: unknown };
    if (params['grant_type'] === 'refresh_token') out = this.refresh(shop, params['refresh_token'] ?? '');
    else if (params['grant_type'] === 'urn:ietf:params:oauth:grant-type:token-exchange') out = this.migrate(shop, params);
    else out = { status: 400, body: { error: 'unsupported_grant_type' } };
    if (this.beforeRespond) await this.beforeRespond(call);
    return resp(out.status, out.body);
  };

  /**
   * Field names and order as returned by a real dev store (2026-10-22):
   * access_token, scope, expires_in, refresh_token, refresh_token_expires_in.
   * Lifetimes are the time LEFT on the pair, as Shopify reports them: a fresh pair
   * came back as 3599/3600 and 7775999, and a repeated migration request returned
   * the same pair with expires_in counting down (3598). Once the access token is
   * past its expiry the fake reports 0 (real value after expiry: not observed).
   */
  private pairBody(access: string, refresh: string) {
    const now = this.clock.now();
    const a = this.accessTokens.get(access);
    const r = this.refreshTokens.get(refresh);
    const left = (exp: number | undefined, full: number) => (exp === undefined ? full : Math.max(0, Math.floor((exp - now) / 1000)));
    const body: Record<string, unknown> = { access_token: access, scope: 'read_products' };
    if (!this.omitExpiresIn) body['expires_in'] = left(a?.exp, 3600);
    if (!this.omitRefreshToken) body['refresh_token'] = refresh;
    body['refresh_token_expires_in'] = left(r?.exp, 7776000);
    return body;
  }

  private refresh(shop: string, token: string) {
    const rt = this.refreshTokens.get(token);
    if (this.uninstalled.has(shop) || !rt || rt.retired || rt.shop !== shop || this.clock.now() >= rt.exp) {
      return {
        status: 401,
        body: { error: 'invalid_request', error_description: 'This request requires an active refresh_token' },
      };
    }
    // Presenting this token proves the previous one was received: retire it.
    if (rt.predecessor) {
      const p = this.refreshTokens.get(rt.predecessor);
      if (p) p.retired = true;
    }
    // Using a migrated pair ends migration recovery.
    for (const [legacy, m] of this.migrations) if (m.refresh === token) this.migrations.delete(legacy);
    const { access, refresh } = this.issuePair(shop, token);
    return { status: 200, body: this.pairBody(access, refresh) };
  }

  private migrate(shop: string, p: Record<string, string>) {
    const okShape =
      p['subject_token_type'] === 'urn:shopify:params:oauth:token-type:offline-access-token' &&
      p['requested_token_type'] === 'urn:shopify:params:oauth:token-type:offline-access-token' &&
      p['expiring'] === '1';
    if (!okShape) return { status: 400, body: { error: 'invalid_requested_token_type' } };
    const subject = p['subject_token'] ?? '';
    const prior = this.migrations.get(subject);
    if (prior && this.clock.now() - prior.at <= 7 * 86400_000) {
      return { status: 200, body: this.pairBody(prior.access, prior.refresh) }; // same pair on retry
    }
    const t = this.accessTokens.get(subject);
    if (!t || !t.legacy || !t.valid || t.shop !== shop) return { status: 400, body: { error: 'invalid_subject_token' } };
    t.valid = false; // "Migration permanently invalidates the old token"
    const { access, refresh } = this.issuePair(shop);
    this.migrations.set(subject, { access, refresh, at: this.clock.now() });
    return { status: 200, body: this.pairBody(access, refresh) };
  }
}

function resp(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}

export const SHOP = 'demo-shop.myshopify.com';

/** Seeds storage with a fresh expiring pair issued by the fake. */
export function seedExpiring(shopify: FakeShopify, storage: FakeStorage, clock: FakeClock, shop = SHOP, ttlLeftSec = 3600) {
  const { access, refresh } = shopify.issuePair(shop);
  const rec: TokenRecord = {
    shop,
    accessToken: access,
    refreshToken: refresh,
    expiresAt: clock.now() + ttlLeftSec * 1000,
    refreshTokenExpiresAt: clock.now() + 7776000_000,
  };
  storage.records.set(shop, rec);
  return rec;
}

export const noSleep = async () => {};
