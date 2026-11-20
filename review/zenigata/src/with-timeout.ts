/**
 * Race a promise against a wall-clock bound. On timeout the promise is
 * abandoned, not cancelled — whatever it is doing keeps running — and the
 * helper rejects, so a caller's finally block never awaits unbounded work.
 */

/**
 * Resolves once the signal has aborted; never settles otherwise. A parked
 * operation races this against its gate so an abort wakes it without
 * settling the gate itself.
 */
export function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Resolve with `promise`'s outcome, or reject with a plain timeout Error
 * after `ms`. `onTimeout` runs the moment the bound fires, before the
 * rejection surfaces. The race keeps a handler on the loser, so a late
 * rejection of the abandoned promise never surfaces unhandled.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`gave up after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, bound]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}
