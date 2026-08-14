import mongoose, { type ClientSession } from 'mongoose'

/**
 * withTx() — the ONE transaction helper (prompt.md §5.8). Retries on
 * TransientTransactionError with capped backoff. Only four transactions exist:
 * T1 order-confirm, T2 member-removal, T3 ownership-transfer, T4 registration.
 * Nothing else gets a transaction.
 *
 * NEVER call Meta, the LLM, email, or Spaces inside `fn` — external side
 * effects go through the outbox, after commit (INV-10).
 */
export async function withTx<T>(
  fn: (session: ClientSession) => Promise<T>,
  opts: { maxRetries?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3
  let attempt = 0
  for (;;) {
    const session = await mongoose.startSession()
    try {
      let result!: T
      await session.withTransaction(async () => {
        result = await fn(session)
      })
      return result
    } catch (err) {
      const isTransient =
        typeof err === 'object' &&
        err !== null &&
        'errorLabels' in err &&
        Array.isArray((err as { errorLabels: unknown }).errorLabels) &&
        (err as { errorLabels: string[] }).errorLabels.includes('TransientTransactionError')
      attempt += 1
      if (!isTransient || attempt > maxRetries) throw err
      await new Promise((r) => setTimeout(r, Math.min(50 * 2 ** attempt, 500)))
    } finally {
      await session.endSession()
    }
  }
}
