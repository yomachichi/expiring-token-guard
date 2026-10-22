export {
  createTokenGuard,
  needsRefresh,
  normalizeShop,
  isNonExpiringTokenRejected,
  defaultIsUnauthorized,
} from './guard.js';
export type { TokenGuard, MigrationResult, WithValidTokenOptions } from './guard.js';
export {
  uninstallSafeWebhook,
  webhookHeaders,
  defaultIsSessionGone,
  SESSION_FREE_TOPICS,
} from './webhook.js';
export type { WebhookInput, WebhookOutcome, UninstallSafeOptions } from './webhook.js';
export {
  TokenGuardError,
  NoSessionError,
  ReauthorizeRequiredError,
  TransientRefreshError,
  RefreshRejectedError,
  NotRefreshableError,
  InvalidShopError,
} from './errors.js';
export type {
  TokenRecord,
  TokenStorage,
  ShopLock,
  FetchLike,
  TokenResponseBody,
  TokenGuardOptions,
} from './types.js';
