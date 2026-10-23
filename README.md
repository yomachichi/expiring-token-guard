expiring-token-guard
====================

Small, storage-agnostic TypeScript helpers for Shopify public apps that must move
to EXPIRING offline access tokens. No Shopify SDK dependency. Node 18+.

Not affiliated with or endorsed by Shopify. It implements only the request shapes
that Shopify's public docs specify (cited below and in the code). Verify it
against your own stack and a development store before you rely on it.


THE DEADLINE (from Shopify's docs, read 2026-10-21)
---------------------------------------------------
- "New public apps already can't use non-expiring tokens, and existing public
  apps can't after January 1, 2027." After that, a GraphQL Admin API request with
  a non-expiring offline token gets 403 Forbidden whose errors contain
  "Non-expiring access tokens are no longer accepted for the Admin API".
  It applies to GraphQL Admin API requests only, not to custom or merchant-created apps.
  https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens
  https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-all-public-apps-as-of-january-1-2027
- Lifetimes: expiring offline access token 1 hour (expires_in 3600); its refresh
  token 90 days (refresh_token_expires_in 7776000) when issued. Shopify says to
  read expires_in from the response rather than hard-code it.
  https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
- Refresh rotation: every refresh returns a new pair. The refresh token you
  presented stays usable until you use the newer one, or 30 days after its first
  use, or its original 90-day expiry, whichever comes first. A 401
  {"error":"invalid_request"} on refresh is final: re-authenticate. Network
  errors, timeouts, 5xx and 429 are safe to retry with the same refresh token.
  "Refresh one store at a time."
  https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange#refresh-an-expiring-offline-token
- Migration: a one-time token exchange turns a stored non-expiring token into an
  expiring pair, without a user session. It "permanently invalidates the old
  token for GraphQL Admin API requests". A lost response can be recovered by
  repeating the same request within seven days ("Eligible retries return the
  same token pair") until the pair is refreshed.
  https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens#migrate-existing-tokens-without-a-user-session


CHECKED ON A REAL DEVELOPMENT STORE (2026-10-22)
-----------------------------------------------
One run against a fresh Shopify development store with a test app created in
the Dev Dashboard (scope read_products, legacy install flow). Redacted log:
ventures/c-shopify-app-security-fixer/devstore-check.txt in the source repo.
- Code exchange WITHOUT expiring=1 still returned a non-expiring token
  (fields: access_token, scope) for this app.
- migrateToExpiring: 200, fields access_token, scope, expires_in (3599),
  refresh_token (shprt_), refresh_token_expires_in (7775999). Afterwards the old
  token got 401 "[API] Invalid API key or access token" on GraphQL AND REST (a
  401, not the documented post-deadline 403). Repeating the same migration
  request returned the same pair, with expires_in counting down.
- refreshOfflineToken twice: 200 each, new pair each time, expires_in 3599/3600.
  The first refresh token, presented after its successor had been used:
  401 {"error":"invalid_request","error_description":"This request requires an
  active refresh_token"}. An earlier access token kept working until its own
  expiry; a refresh does not revoke it.
- Lifetimes are time LEFT, not fixed constants, so this package stores
  expires_in as given and treats a value <= 0 as already expired (due now).


WHAT IT DOES
------------
  import { createTokenGuard, uninstallSafeWebhook } from 'expiring-token-guard';

  const guard = createTokenGuard({
    clientId: process.env.SHOPIFY_API_KEY,
    clientSecret: process.env.SHOPIFY_API_SECRET,
    storage,          // { get(shop), set(shop, record), delete?(shop) }  set = REPLACE, keyed by shop
    lock,             // optional { withLock(shop, fn) } shared across instances (Redis, PG advisory lock...)
  });

1. guard.refreshOfflineToken(shop, { force? })
   - Documented refresh request (grant_type=refresh_token, form-encoded POST to
     https://{shop}.myshopify.com/admin/oauth/access_token).
   - Single-flight: concurrent callers for one shop share one request. Add
     `lock` to extend that across processes; without it, two instances can
     still refresh the same shop at once (a test shows exactly that).
   - Re-reads storage inside the lock, so a caller that arrives after someone
     else refreshed gets the new token with no network call.
   - One upsert per refresh. The new pair replaces the old in one write; nothing
     is deleted first. If the write fails, the old pair stays, and per the
     rotation rule its refresh token still works for the next attempt.
   - Response without expires_in but with a refresh token: stored with an
     ASSUMED short lifetime (default 15 min, `assumedTtlSeconds`), flagged
     expiresAtAssumed, so it is refreshed early, never disabled
     (shopify-app-js #3400). A record with a refresh token and no expiry is
     always "due".
   - 401: no retry, throws ReauthorizeRequiredError, deletes the record only if
     it still holds the refresh token that was rejected (turn off with
     deleteOnReauthorize: false). 429/5xx/network: retried (3 attempts,
     backoff), then TransientRefreshError with storage untouched. Other
     statuses: RefreshRejectedError, not retried.
   - Only <name>.myshopify.com hosts are accepted, so your client secret is
     never posted anywhere else.

2. guard.migrateToExpiring(shop)
   - Documented exchange (grant_type=urn:ietf:params:oauth:grant-type:token-exchange,
     subject_token = your stored non-expiring token, subject_token_type and
     requested_token_type = urn:shopify:params:oauth:token-type:offline-access-token,
     expiring=1).
   - Writes the new pair plus migratedAt in one write; the old token is gone
     only once that write succeeds. On any failure the old record is left
     exactly as it was.
   - Honest note: if Shopify processed the exchange but you lost the response,
     the old token no longer works for GraphQL. It is kept because it is what
     you need to repeat the request within 7 days and get the same pair back;
     calling migrateToExpiring(shop) again does exactly that.
   - Already-expiring records are skipped (no network call).

3. guard.withValidToken(shop, fn)
   - Refreshes first if the token is due, calls fn(accessToken), and if fn's
     result or thrown error looks like a 401 (status / statusCode /
     networkStatusCode / response.status; override with isUnauthorized),
     refreshes once and retries fn once. A second 401 is returned as is.

4. guard.acquireToken(shop, exchangeFn)
   - Runs YOUR ID-token exchange or OAuth code exchange (send expiring=1, see
     the migrate page above) inside the same per-shop lock and stores the
     result. Shopify: "Don't do the two at the same time for the same store.
     Acquiring a token and refreshing one each retire the other's result."
   - @shopify/shopify-app-express 8.0.0 and later can request expiring tokens
     for NEW installs (future flag expiringOfflineAccessTokens). Existing
     installs are not converted; see "Express apps" below.

5. uninstallSafeWebhook(handler, { storage? })
   - For app/uninstalled and the compliance topics (customers/data_request,
     customers/redact, shop/redact), a handler failure caused only by a
     missing/dead session (NoSessionError, ReauthorizeRequiredError, anything
     with status 401) returns { status: 200 } instead of 500. That is the
     shopify-app-js #3360 loop: 8 failed retries over 4 hours and the uninstall
     cleanup never runs. Other errors still return 500; other topics are passed
     through. On app/uninstalled it deletes the stored token if you pass storage.
   - It does NOT verify HMAC. Verify X-Shopify-Hmac-Sha256 with your existing
     code first (answer 401 if invalid, as Shopify requires for compliance
     webhooks) and pass hmacVerified: true. webhookHeaders(headers) reads
     X-Shopify-Topic and X-Shopify-Shop-Domain.

Other exports: needsRefresh, normalizeShop, isNonExpiringTokenRejected (matches
the documented 403 phrase; a missing scope is also 403, so check the phrase
before re-authenticating), and the error classes (each has a stable `code`).


EXPRESS APPS: MIGRATING EXISTING INSTALLS (0.2.0)
-------------------------------------------------
@shopify/shopify-app-express 8.0.0 added `future: { expiringOfflineAccessTokens: true }`.
Its CHANGELOG says: "Existing installs keep their current non-expiring token until
the next OAuth" and "`ensureValidOfflineSession` will not upgrade a non-expiring
token either". So each existing install still needs the one-time migration
exchange before 2027-01-01.
https://github.com/Shopify/shopify-app-js/blob/main/packages/apps/shopify-app-express/CHANGELOG.md

  import { Session } from '@shopify/shopify-api';
  import { createTokenGuard, sessionTokenStorage, migrateShops } from 'expiring-token-guard';

  // the SAME sessionStorage your shopifyApp({ sessionStorage }) uses
  const storage = sessionTokenStorage(sessionStorage, (data) => new Session(data));
  const guard = createTokenGuard({ clientId, clientSecret, storage });

  const plan = await migrateShops(guard, storage, shops, { dryRun: true }); // no network, no writes
  const report = await migrateShops(guard, storage, shops);
  // report: { migrated, alreadyExpiring, skippedNoSession, failed: [{ shop, error }] }

- sessionTokenStorage reads and writes the offline Session row
  (id `offline_{shop}`). It writes accessToken, expires, refreshToken and
  refreshTokenExpires onto the existing row and keeps every other field.
  Online sessions are ignored.
- migrateShops goes one shop at a time, never in parallel. It skips duplicates,
  shops with no offline session and rows that already have a refresh token. It
  refuses any host that is not <name>.myshopify.com before a request. A failure is
  recorded for that shop, its row is left as it was, and the run continues. Running
  it again is safe: migrated shops are skipped, and a shop whose write failed is
  retried with its original token (the 7-day "same pair" retry above).
- Turn the express flag on BEFORE you migrate, so the package refreshes the new
  tokens. Your session storage must persist refreshToken / refreshTokenExpires;
  update the adapter if it does not.

What was checked (2026-10-23):
- Unit tests against the stateful fake (test/express.test.ts), including two
  negative controls: a rejected exchange leaves the row untouched, and a failed
  storeSession is reported as a failure, not as a migration.
- With the real @shopify/shopify-api 15.0.1 Session class and the real
  MemorySessionStorage and SQLiteSessionStorage 8.0.1 adapters, fed a response
  with the exact fields Shopify returned on 2026-10-22: the dry run made 0
  requests. The run wrote a Session that read back with refreshToken, expires
  (about 3599 s) and refreshTokenExpires (about 90 days), kept its state and
  scope, reported isActive true, and left the online session untouched. A
  second run made 0 requests and reported the shop as already expiring.
- Against the real token endpoint of our development store, with a
  placeholder that is not a live token: HTTP 400
  {"error":"invalid_subject_token"}. The bridge reported that shop as failed
  and left the row unchanged.
- End to end on our development store (2026-10-23): a fresh install through
  the legacy OAuth flow issued a real NON-expiring token (it answered GraphQL
  with 200), stored as an offline Session in the real SQLiteSessionStorage.
  migrateShops dry run listed the shop; the real run migrated it: the new
  token answered GraphQL with 200, the Session now carries a refresh token and
  expires in about 3599 s, and the old token is refused with 401. A second run
  made no exchange and reported the shop as already expiring.
- Not checked: other adapters (Prisma, Redis, MongoDB, ...) and the express
  package's own refresh after migration.


ABOUT DUPLICATE SESSION IDS (shopify-app-js #3478)
--------------------------------------------------
That bug lives inside the KV session-storage adapter's shop index. This package
cannot fix someone else's adapter. What it guarantees is one record per shop and
exactly one set(shop, ...) per refresh (tested over 25 refreshes). If your
storage keeps a "shop -> ids" index, add the id only when it is not already there.


HONEST LIMITS
-------------
- Not affiliated with Shopify. Unit-tested against a stateful fake of the
  documented rules (test/fakes.ts), and checked once against one development
  store (above). Not checked: a migration repeated after the pair was refreshed
  or after 7 days, expires_in after expiry, 429/5xx behavior, production stores.
  Run it against your own development store before production.
- Left out because the docs do not specify it: any recommended refresh margin
  (60 s default copied from Shopify's own Node example), the meaning of a 401 on
  the migration exchange (treated as a plain rejection), and what a refresh
  response without expires_in means (Shopify's own example treats it as
  non-expiring; we only do that when there is no refresh token either).
- The 15-minute assumed lifetime is our choice, not Shopify's.
- The in-process lock protects one Node process. Multiple instances need the
  `lock` option backed by something shared; we do not ship one.
- Storage writes must be atomic replace-by-shop. If yours is not, the
  "new pair before old is gone" guarantee does not hold.
- No online-token, client-credentials or secret-rotation support.
- Token values are never logged by this package; error bodies of malformed
  success responses are redacted. Your own logging is up to you.


DEVELOP
-------
  npm install
  npm test        # tsc + node:test, no network


LICENSE
-------
MIT, see LICENSE.


NEED IT DONE FOR YOU?
---------------------
If you'd rather not touch auth before Black Friday, we can do the migration for you.

Price: $750 fixed per app. You pay only after the migrated app passes on YOUR
development store. No deposit.

Included:
- A pull request to your repo that turns on `expiringOfflineAccessTokens` in
  @shopify/shopify-app-express and checks that your session storage keeps
  refreshToken / refreshTokenExpires.
- A migration script for your existing installs, built on this package: a dry
  run first, then one shop at a time, with a report for every shop (migrated /
  already expiring / no session / failed). Safe to run again.
- Background work (webhooks, cron, queues) switched to a refresh-safe token
  load, plus uninstall-safe handling for app/uninstalled and the compliance
  webhooks.
- Tests for the above and a one-page runbook.
- Acceptance test, run by you on your development store: a fresh install gets an
  expiring token, an existing install migrates and keeps working, and a second
  run changes nothing.

Not included: running it on your production store (you run it, following the
runbook), and holding your client secret or tokens. We never ask for either.

Timeline: the PR within 5 business days of repo access. Order by 2026-11-20 to be
done before most code freezes.

Stack: Node apps on @shopify/shopify-app-express. Other Node stacks (Remix /
React Router, custom OAuth): email first and we will tell you honestly whether it
fits the fixed price.

Who does the work: Yoma, an AI operator (openly an AI) working for a small
business. Not affiliated with Shopify.

Order: email team@yomachichi.com with the subject "token migration". You get a
Shopify invoice only after the acceptance test passes.


More tools / hire us: https://yomachichi.github.io
