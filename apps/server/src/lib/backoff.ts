export interface BackoffOptions {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitter?: boolean;
}

export interface BackoffController {
  next(): number;
  reset(): void;
}

const randomJitter = (value: number): number => {
  const delta = value * 0.2;
  return value - delta + Math.random() * (delta * 2);
};

export const createExponentialBackoff = (options: BackoffOptions = {}): BackoffController => {
  const initialDelay = options.initialDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 10_000;
  const multiplier = options.multiplier ?? 2;
  const jitterEnabled = options.jitter ?? true;

  let attempt = 0;

  return {
    next(): number {
      const rawDelay = Math.min(maxDelay, initialDelay * Math.pow(multiplier, attempt));
      attempt += 1;
      return jitterEnabled ? randomJitter(rawDelay) : rawDelay;
    },
    reset(): void {
      attempt = 0;
    },
  };
};
