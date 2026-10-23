/**
 * Bridge for apps on @shopify/shopify-app-express (and anything else that stores
 * @shopify/shopify-api Session objects).
 *
 * WHY: shopify-app-express 8.0.0 added the `expiringOfflineAccessTokens` future
 * flag, but its CHANGELOG says existing installs "keep their current non-expiring
 * token until the next OAuth" and that `ensureValidOfflineSession` "will not
 * upgrade a non-expiring token". So every Express app with existing installs still
 * has to run the one-time migration exchange itself before 2027-01-01.
 * https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-app-express/CHANGELOG.md
 *
 * This file adapts the app's own SessionStorage to TokenStorage, and runs the
 * migration one shop at a time ("Refresh one store at a time").
 * Structural types only: no dependency on the Shopify packages.
 */
import type { TokenRecord, TokenStorage } from './types.js';
import type { TokenGuard } from './guard.js';
import { normalizeShop } from './guard.js';

/** The fields of @shopify/shopify-api's Session that this bridge reads and writes. */
export interface SessionLike {
  id: string;
  shop: string;
  isOnline: boolean;
  accessToken?: string;
  scope?: string;
  expires?: Date;
  refreshToken?: string;
  refreshTokenExpires?: Date;
  [key: string]: unknown;
}

/** The subset of @shopify/shopify-app-session-storage's SessionStorage used here. */
export interface SessionStorageLike<S extends SessionLike = SessionLike> {
  storeSession(session: S): Promise<boolean>;
  loadSession(id: string): Promise<S | undefined>;
  deleteSession(id: string): Promise<boolean>;
}

/** Same id scheme as shopify-api's getOfflineId: `offline_${shop}`. */
export const offlineSessionId = (shop: string) => `offline_${normalizeShop(shop)}`;

/**
 * TokenStorage backed by the app's SessionStorage. `set` writes the new token
 * fields onto the existing offline Session (keeping every other field), so the
 * Express package keeps working with the same row. `makeSession` builds a Session
 * when none exists (pass `(data) => new Session(data)` from @shopify/shopify-api).
 */
export function sessionTokenStorage<S extends SessionLike>(
  sessions: SessionStorageLike<S>,
  makeSession: (data: SessionLike) => S,
): TokenStorage {
  return {
    async get(shop) {
      const s = await sessions.loadSession(offlineSessionId(shop));
      if (!s || s.isOnline || !s.accessToken) return undefined;
      const rec: TokenRecord = {
        shop: normalizeShop(s.shop),
        accessToken: s.accessToken,
        refreshToken: s.refreshToken ?? null,
        expiresAt: s.expires ? s.expires.getTime() : null,
        refreshTokenExpiresAt: s.refreshTokenExpires ? s.refreshTokenExpires.getTime() : null,
      };
      if (s.scope !== undefined) rec.scope = s.scope;
      return rec;
    },
    async set(shop, record) {
      const id = offlineSessionId(shop);
      const existing = await sessions.loadSession(id);
      const base: SessionLike = existing ?? { id, shop: normalizeShop(shop), isOnline: false, state: '' };
      const next = makeSession({
        ...base,
        id,
        isOnline: false,
        accessToken: record.accessToken,
        ...(record.scope !== undefined ? { scope: record.scope } : {}),
        expires: record.expiresAt != null ? new Date(record.expiresAt) : undefined,
        refreshToken: record.refreshToken ?? undefined,
        refreshTokenExpires: record.refreshTokenExpiresAt != null ? new Date(record.refreshTokenExpiresAt) : undefined,
      });
      const ok = await sessions.storeSession(next);
      if (!ok) throw new Error(`storeSession returned false for ${id}`);
    },
    async delete(shop) {
      await sessions.deleteSession(offlineSessionId(shop));
    },
  };
}

export interface BatchReport {
  migrated: string[];
  alreadyExpiring: string[];
  skippedNoSession: string[];
  failed: { shop: string; error: string }[];
  dryRun: boolean;
}

/**
 * Migrates each shop in turn (never in parallel). A failure on one shop is
 * recorded and the run continues; the old token stays stored for that shop
 * (migrateToExpiring writes only after a successful exchange).
 * With dryRun, it only reports which shops still hold a non-expiring token.
 */
export async function migrateShops(
  guard: TokenGuard,
  storage: TokenStorage,
  shops: Iterable<string>,
  opts: { dryRun?: boolean; onProgress?: (shop: string, outcome: string) => void } = {},
): Promise<BatchReport> {
  const report: BatchReport = { migrated: [], alreadyExpiring: [], skippedNoSession: [], failed: [], dryRun: !!opts.dryRun };
  const seen = new Set<string>();
  for (const raw of shops) {
    let shop: string;
    try {
      shop = normalizeShop(raw);
    } catch (e) {
      report.failed.push({ shop: String(raw), error: (e as Error).message });
      continue;
    }
    if (seen.has(shop)) continue;
    seen.add(shop);
    const rec = await storage.get(shop);
    let outcome: string;
    if (!rec) {
      report.skippedNoSession.push(shop);
      outcome = 'no-session';
    } else if (rec.refreshToken) {
      report.alreadyExpiring.push(shop);
      outcome = 'already-expiring';
    } else if (opts.dryRun) {
      report.migrated.push(shop);
      outcome = 'would-migrate';
    } else {
      try {
        const r = await guard.migrateToExpiring(shop);
        if (r.status === 'migrated') report.migrated.push(shop);
        else report.alreadyExpiring.push(shop);
        outcome = r.status;
      } catch (e) {
        report.failed.push({ shop, error: (e as Error).name + ': ' + (e as Error).message });
        outcome = 'failed';
      }
    }
    opts.onProgress?.(shop, outcome);
  }
  return report;
}
