/**
 * Deadline — wraps AbortController. Backbone of INV-09: the AI pipeline
 * aborts at 15,000 ms. Remaining budget is recomputed before every stage;
 * a stage that cannot fit in the remaining budget is SKIPPED, not started.
 */
import { AppError } from './appError.js'

export class Deadline {
  readonly #controller: AbortController
  readonly #expiresAt: number
  #timer: ReturnType<typeof setTimeout> | null = null

  private constructor(totalMs: number, now: number) {
    if (!Number.isInteger(totalMs) || totalMs <= 0) {
      throw new TypeError(`Deadline: totalMs must be a positive integer, got ${totalMs}`)
    }
    this.#controller = new AbortController()
    this.#expiresAt = now + totalMs
    this.#timer = setTimeout(() => this.#controller.abort(new AppError('UPSTREAM_FAILED', 'deadline exceeded')), totalMs)
    // Never keep the process alive just for a deadline.
    if (typeof this.#timer.unref === 'function') this.#timer.unref()
  }

  static start(totalMs: number, now: number = Date.now()): Deadline {
    return new Deadline(totalMs, now)
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get expired(): boolean {
    return Date.now() >= this.#expiresAt || this.#controller.signal.aborted
  }

  /** Milliseconds left; never negative. */
  remaining(now: number = Date.now()): number {
    return Math.max(0, this.#expiresAt - now)
  }

  /**
   * Guard before a stage: throws if fewer than `ms` remain. The caller skips
   * the stage (or hands over) — it must NOT start it.
   */
  assertRemaining(ms: number, now: number = Date.now()): void {
    if (this.remaining(now) < ms) {
      throw new AppError('UPSTREAM_FAILED', `deadline: ${this.remaining(now)}ms remaining, stage needs ${ms}ms`, {
        remainingMs: this.remaining(now),
        requiredMs: ms,
      })
    }
  }

  /**
   * Child deadline for a single stage: min(stage budget, remaining budget).
   * Aborts when either the child or the parent expires.
   */
  child(ms: number, now: number = Date.now()): Deadline {
    const budget = Math.min(ms, this.remaining(now))
    if (budget <= 0) {
      throw new AppError('UPSTREAM_FAILED', 'deadline: no budget remaining for child stage')
    }
    const childDeadline = new Deadline(budget, now)
    const abortChild = () => childDeadline.#controller.abort(this.#controller.signal.reason as Error)
    if (this.#controller.signal.aborted) abortChild()
    else this.#controller.signal.addEventListener('abort', abortChild, { once: true })
    return childDeadline
  }

  /** Cancel the timer (success path). */
  clear(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }
}
