/**
 * Error classes. Each carries a stable `code` so callers (and the webhook
 * wrapper) can branch without `instanceof` across module copies.
 */

export class TokenGuardError extends Error {
  readonly code: string;
  readonly shop: string | undefined;
  readonly status: number | undefined;
  constructor(code: string, message: string, opts: { shop?: string; status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'TokenGuardError';
    this.code = code;
    this.shop = opts.shop;
    this.status = opts.status;
  }
}

/** No stored token record for this shop (never installed, or deleted after uninstall / terminal 401). */
export class NoSessionError extends TokenGuardError {
  constructor(shop: string) {
    super('NO_SESSION', `No stored offline token for ${shop}`, { shop });
    this.name = 'NoSessionError';
  }
}

/**
 * Shopify answered the refresh with 401. Per
 * https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange#refresh-an-expiring-offline-token
 * this is terminal ("stop retrying, and re-authenticate by running token exchange
 * the next time a merchant opens your app"). It covers unknown, replaced, expired,
 * revoked and uninstalled cases alike; Shopify does not say which.
 */
export class ReauthorizeRequiredError extends TokenGuardError {
  constructor(shop: string, status = 401) {
    super('REAUTHORIZE_REQUIRED', `Refresh token for ${shop} is no longer usable; the merchant must re-authenticate`, { shop, status });
    this.name = 'ReauthorizeRequiredError';
  }
}

/** Network error, timeout, 429 or 5xx after all retries. Stored tokens were left untouched; retrying later is safe. */
export class TransientRefreshError extends TokenGuardError {
  constructor(shop: string, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super('TRANSIENT', message, { shop, ...opts });
    this.name = 'TransientRefreshError';
  }
}

/** A non-retryable rejection (e.g. 400, 403 bad client credentials) or a malformed success body. Stored tokens untouched. */
export class RefreshRejectedError extends TokenGuardError {
  readonly body: unknown;
  constructor(shop: string, message: string, opts: { status?: number; body?: unknown } = {}) {
    super('REJECTED', message, { shop, status: opts.status });
    this.name = 'RefreshRejectedError';
    this.body = opts.body;
  }
}

/** The stored token has no refresh token (a non-expiring token): it cannot be refreshed, only migrated. */
export class NotRefreshableError extends TokenGuardError {
  constructor(shop: string) {
    super('NOT_REFRESHABLE', `Stored token for ${shop} has no refresh token (non-expiring); migrate it instead`, { shop });
    this.name = 'NotRefreshableError';
  }
}

/** The shop string is not a plain `<name>.myshopify.com` domain. Refused so client credentials never go to another host. */
export class InvalidShopError extends TokenGuardError {
  constructor(shop: string) {
    super('INVALID_SHOP', `Refusing to send credentials: "${shop}" is not a <name>.myshopify.com domain`, { shop });
    this.name = 'InvalidShopError';
  }
}
