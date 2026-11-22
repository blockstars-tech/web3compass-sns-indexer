import { describe, expect, it } from 'vitest';

import { TokenBucket } from '../../src/providers/token-bucket';

describe('TokenBucket', () => {
  it('lets the first `capacity` calls through immediately', async () => {
    const bucket = new TokenBucket(5);
    const start = Date.now();

    await Promise.all([
      bucket.acquire(),
      bucket.acquire(),
      bucket.acquire(),
      bucket.acquire(),
      bucket.acquire(),
    ]);

    expect(Date.now() - start).toBeLessThan(50);
  });

  it('queues acquisitions past the capacity until tokens refill', async () => {
    // 10 RPS → ~100ms per token. Acquire 12 in a row; the last 2 should
    // wait roughly 200ms total before resolving.
    const bucket = new TokenBucket(10);
    const start = Date.now();

    await Promise.all(
      Array.from({ length: 12 }, () => bucket.acquire()),
    );

    const elapsed = Date.now() - start;
    // Lower bound: 2 tokens beyond capacity × 100ms each = 200ms,
    // minus the floor on first refill. Allow a small margin.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    // Upper bound: shouldn't take an order of magnitude longer.
    expect(elapsed).toBeLessThan(800);
  });

  it('rejects non-positive capacity', () => {
    expect(() => new TokenBucket(0)).toThrow();
    expect(() => new TokenBucket(-1)).toThrow();
  });

  it('rejects non-positive refill rate', () => {
    expect(() => new TokenBucket(5, 0)).toThrow();
    expect(() => new TokenBucket(5, -1)).toThrow();
  });

  it('rejects non-finite capacity and refill rate instead of hanging', () => {
    expect(() => new TokenBucket(undefined as unknown as number)).toThrow();
    expect(() => new TokenBucket(Number.NaN)).toThrow();
    expect(() => new TokenBucket(5, Number.NaN)).toThrow();
  });

  it('tryAcquire takes available tokens and returns false when empty, without waiting', () => {
    const bucket = new TokenBucket(2, 1);

    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
  });
});
