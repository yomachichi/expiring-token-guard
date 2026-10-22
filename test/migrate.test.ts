import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenGuard, RefreshRejectedError, TransientRefreshError } from '../src/index.js';
import { FakeClock, FakeShopify, FakeStorage, SHOP, noSleep } from './fakes.js';

function setup() {
  const clock = new FakeClock();
  const shopify = new FakeShopify(clock);
  const storage = new FakeStorage();
  const guard = createTokenGuard({ clientId: 'cid', clientSecret: 'csecret', storage, fetch: shopify.fetch, now: clock.now, sleep: noSleep });
  const legacy = shopify.addLegacyToken(SHOP);
  storage.records.set(SHOP, { shop: SHOP, accessToken: legacy, refreshToken: null, expiresAt: null, scope: 'read_products' });
  return { clock, shopify, storage, guard, legacy };
}

test('migration sends exactly the documented request shape', async () => {
  const { shopify, guard, legacy } = setup();
  await guard.migrateToExpiring(SHOP);
  assert.equal(shopify.calls.length, 1);
  const c = shopify.calls[0]!;
  assert.equal(c.url, `https://${SHOP}/admin/oauth/access_token`);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(c.params, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    client_id: 'cid',
    client_secret: 'csecret',
    subject_token: legacy,
    subject_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    expiring: '1',
  });
});

test('successful migration stores the expiring pair with migratedAt, in one write', async () => {
  const { clock, shopify, storage, guard, legacy } = setup();
  const res = await guard.migrateToExpiring(SHOP);
  assert.equal(res.status, 'migrated');
  const stored = storage.records.get(SHOP)!;
  assert.ok(stored.refreshToken);
  assert.notEqual(stored.accessToken, legacy);
  assert.equal(stored.migratedAt, clock.now());
  assert.equal(storage.setKeys.length, 1);
  assert.equal(shopify.api(stored.accessToken).status, 200);
  assert.equal(shopify.api(legacy).status, 401, 'the fake models "migration permanently invalidates the old token"');
});

test('NEGATIVE CONTROL: rejected migration (400 invalid_subject_token) leaves the old token stored', async () => {
  const { shopify, storage, guard, legacy } = setup();
  shopify.accessTokens.get(legacy)!.legacy = false; // e.g. not a non-expiring token
  const err = await guard.migrateToExpiring(SHOP).catch((e) => e);
  assert.ok(err instanceof RefreshRejectedError);
  assert.equal(err.status, 400);
  assert.deepEqual(err.body, { error: 'invalid_subject_token' });
  assert.equal(storage.records.get(SHOP)?.accessToken, legacy);
  assert.equal(storage.setKeys.length, 0);
});

test('NEGATIVE CONTROL: network down on every attempt -> old token still present and still usable', async () => {
  const { shopify, storage, guard, legacy } = setup();
  shopify.faults = ['network', 'network', 'network'];
  await assert.rejects(guard.migrateToExpiring(SHOP), TransientRefreshError);
  assert.equal(storage.records.get(SHOP)?.accessToken, legacy);
  assert.equal(shopify.api(legacy).status, 200, 'request never reached the fake, so the old token works');
});

test('lost response (store write fails) -> old record kept; rerun recovers the SAME pair', async () => {
  const { clock, shopify, storage, guard, legacy } = setup();
  storage.failNextSets = 1;
  await assert.rejects(guard.migrateToExpiring(SHOP), /storage write failed/);
  assert.equal(storage.records.get(SHOP)?.accessToken, legacy, 'old token not discarded before the new pair is stored');
  const firstIssued = [...shopify.migrations.values()][0]!;
  clock.advance(3 * 86400); // within the documented 7-day recovery window
  const res = await guard.migrateToExpiring(SHOP);
  assert.equal(res.status, 'migrated');
  assert.equal(res.record.accessToken, firstIssued.access);
  assert.equal(res.record.refreshToken, firstIssued.refresh);
});

test('transient 500 then success: the same request is repeated', async () => {
  const { shopify, guard, legacy } = setup();
  shopify.faults = [500];
  const res = await guard.migrateToExpiring(SHOP);
  assert.equal(res.status, 'migrated');
  assert.equal(shopify.calls.length, 2);
  assert.ok(shopify.calls.every((c) => c.params['subject_token'] === legacy));
});

test('already-expiring record: no network call', async () => {
  const { shopify, guard } = setup();
  await guard.migrateToExpiring(SHOP);
  const again = await guard.migrateToExpiring(SHOP);
  assert.equal(again.status, 'already-expiring');
  assert.equal(shopify.calls.length, 1);
});

test('migrated record keeps scope when the response has none, and refreshes normally afterwards', async () => {
  const { clock, shopify, storage, guard } = setup();
  await guard.migrateToExpiring(SHOP);
  clock.advance(3600);
  const rec = await guard.refreshOfflineToken(SHOP);
  assert.equal(shopify.calls.length, 2);
  assert.ok(rec.migratedAt);
  assert.equal(storage.records.get(SHOP)?.scope, 'read_products');
});

test('concurrent migrate + refresh for the same shop: migration first, then the refresh reuses the fresh pair', async () => {
  const { shopify, guard } = setup();
  shopify.delayMs = 5;
  const [m, r] = await Promise.all([
    guard.migrateToExpiring(SHOP),
    (async () => {
      await new Promise((res) => setTimeout(res, 1));
      return guard.refreshOfflineToken(SHOP).catch((e) => e);
    })(),
  ]);
  assert.equal(m.status, 'migrated');
  // The refresh waited for the lock, then found a fresh expiring pair: no extra call.
  assert.equal(shopify.calls.length, 1);
  assert.equal((r as { accessToken: string }).accessToken, m.record.accessToken);
});

// Seen on a real dev store (2026-10-22): repeating the migration request returned
// the SAME pair with expires_in counting down (3599 -> 3598). The guard must keep
// the pair's real expiry, not restart a fresh hour.
test('repeated migration 30 min later: stored expiry is the original one, not +1h', async () => {
  const { clock, shopify, storage, guard } = setup();
  storage.failNextSets = 1;
  await assert.rejects(guard.migrateToExpiring(SHOP), /storage write failed/);
  const first = [...shopify.migrations.values()][0]!;
  const originalExp = shopify.accessTokens.get(first.access)!.exp;
  clock.advance(1800);
  const res = await guard.migrateToExpiring(SHOP);
  assert.equal(res.record.accessToken, first.access);
  assert.equal(res.record.expiresAt, originalExp);
});

test('repeated migration after the access token expired (expires_in 0) -> stored as due, next refresh hits the network', async () => {
  const { clock, shopify, storage, guard } = setup();
  storage.failNextSets = 1;
  await assert.rejects(guard.migrateToExpiring(SHOP), /storage write failed/);
  clock.advance(2 * 86400);
  const res = await guard.migrateToExpiring(SHOP);
  assert.equal(res.record.expiresAt, clock.now(), 'expires_in 0 means expired now, not "unknown" (assumed 15 min)');
  assert.equal(res.record.expiresAtAssumed, undefined);
  const callsBefore = shopify.calls.length;
  const rec = await guard.refreshOfflineToken(SHOP);
  assert.equal(shopify.calls.length, callsBefore + 1);
  assert.equal(shopify.api(rec.accessToken).status, 200);
});
