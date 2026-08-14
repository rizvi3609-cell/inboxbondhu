/**
 * Result<T, E> — for EXPECTED failures (agent.md §4.2). Exceptions are for
 * programmer error only. Services return Result; route handlers unwrap it.
 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

export const Result = {
  ok<T>(value: T): Result<T, never> {
    return { ok: true, value }
  },

  err<E>(error: E): Result<never, E> {
    return { ok: false, error }
  },

  /** Map the success value, pass errors through. */
  map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
    return r.ok ? { ok: true, value: fn(r.value) } : r
  },

  /** Chain a Result-returning function. */
  andThen<T, U, E>(r: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
    return r.ok ? fn(r.value) : r
  },

  /** Unwrap or throw — for boundaries where the error becomes an exception. */
  unwrap<T, E>(r: Result<T, E>): T {
    if (r.ok) return r.value
    throw r.error instanceof Error ? r.error : new Error(String(r.error))
  },

  /** Wrap a promise: expected rejections become Err instead of throwing. */
  async fromPromise<T, E = Error>(
    p: Promise<T>,
    mapError: (e: unknown) => E,
  ): Promise<Result<T, E>> {
    try {
      return { ok: true, value: await p }
    } catch (e) {
      return { ok: false, error: mapError(e) }
    }
  },
} as const
