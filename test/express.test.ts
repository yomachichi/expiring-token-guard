import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenGuard, sessionTokenStorage, migrateShops, offlineSessionId } from '../src/index.js';
import type { SessionLike, SessionStorageLike } from '../src/index.js';
import { FakeClock, FakeShopify, noSleep } from './fakes.js';

/** Stateful in-memory stand-in for an @shopify/shopify-app-session-storage adapter. */
class FakeSessionStorage implements SessionStorageLike {
  rows = new Map<string, SessionLike>();
  stores = 0;
  failStores = 0;
  async storeSession(s: SessionLike) {
    if (this.failStores > 0) { this.failStores--; return false; }
    this.stores++;
    this.rows.set(s.id, { ...s });
    return true;
  }
  async loadSession(id: string) { const r = this.rows.get(id); return r ? { ...r } : undefined; }
  async deleteSession(id: string) { return this.rows.delete(id); }
}

const A = 'alpha.myshopify.com';
const B = 'bravo.myshopify.com';
const C = 'charlie.myshopify.com';

function setup() {
  const clock = new FakeClock();
  const shopify = new FakeShopify(clock);
  const sessions = new FakeSessionStorage();
  const storage = sessionTokenStorage(sessions, (d) => ({ ...d }));
  const guard = createTokenGuard({ clientId: 'cid', clientSecret: 'cs', storage, fetch: shopify.fetch, now: clock.now, sleep: noSleep });
  const legacy: Record<string, string> = {};
  for (const shop of [A, B]) {
    legacy[shop] = shopify.addLegacyToken(shop);
    sessions.rows.set(offlineSessionId(shop), { id: offlineSessionId(shop), shop, isOnline: false, state: 'x', scope: 'read_products', accessToken: legacy[shop], customField: 'keep-me' });
  }
  return { clock, shopify, sessions, storage, guard, legacy };
}

test('express session row is migrated in place: new pair written, other fields kept', async () => {
  const { shopify, sessions, guard, legacy, clock } = setup();
  const r = await guard.migrateToExpiring(A);
  assert.equal(r.status, 'migrated');
  const row = sessions.rows.get(offlineSessionId(A))!;
  assert.equal(row.customField, 'keep-me');
  assert.equal(row.state, 'x');
  assert.equal(row.isOnline, false);
  assert.ok(row.refreshToken?.startsWith('shprt_'));
  assert.ok(row.expires instanceof Date && row.expires.getTime() > clock.now());
  assert.ok(row.refreshTokenExpires instanceof Date);
  assert.notEqual(row.accessToken, legacy[A]);
  assert.equal(shopify.api(row.accessToken!).status, 200);
  assert.equal(shopify.api(legacy[A]!).status, 401);
});

test('batch: migrates one shop at a time, skips already-expiring and missing, reports each', async () => {
  const { shopify, guard, storage } = setup();
  await guard.migrateToExpiring(B); // B already done
  shopify.calls.length = 0;
  let inFlight = 0, maxInFlight = 0;
  shopify.beforeRespond = async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; };
  const rep = await migrateShops(guard, storage, [A, B, C, 'ALPHA.myshopify.com']);
  assert.deepEqual(rep.migrated, [A]);
  assert.deepEqual(rep.alreadyExpiring, [B]);
  assert.deepEqual(rep.skippedNoSession, [C]);
  assert.deepEqual(rep.failed, []);
  assert.equal(shopify.calls.length, 1, 'only A hit the token endpoint (duplicate A ignored)');
  assert.equal(maxInFlight, 1);
});

test('dry run makes zero token calls and zero writes', async () => {
  const { shopify, sessions, guard, storage } = setup();
  const before = sessions.stores;
  const rep = await migrateShops(guard, storage, [A, B], { dryRun: true });
  assert.deepEqual(rep.migrated, [A, B]);
  assert.equal(rep.dryRun, true);
  assert.equal(shopify.calls.length, 0);
  assert.equal(sessions.stores, before);
});

test('NEGATIVE CONTROL: rejected exchange keeps the old token row untouched and the batch continues', async () => {
  const { shopify, sessions, guard, storage, legacy } = setup();
  shopify.accessTokens.get(legacy[A]!)!.legacy = false; // Shopify refuses A's subject token
  const rep = await migrateShops(guard, storage, [A, B]);
  assert.equal(rep.failed.length, 1);
  assert.equal(rep.failed[0]!.shop, A);
  assert.deepEqual(rep.migrated, [B]);
  const rowA = sessions.rows.get(offlineSessionId(A))!;
  assert.equal(rowA.accessToken, legacy[A]);
  assert.equal(rowA.refreshToken, undefined);
});

test('NEGATIVE CONTROL: storeSession returning false surfaces as a failure, then a retry recovers the SAME pair', async () => {
  const { shopify, sessions, guard, storage, legacy } = setup();
  sessions.failStores = 1;
  const rep1 = await migrateShops(guard, storage, [A]);
  assert.equal(rep1.failed.length, 1, 'write failure must not be reported as migrated');
  assert.equal(sessions.rows.get(offlineSessionId(A))!.accessToken, legacy[A]);
  const rep2 = await migrateShops(guard, storage, [A]);
  assert.deepEqual(rep2.migrated, [A]);
  const row = sessions.rows.get(offlineSessionId(A))!;
  assert.equal(shopify.api(row.accessToken!).status, 200, 'retry within 7 days returned the same usable pair');
});

test('invalid shop host is refused without any network call', async () => {
  const { shopify, guard, storage } = setup();
  const rep = await migrateShops(guard, storage, ['evil.example.com']);
  assert.equal(rep.failed.length, 1);
  assert.equal(shopify.calls.length, 0);
});

test('online sessions are never treated as offline tokens', async () => {
  const { sessions, storage } = setup();
  sessions.rows.set(offlineSessionId(C), { id: offlineSessionId(C), shop: C, isOnline: true, accessToken: 'shpua_online' });
  assert.equal(await storage.get(C), undefined);
});
