import type { TokenStorage } from './types.js';

/**
 * Topics that, by definition, can arrive after the shop's session is gone:
 * - `app/uninstalled`: "Occurs whenever a shop has uninstalled the app."
 *   https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic
 * - the mandatory compliance topics `customers/data_request`, `customers/redact`,
 *   `shop/redact` ("48 hours after a store owner uninstalls your app, Shopify sends
 *   a payload on the shop/redact topic").
 *   https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 */
export const SESSION_FREE_TOPICS: readonly string[] = Object.freeze([
  'app/uninstalled',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
]);

export interface WebhookInput {
  /** The `X-Shopify-Topic` header value. */
  topic: string;
  /** The `X-Shopify-Shop-Domain` header value. */
  shop: string;
  /**
   * You must verify the `X-Shopify-Hmac-Sha256` signature yourself BEFORE calling
   * the wrapper (with your framework's existing helper), and answer 401 for an
   * invalid one, as https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
   * requires for compliance webhooks. This flag makes that an explicit step.
   */
  hmacVerified: true;
}

export interface WebhookOutcome {
  /** HTTP status to send back to Shopify. */
  status: 200 | 500;
  /** True when the handler failed only because the shop's session/token is gone. */
  sessionGone: boolean;
  /** The error, when status is 500. */
  error?: unknown;
}

export interface UninstallSafeOptions {
  /** Topics given the session-gone => 200 treatment. Default SESSION_FREE_TOPICS. */
  topics?: readonly string[];
  /** On `app/uninstalled`, delete the shop's stored token through this storage. */
  storage?: Pick<TokenStorage, 'delete'>;
  /** Decide whether an error means "this shop's session is gone". Default: see defaultIsSessionGone. */
  isSessionGone?: (err: unknown) => boolean;
  /** Called (not awaited for errors) when a session-gone failure is turned into a 200, for your logs. */
  onSessionGone?: (info: { topic: string; shop: string; error: unknown }) => void;
}

/**
 * Default: this library's NO_SESSION / REAUTHORIZE_REQUIRED errors, or anything
 * carrying status 401 (for example a thrown `Response` from a framework helper).
 */
export function defaultIsSessionGone(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  if (e['code'] === 'NO_SESSION' || e['code'] === 'REAUTHORIZE_REQUIRED') return true;
  return e['status'] === 401 || e['statusCode'] === 401;
}

/** Reads topic and shop from Shopify's documented delivery headers (case-insensitive). */
export function webhookHeaders(
  headers: Record<string, string | string[] | undefined> | { get(name: string): string | null },
): { topic: string | undefined; shop: string | undefined } {
  const read = (name: string): string | undefined => {
    if (typeof (headers as { get?: unknown }).get === 'function') {
      return (headers as { get(n: string): string | null }).get(name) ?? undefined;
    }
    const rec = headers as Record<string, string | string[] | undefined>;
    const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
    const v = key === undefined ? undefined : rec[key];
    return Array.isArray(v) ? v[0] : v;
  };
  // Header names from https://shopify.dev/docs/apps/build/webhooks/delivery-structure
  return { topic: read('X-Shopify-Topic'), shop: read('X-Shopify-Shop-Domain') };
}

/**
 * Wraps your webhook processing so that, for app/uninstalled and the compliance
 * topics, a failure caused only by a missing or dead session returns 200 instead
 * of 500 (the shopify-app-js #3360 loop: 8 retries over 4 hours, the uninstall
 * handler never runs). Other errors still return 500 so Shopify retries, and
 * other topics are passed through unchanged.
 *
 * Shopify treats "any response outside the 200 range" as an error and expects a
 * response within five seconds:
 * https://shopify.dev/docs/apps/build/webhooks/subscribe/https#respond-with-a-200-ok-quickly
 */
export function uninstallSafeWebhook<I extends WebhookInput>(
  handler: (input: I) => Promise<void> | void,
  opts: UninstallSafeOptions = {},
): (input: I) => Promise<WebhookOutcome> {
  const topics = new Set((opts.topics ?? SESSION_FREE_TOPICS).map((t) => t.toLowerCase()));
  const isSessionGone = opts.isSessionGone ?? defaultIsSessionGone;
  return async (input: I): Promise<WebhookOutcome> => {
    if (input?.hmacVerified !== true) {
      throw new TypeError('uninstallSafeWebhook: verify the webhook HMAC first and pass hmacVerified: true');
    }
    const topic = String(input.topic ?? '').toLowerCase();
    const guarded = topics.has(topic);
    let sessionGone = false;
    try {
      await handler(input);
    } catch (err) {
      if (!guarded || !isSessionGone(err)) return { status: 500, sessionGone: false, error: err };
      sessionGone = true;
      try {
        opts.onSessionGone?.({ topic, shop: input.shop, error: err });
      } catch {
        /* logging must not change the response */
      }
    }
    if (topic === 'app/uninstalled' && opts.storage?.delete) {
      try {
        await opts.storage.delete(input.shop);
      } catch (err) {
        return { status: 500, sessionGone, error: err };
      }
    }
    return { status: 200, sessionGone };
  };
}
