export class CircuitOpenError extends Error {
  constructor(message = "circuit breaker is open") {
    super(message);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  #failures = 0;
  #openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get isOpen(): boolean {
    if (this.#openedAt === null) return false;
    if (this.now() - this.#openedAt >= this.cooldownMs) {
      this.#openedAt = null;
      this.#failures = 0;
      return false;
    }
    return true;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isOpen) throw new CircuitOpenError();
    try {
      const result = await operation();
      this.#failures = 0;
      this.#openedAt = null;
      return result;
    } catch (error) {
      this.#failures += 1;
      if (this.#failures >= this.threshold) {
        this.#openedAt = this.now();
      }
      throw error;
    }
  }
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const response = await fetch(input, init);
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`upstream responded ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === policy.maxAttempts) break;
      const backoff = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1),
      );
      await delay(backoff + Math.random() * policy.baseDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
