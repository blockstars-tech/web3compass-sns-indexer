/**
 * Slim subset of upstream `UtilsProvider`. Only the helpers actually used by
 * the SNS indexer are vendored; the upstream version pulls in bcrypt,
 * mongoose, and text-cleaner which we do not need here.
 */
const NUL_CHAR = String.fromCharCode(0);
const NUL_REGEX = new RegExp(NUL_CHAR, 'g');

export interface IRetryOptions {
  /** Total attempts (including the first). Default 6 — covers ~30s of 429 storms. */
  retries?: number;
  /** Initial delay in ms. Default 500. */
  delay?: number;
  /** Multiplicative factor per attempt. Default 2. */
  backoff?: number;
  /** Hard ceiling on a single sleep, in ms. Default 30_000. */
  maxDelay?: number;
}

interface IMaybeHttpError {
  response?: { status?: number };
  status?: number;
  statusCode?: number;
  code?: number | string;
  message?: string;
}

/** Errors `@solana/web3.js` raises for HTTP 429 / 5xx surface as plain `Error`s with the status in the message. */
const RETRYABLE_STATUS_REGEX = /\b(429|500|502|503|504)\b/;
const RETRYABLE_TEXT_HINTS = [
  'too many requests',
  'rate limit',
  'rate-limit',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'request timeout',
  'fetch failed',
  'socket hang up',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'network error',
  // Helius-specific transient hints. Without these, the
  // `getProgramAccountsV2` "account index service overloaded, please
  // try again" error is mis-classified as non-retryable and the
  // exponential-backoff helper gives up on the first attempt.
  'overloaded',
  'try again',
  'temporarily',
];

/** Heuristic — true if this error is worth retrying with backoff. */
export function isRetryableRpcError(error: unknown): boolean {
  const err = error as IMaybeHttpError | undefined;

  if (!err) {
    return false;
  }

  const status =
    err.response?.status ??
    (typeof err.status === 'number' ? err.status : undefined) ??
    (typeof err.statusCode === 'number' ? err.statusCode : undefined) ??
    (typeof err.code === 'number' ? err.code : undefined);

  if (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }

  const code = typeof err.code === 'string' ? err.code : undefined;

  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }

  const message = (err.message ?? '').toLowerCase();

  if (!message) {
    return false;
  }

  if (RETRYABLE_STATUS_REGEX.test(message)) {
    return true;
  }

  return RETRYABLE_TEXT_HINTS.some((hint) => message.includes(hint));
}

export class UtilsProvider {
  /**
   * Convert an entity (or array of entities) to a DTO class instance.
   * Mirrors upstream signature so vendored entities `toDto()` calls work.
   */
  public static toDto<T, E>(
    model: new (entity: E, options?: Record<string, unknown>) => T,
    entity: E,
    options?: Record<string, unknown>,
  ): T;

  public static toDto<T, E>(
    model: new (entity: E, options?: Record<string, unknown>) => T,
    entity: E[],
    options?: Record<string, unknown>,
  ): T[];

  public static toDto<T, E>(
    model: new (entity: E, options?: Record<string, unknown>) => T,
    entity: E | E[],
    options?: Record<string, unknown>,
  ): T | T[] {
    if (Array.isArray(entity)) {
      return entity.map((u) => new model(u, options));
    }

    return new model(entity, options);
  }

  /** Strip null bytes from CIDs. Some V1 SNS records pad payload with NUL. */
  public static sanitizeCID(cid: string): string {
    return cid.replace(NUL_REGEX, '');
  }

  /**
   * Exponential backoff with jitter for transient RPC failures (HTTP 429,
   * 5xx, and common Node socket errors). Re-throws the *original* error
   * after the final attempt so callers see the real cause, not a synthetic
   * "Failed after N retries" message.
   *
   * Supports both the legacy positional signature
   * `(fn, retries, delay, backoff)` and an options object — old callers in
   * `web3compassapi` continue to compile unchanged.
   */
  public static async retryWithExponentialBackoff<T>(
    fn: () => Promise<T>,
    retriesOrOptions: number | IRetryOptions = 6,
    delay = 500,
    backoff = 2,
  ): Promise<T> {
    const opts: Required<IRetryOptions> =
      typeof retriesOrOptions === 'object'
        ? {
            retries: retriesOrOptions.retries ?? 6,
            delay: retriesOrOptions.delay ?? 500,
            backoff: retriesOrOptions.backoff ?? 2,
            maxDelay: retriesOrOptions.maxDelay ?? 30_000,
          }
        : {
            retries: retriesOrOptions,
            delay,
            backoff,
            maxDelay: 30_000,
          };

    let attempt = 0;
    let lastError: unknown;

    while (attempt < opts.retries) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await fn();
      } catch (error) {
        lastError = error;

        if (!isRetryableRpcError(error)) {
          throw error;
        }

        attempt += 1;

        if (attempt >= opts.retries) {
          break;
        }

        const expBackoff = opts.delay * opts.backoff ** attempt;
        const jitter = Math.random() * opts.delay;
        const waitTime = Math.min(opts.maxDelay, expBackoff + jitter);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    throw lastError;
  }
}
