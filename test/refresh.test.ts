import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTokenGuard,
  needsRefresh,
  InvalidShopError,
  NotRefreshableError,
  ReauthorizeRequiredError,
  RefreshRejectedError,
  TransientRefreshError,
  NoSessionError,
} from '../src/index.js';
import { FakeClock, FakeShopify, FakeStorage, FakeSharedLock, SHOP, seedExpiring, noSleep } from './fakes.js';

function setup(extra: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const shopify = new FakeShopify(clock);
  const storage = new FakeStorage();
  const guard = createTokenGuard({
    clientId: 'cid',
    clientSecret: 'csecret',
    storage,
    fetch: shopify.fetch,
    now: clock.now,
    sleep: noSleep,
    ...extra,
  });
  return { clock, shopify, storage, guard };
}

test('refresh sends exactly the documented request shape', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  await guard.refreshOfflineToken(SHOP);
  assert.equal(shopify.calls.length, 1);
  const c = shopify.calls[0]!;
  assert.equal(c.url, `https://${SHOP}/admin/oauth/access_token`);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(c.params, {
    grant_type: 'refresh_token',
    client_id: 'cid',
    client_secret: 'csecret',
    refresh_token: seeded.refreshToken,
  });
});

test('stores the new pair and expiry from the response', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  const rec = await guard.refreshOfflineToken(SHOP);
  assert.notEqual(rec.accessToken, seeded.accessToken);
  assert.notEqual(rec.refreshToken, seeded.refreshToken);
  assert.equal(rec.expiresAt, clock.now() + 3600_000);
  assert.equal(rec.refreshTokenExpiresAt, clock.now() + 7776000_000);
  assert.equal(rec.scope, 'read_products');
  assert.deepEqual(await storage.get(SHOP), rec);
  assert.equal(shopify.api(rec.accessToken).status, 200);
});

test('NEGATIVE CONTROL: 20 concurrent callers -> exactly one network call, all get the same token', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.delayMs = 5;
  const results = await Promise.all(Array.from({ length: 20 }, () => guard.refreshOfflineToken(SHOP)));
  assert.equal(shopify.calls.length, 1);
  assert.equal(new Set(results.map((r) => r.accessToken)).size, 1);
  assert.equal(storage.setKeys.length, 1);
});

test('control: a naive refresher without the guard makes 20 calls for 20 concurrent callers', async () => {
  const clock = new FakeClock();
  const shopify = new FakeShopify(clock);
  const storage = new FakeStorage();
  const seeded = seedExpiring(shopify, storage, clock);
  const naive = async () => {
    const r = await storage.get(SHOP);
    const res = await shopify.fetch(`https://${SHOP}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {},
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: r!.refreshToken! }).toString(),
    });
    return res.status;
  };
  await Promise.all(Array.from({ length: 20 }, naive));
  assert.equal(shopify.calls.length, 20, 'without single-flight every caller hits Shopify');
  assert.ok(seeded);
});

test('two processes sharing storage + a shared lock -> one network call', async () => {
  const clock = new FakeClock();
  const shopify = new FakeShopify(clock);
  const storage = new FakeStorage();
  const lock = new FakeSharedLock();
  const mk = () =>
    createTokenGuard({ clientId: 'c', clientSecret: 's', storage, lock, fetch: shopify.fetch, now: clock.now, sleep: noSleep });
  const a = mk();
  const b = mk();
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.delayMs = 5;
  const [ra, rb] = await Promise.all([a.refreshOfflineToken(SHOP), b.refreshOfflineToken(SHOP)]);
  assert.equal(shopify.calls.length, 1);
  assert.equal(ra.accessToken, rb.accessToken);
});

test('control: two processes WITHOUT a shared lock both refresh (why the lock option exists)', async () => {
  const clock = new FakeClock();
  const shopify = new FakeShopify(clock);
  const storage = new FakeStorage();
  const mk = () => createTokenGuard({ clientId: 'c', clientSecret: 's', storage, fetch: shopify.fetch, now: clock.now, sleep: noSleep });
  const a = mk();
  const b = mk();
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.delayMs = 5;
  await Promise.all([a.refreshOfflineToken(SHOP), b.refreshOfflineToken(SHOP)]);
  assert.equal(shopify.calls.length, 2);
});

test('NEGATIVE CONTROL #3400: response without expires_in stays refreshable', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.omitExpiresIn = true;
  const rec = await guard.refreshOfflineToken(SHOP);
  assert.equal(rec.expiresAtAssumed, true);
  assert.equal(rec.expiresAt, clock.now() + 900_000, 'assumed 15 min, not null');
  // Not due yet: no call.
  await guard.refreshOfflineToken(SHOP);
  assert.equal(shopify.calls.length, 1);
  // Past the assumed lifetime: it refreshes again instead of going dark.
  clock.advance(900);
  shopify.omitExpiresIn = false;
  const rec2 = await guard.refreshOfflineToken(SHOP);
  assert.equal(shopify.calls.length, 2);
  assert.notEqual(rec2.accessToken, rec.accessToken);
  assert.equal(rec2.expiresAtAssumed, undefined);
});

test('needsRefresh: unknown expiry on an expiring record means refresh; non-expiring never', () => {
  const now = 1000;
  assert.equal(needsRefresh({ shop: SHOP, accessToken: 'a', refreshToken: 'r', expiresAt: null }, now), true);
  assert.equal(needsRefresh({ shop: SHOP, accessToken: 'a', refreshToken: 'r' }, now), true);
  assert.equal(needsRefresh({ shop: SHOP, accessToken: 'a', refreshToken: null, expiresAt: null }, now), false);
  assert.equal(needsRefresh({ shop: SHOP, accessToken: 'a', refreshToken: 'r', expiresAt: now + 61_000 }, now), false);
  assert.equal(needsRefresh({ shop: SHOP, accessToken: 'a', refreshToken: 'r', expiresAt: now + 59_000 }, now), true);
});

test('a token that is not due is returned without a network call; force refreshes', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  const same = await guard.refreshOfflineToken(SHOP);
  assert.equal(same.accessToken, seeded.accessToken);
  assert.equal(shopify.calls.length, 0);
  const forced = await guard.refreshOfflineToken(SHOP, { force: true });
  assert.equal(shopify.calls.length, 1);
  assert.notEqual(forced.accessToken, seeded.accessToken);
});

test('401 is terminal: no retry, ReauthorizeRequiredError, record deleted', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.uninstalled.add(SHOP);
  await assert.rejects(guard.refreshOfflineToken(SHOP), ReauthorizeRequiredError);
  assert.equal(shopify.calls.length, 1);
  assert.equal(storage.records.has(SHOP), false);
});

test('401 does not delete a newer pair written by someone else meanwhile', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.uninstalled.add(SHOP);
  shopify.beforeRespond = async () => {
    storage.records.set(SHOP, { shop: SHOP, accessToken: 'newer', refreshToken: 'newer_rt', expiresAt: clock.now() + 3600_000 });
  };
  await assert.rejects(guard.refreshOfflineToken(SHOP), ReauthorizeRequiredError);
  assert.equal(storage.records.get(SHOP)?.accessToken, 'newer');
});

test('deleteOnReauthorize: false keeps the record', async () => {
  const { clock, shopify, storage, guard } = setup({ deleteOnReauthorize: false });
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.uninstalled.add(SHOP);
  await assert.rejects(guard.refreshOfflineToken(SHOP), ReauthorizeRequiredError);
  assert.equal(storage.records.has(SHOP), true);
});

test('transient 503, network error, then success: retried with the same refresh token', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.faults = [503, 'network'];
  const rec = await guard.refreshOfflineToken(SHOP);
  assert.equal(shopify.calls.length, 3);
  assert.ok(shopify.calls.every((c) => c.params['refresh_token'] === seeded.refreshToken));
  assert.equal(shopify.api(rec.accessToken).status, 200);
});

test('429 on every attempt -> TransientRefreshError, stored record untouched', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.faults = [429, 429, 429];
  await assert.rejects(guard.refreshOfflineToken(SHOP), TransientRefreshError);
  assert.equal(shopify.calls.length, 3);
  assert.deepEqual(storage.records.get(SHOP), seeded);
  assert.equal(storage.setKeys.length, 0);
});

test('400 is not retried and leaves the record', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.faults = [400];
  await assert.rejects(guard.refreshOfflineToken(SHOP), RefreshRejectedError);
  assert.equal(shopify.calls.length, 1);
  assert.deepEqual(storage.records.get(SHOP), seeded);
});

test('storage write fails after a successful refresh -> old pair kept and the next refresh still works', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  storage.failNextSets = 1;
  await assert.rejects(guard.refreshOfflineToken(SHOP), /storage write failed/);
  assert.deepEqual(storage.records.get(SHOP), seeded, 'old pair still stored');
  // Documented rotation: the presented refresh token stays usable until the newer one is used.
  const rec = await guard.refreshOfflineToken(SHOP);
  assert.equal(shopify.calls.length, 2);
  assert.equal(shopify.calls[1]!.params['refresh_token'], seeded.refreshToken);
  assert.equal(shopify.api(rec.accessToken).status, 200);
});

test('success body without refresh_token is not stored', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.omitRefreshToken = true;
  await assert.rejects(guard.refreshOfflineToken(SHOP), RefreshRejectedError);
  assert.deepEqual(storage.records.get(SHOP), seeded);
});

test('NEGATIVE CONTROL #3478: 25 refreshes leave exactly one record under one key', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  for (let i = 0; i < 25; i++) {
    clock.advance(3600);
    await guard.refreshOfflineToken(SHOP);
  }
  assert.equal(shopify.calls.length, 25);
  assert.equal(storage.records.size, 1);
  assert.deepEqual([...new Set(storage.setKeys)], [SHOP]);
  assert.equal(storage.setKeys.length, 25, 'one write per refresh, never two');
});

test('refuses non-myshopify hosts before any network call (client secret never leaves)', async () => {
  const { shopify, guard } = setup();
  for (const bad of ['evil.com', 'demo.myshopify.com.evil.com', 'demo.myshopify.com/x', '', 'https://demo.myshopify.com']) {
    await assert.rejects(guard.refreshOfflineToken(bad), InvalidShopError);
  }
  assert.equal(shopify.calls.length, 0);
});

test('shop is normalized (case/whitespace)', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  await guard.refreshOfflineToken('  Demo-Shop.MyShopify.com ');
  assert.equal(shopify.calls.length, 1);
});

test('non-expiring record cannot be refreshed; missing record -> NoSessionError', async () => {
  const { storage, guard, shopify } = setup();
  storage.records.set(SHOP, { shop: SHOP, accessToken: 'shpua_legacy' });
  await assert.rejects(guard.refreshOfflineToken(SHOP), NotRefreshableError);
  await assert.rejects(guard.refreshOfflineToken('other.myshopify.com'), NoSessionError);
  assert.equal(shopify.calls.length, 0);
});

test('acquireToken and refresh are serialized for the same shop', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  const order: string[] = [];
  const acquire = guard.acquireToken(SHOP, async () => {
    order.push('acquire-start');
    await new Promise((r) => setTimeout(r, 10));
    const { access, refresh } = shopify.issuePair(SHOP);
    order.push('acquire-end');
    return { access_token: access, refresh_token: refresh, expires_in: 3600, refresh_token_expires_in: 7776000 };
  });
  const refresh = guard.refreshOfflineToken(SHOP);
  const [acq, ref] = await Promise.all([acquire, refresh]);
  assert.deepEqual(order, ['acquire-start', 'acquire-end']);
  assert.equal(shopify.calls.length, 0, 'refresh saw the fresh acquired pair and skipped the network');
  assert.equal(ref.accessToken, acq.accessToken);
});

test('acquireToken with a non-expiring response stores a non-expiring record', async () => {
  const { storage, guard } = setup();
  const rec = await guard.acquireToken(SHOP, async () => ({ access_token: 'shpua_x', scope: 'read_orders' }));
  assert.equal(rec.refreshToken, null);
  assert.equal(rec.expiresAt, null);
  assert.equal(needsRefresh(rec, Date.now()), false);
  assert.equal(storage.records.get(SHOP)?.scope, 'read_orders');
});
