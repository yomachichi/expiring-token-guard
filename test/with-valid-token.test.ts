import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenGuard, NoSessionError, ReauthorizeRequiredError, isNonExpiringTokenRejected } from '../src/index.js';
import { FakeClock, FakeShopify, FakeStorage, SHOP, seedExpiring, noSleep } from './fakes.js';

function setup() {
  const clock = new FakeClock();
  const shopify = new FakeShopify(clock);
  const storage = new FakeStorage();
  const guard = createTokenGuard({ clientId: 'cid', clientSecret: 'csecret', storage, fetch: shopify.fetch, now: clock.now, sleep: noSleep });
  return { clock, shopify, storage, guard };
}

test('fresh token: fn called once, no refresh', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  const tokens: string[] = [];
  const out = await guard.withValidToken(SHOP, async (t) => {
    tokens.push(t);
    return shopify.api(t);
  });
  assert.deepEqual(tokens, [seeded.accessToken]);
  assert.equal(out.status, 200);
  assert.equal(shopify.calls.length, 0);
});

test('expired token: refreshed before fn runs', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  const tokens: string[] = [];
  const out = await guard.withValidToken(SHOP, async (t) => {
    tokens.push(t);
    return shopify.api(t);
  });
  assert.equal(shopify.calls.length, 1);
  assert.equal(tokens.length, 1);
  assert.notEqual(tokens[0], seeded.accessToken);
  assert.equal(out.status, 200);
});

test('401 result: refresh once, retry once with the new token', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  shopify.accessTokens.get(seeded.accessToken)!.valid = false; // revoked early, record still looks fresh
  const tokens: string[] = [];
  const out = await guard.withValidToken(SHOP, async (t) => {
    tokens.push(t);
    return shopify.api(t);
  });
  assert.equal(tokens.length, 2);
  assert.equal(shopify.calls.length, 1);
  assert.equal(out.status, 200);
});

test('401 twice: exactly one refresh and one retry, then the 401 is returned', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  let n = 0;
  const out = await guard.withValidToken(SHOP, async () => {
    n++;
    return { status: 401 };
  });
  assert.equal(n, 2);
  assert.equal(shopify.calls.length, 1);
  assert.equal(out.status, 401);
});

test('thrown error with status 401 is treated the same', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  let n = 0;
  const out = await guard.withValidToken(SHOP, async () => {
    n++;
    if (n === 1) throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(shopify.calls.length, 1);
});

test('NEGATIVE CONTROL: 10 concurrent callers all hitting 401 -> one refresh', async () => {
  const { clock, shopify, storage, guard } = setup();
  const seeded = seedExpiring(shopify, storage, clock);
  shopify.accessTokens.get(seeded.accessToken)!.valid = false;
  shopify.delayMs = 5;
  const outs = await Promise.all(Array.from({ length: 10 }, () => guard.withValidToken(SHOP, async (t) => shopify.api(t))));
  assert.equal(shopify.calls.length, 1);
  assert.ok(outs.every((o) => o.status === 200));
});

test('non-401 errors propagate without refresh', async () => {
  const { clock, shopify, storage, guard } = setup();
  seedExpiring(shopify, storage, clock);
  await assert.rejects(
    guard.withValidToken(SHOP, async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    }),
    /boom/,
  );
  assert.equal(shopify.calls.length, 0);
});

test('non-expiring record: a 401 is returned as is (nothing to refresh)', async () => {
  const { storage, guard, shopify } = setup();
  storage.records.set(SHOP, { shop: SHOP, accessToken: 'shpua_legacy' });
  let n = 0;
  const out = await guard.withValidToken(SHOP, async () => {
    n++;
    return { status: 401 };
  });
  assert.equal(n, 1);
  assert.equal(out.status, 401);
  assert.equal(shopify.calls.length, 0);
});

test('no stored record -> NoSessionError; dead refresh token -> ReauthorizeRequiredError', async () => {
  const { clock, shopify, storage, guard } = setup();
  await assert.rejects(guard.withValidToken(SHOP, async () => 1), NoSessionError);
  seedExpiring(shopify, storage, clock);
  clock.advance(3600);
  shopify.uninstalled.add(SHOP);
  await assert.rejects(guard.withValidToken(SHOP, async () => 1), ReauthorizeRequiredError);
});

test('isNonExpiringTokenRejected matches the documented phrase only', () => {
  assert.equal(
    isNonExpiringTokenRejected([{ message: 'Non-expiring access tokens are no longer accepted for the Admin API. See https://example' }]),
    true,
  );
  assert.equal(isNonExpiringTokenRejected('Access denied for products field. Required access: read_products'), false);
  assert.equal(isNonExpiringTokenRejected(undefined), false);
});

test('two processes (shared lock) both see a 401 for the same token -> one refresh, not two', async () => {
  const { FakeSharedLock } = await import('./fakes.js');
  const clock = new FakeClock();
  const shopify = new FakeShopify(clock);
  const storage = new FakeStorage();
  const lock = new FakeSharedLock();
  const mk = () =>
    createTokenGuard({ clientId: 'c', clientSecret: 's', storage, lock, fetch: shopify.fetch, now: clock.now, sleep: noSleep });
  const a = mk();
  const b = mk();
  const seeded = seedExpiring(shopify, storage, clock);
  shopify.accessTokens.get(seeded.accessToken)!.valid = false;
  shopify.delayMs = 5;
  const outs = await Promise.all([a, b].map((g) => g.withValidToken(SHOP, async (t) => shopify.api(t))));
  assert.equal(shopify.calls.length, 1, 'the second process found the token already replaced');
  assert.ok(outs.every((o) => o.status === 200));
});
