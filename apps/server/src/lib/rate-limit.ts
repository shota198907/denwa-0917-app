export interface RateLimitState {
  readonly penaltyLevel: number;
  readonly penaltyExpiresAt: number;
}

export class AdaptiveRateLimiter {
  private penaltyLevel = 0;
  private penaltyExpiresAt = 0;
  private readonly maxPenaltyLevel = 5;

  allowSend(): boolean {
    return Date.now() >= this.penaltyExpiresAt;
  }

  markRateLimited(): void {
    this.penaltyLevel = Math.min(this.penaltyLevel + 1, this.maxPenaltyLevel);
    const delayMs = this.penaltyLevel * 1_000 + 500;
    this.penaltyExpiresAt = Date.now() + delayMs;
  }

  markSuccess(): void {
    if (this.penaltyLevel === 0) return;
    this.penaltyLevel = Math.max(this.penaltyLevel - 1, 0);
    if (this.penaltyLevel === 0) {
      this.penaltyExpiresAt = 0;
    }
  }

  snapshot(): RateLimitState {
    return { penaltyLevel: this.penaltyLevel, penaltyExpiresAt: this.penaltyExpiresAt };
  }
}
