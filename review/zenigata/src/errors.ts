/**
 * Errors shared by the pipelines.
 */

/** A run's deadline fired; the race abandons the body. */
export class TimedOutError extends Error {
  constructor(readonly stage: string) {
    super(`run timed out in stage ${stage}`);
    this.name = "TimedOutError";
  }
}
