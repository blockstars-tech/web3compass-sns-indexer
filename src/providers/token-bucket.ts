/**
 * Async token-bucket rate limiter. Every RPC call acquires one token
 * before going on the wire; the bucket refills at `refillPerSec` tokens
 * per second up to `capacity`. When the bucket is empty, callers queue
 * and resolve in FIFO order as tokens become available.
 *
 * Used to cap Solana RPC throughput process-wide so we don't burst above
 * the provider's per-key rate limit. One bucket per `Connection`; lives
 * for the process lifetime.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private readonly waiting: Array<() => void> = [];
  private timerHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    /** Max burst size (also the steady-state RPS). */
    private readonly capacity: number,
    /** Refill rate in tokens per second. Defaults to `capacity` for a flat RPS cap. */
    private readonly refillPerSec: number = capacity,
  ) {
    if (capacity <= 0) {
      throw new Error(`TokenBucket capacity must be > 0 (got ${capacity})`);
    }

    if (refillPerSec <= 0) {
      throw new Error(
        `TokenBucket refillPerSec must be > 0 (got ${refillPerSec})`,
      );
    }

    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  /** Acquire one token, waiting if the bucket is empty. */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;

      return;
    }

    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      this.scheduleNextDrain();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillAt) / 1000;

    if (elapsedSec > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsedSec * this.refillPerSec,
      );
      this.lastRefillAt = now;
    }
  }

  private scheduleNextDrain(): void {
    if (this.timerHandle !== null) {
      return;
    }

    const tokensNeeded = Math.max(0.001, 1 - this.tokens);
    // Round up to whole ms; never sleep less than 5ms to keep the event
    // loop responsive even if the math says fractions of a ms.
    const msToWait = Math.max(
      5,
      Math.ceil((tokensNeeded * 1000) / this.refillPerSec),
    );

    this.timerHandle = setTimeout(() => {
      this.timerHandle = null;
      this.drain();
    }, msToWait);
  }

  private drain(): void {
    this.refill();

    while (this.waiting.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.waiting.shift()!();
    }

    if (this.waiting.length > 0) {
      this.scheduleNextDrain();
    }
  }
}
