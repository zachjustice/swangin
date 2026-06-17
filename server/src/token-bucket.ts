// Token-bucket rate limiter. Refills at `rateHz` tokens/s up to `cap`.
// Constructed with a full bucket so the first burst up to cap is allowed.
export class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(private cap: number, private rateHz: number) {
    this.tokens = cap;
    this.lastMs = Date.now();
  }

  allow(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.lastMs) / 1000) * this.rateHz);
    this.lastMs = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
