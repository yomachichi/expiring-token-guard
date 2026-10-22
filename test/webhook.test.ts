import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTokenGuard,
  uninstallSafeWebhook,
  webhookHeaders,
  NoSessionError,
  ReauthorizeRequiredError,
} from '../src/index.js';
import { FakeClock, FakeShopify, FakeStorage, SHOP, seedExpiring, noSleep } from './fakes.js';

test('app/uninstalled with a gone session -> 200 and the stored token is deleted', async () => {
  const storage = new FakeStorage();
  storage.records.set(SHOP, { shop: SHOP, accessToken: 'x', refreshToken: 'y' });
  const gone: string[] = [];
  const wrapped = uninstallSafeWebhook(
    async () => {
      throw new NoSessionError(SHOP);
    },
    { storage, onSessionGone: (i) => gone.push(i.topic) },
  );
  const out = await wrapped({ topic: 'app/uninstalled', shop: SHOP, hmacVerified: true });
  assert.deepEqual(out, { status: 200, sessionGone: true });
  assert.equal(storage.records.has(SHOP), false);
  assert.deepEqual(gone, ['app/uninstalled']);
});

for (const topic of ['shop/redact', 'customers/redact', 'customers/data_request']) {
  test(`${topic}: dead refresh token -> 200`, async () => {
    const wrapped = uninstallSafeWebhook(async () => {
      throw new ReauthorizeRequiredError(SHOP);
    });
    const out = await wrapped({ topic, shop: SHOP, hmacVerified: true });
    assert.equal(out.status, 200);
    assert.equal(out.sessionGone, true);
  });
}

test('a thrown framework Response with status 401 counts as session gone', async () => {
  const wrapped = uninstallSafeWebhook(async () => {
    throw new Response(null, { status: 401 });
  });
  const out = await wrapped({ topic: 'shop/redact', shop: SHOP, hmacVerified: true });
  assert.equal(out.status, 200);
});

test('other errors on a guarded topic still return 500 (so Shopify retries)', async () => {
  const wrapped = uninstallSafeWebhook(async () => {
    throw new Error('db down');
  });
  const out = await wrapped({ topic: 'shop/redact', shop: SHOP, hmacVerified: true });
  assert.equal(out.status, 500);
  assert.equal(out.sessionGone, false);
});

test('unguarded topics are passed through: session-gone on orders/create is still 500', async () => {
  const wrapped = uninstallSafeWebhook(async () => {
    throw new NoSessionError(SHOP);
  });
  const out = await wrapped({ topic: 'orders/create', shop: SHOP, hmacVerified: true });
  assert.equal(out.status, 500);
});

test('handler success -> 200, sessionGone false', async () => {
  let ran = 0;
  const wrapped = uninstallSafeWebhook(async () => {
    ran++;
  });
  assert.deepEqual(await wrapped({ topic: 'customers/redact', shop: SHOP, hmacVerified: true }), { status: 200, sessionGone: false });
  assert.equal(ran, 1);
});

test('refuses to run unless the caller asserts HMAC was verified', async () => {
  const wrapped = uninstallSafeWebhook(async () => {});
  await assert.rejects(wrapped({ topic: 'shop/redact', shop: SHOP } as never), /hmacVerified/);
});

test('failed delete on app/uninstalled -> 500 (Shopify retries the cleanup)', async () => {
  const wrapped = uninstallSafeWebhook(async () => {}, {
    storage: {
      delete: async () => {
        throw new Error('delete failed');
      },
    },
  });
  const out = await wrapped({ topic: 'app/uninstalled', shop: SHOP, hmacVerified: true });
  assert.equal(out.status, 500);
});

test('NEGATIVE CONTROL #3360 end to end: idle shop uninstalls, token expired, refresh 401s', async () => {
  const clock = new FakeClock();
  const shopify = new FakeShopify(clock);
  const storage = new FakeStorage();
  const guard = createTokenGuard({ clientId: 'c', clientSecret: 's', storage, fetch: shopify.fetch, now: clock.now, sleep: noSleep });
  seedExpiring(shopify, storage, clock);
  clock.advance(2 * 86400); // merchant idle for days, token long expired
  shopify.uninstalled.add(SHOP);

  // The handler does what many apps do: touches the API with the offline token.
  const handler = async () => {
    await guard.withValidToken(SHOP, async (t) => shopify.api(t));
  };
  // Without the wrapper the handler throws -> the route would answer 500 eight times.
  await assert.rejects(handler(), ReauthorizeRequiredError);

  seedExpiring(shopify, storage, clock);
  clock.advance(2 * 86400);
  const out = await uninstallSafeWebhook(handler, { storage })({ topic: 'app/uninstalled', shop: SHOP, hmacVerified: true });
  assert.equal(out.status, 200);
  assert.equal(storage.records.has(SHOP), false);
});

test('webhookHeaders reads documented headers from a plain object or a Headers instance', () => {
  assert.deepEqual(webhookHeaders({ 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': SHOP }), {
    topic: 'app/uninstalled',
    shop: SHOP,
  });
  const h = new Headers({ 'X-Shopify-Topic': 'shop/redact', 'X-Shopify-Shop-Domain': SHOP });
  assert.deepEqual(webhookHeaders(h), { topic: 'shop/redact', shop: SHOP });
});
