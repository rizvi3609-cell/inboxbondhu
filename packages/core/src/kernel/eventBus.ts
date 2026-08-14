/**
 * EventBus — in-process emitter INTERFACE. The outbox is the durable path
 * (INV-10): anything that must survive a crash goes through outboxEvents,
 * never through this bus. This exists so MOD-10/11/12 can REACT to domain
 * events without being imported by domain modules (§5.1 dependency rule).
 */
export interface DomainEvent<T = unknown> {
  type: string // e.g. 'member.removed', 'order.confirmed'
  workspaceId: string
  requestId: string
  payload: T
  occurredAt: Date
}

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => void | Promise<void>

export interface EventBus {
  emit<T>(event: DomainEvent<T>): void
  on<T>(type: string, handler: EventHandler<T>): () => void
}

/**
 * Default in-process implementation. Handler failures are isolated: one
 * throwing subscriber never breaks the emitter or other subscribers —
 * failures are reported to onError (wire to the logger at boot).
 */
export function createEventBus(onError?: (err: unknown, event: DomainEvent) => void): EventBus {
  const handlers = new Map<string, Set<EventHandler>>()

  return {
    emit<T>(event: DomainEvent<T>): void {
      const subs = handlers.get(event.type)
      if (!subs) return
      for (const handler of subs) {
        try {
          const out = handler(event as DomainEvent)
          if (out instanceof Promise) {
            out.catch((err) => onError?.(err, event as DomainEvent))
          }
        } catch (err) {
          onError?.(err, event as DomainEvent)
        }
      }
    },

    on<T>(type: string, handler: EventHandler<T>): () => void {
      let subs = handlers.get(type)
      if (!subs) {
        subs = new Set()
        handlers.set(type, subs)
      }
      subs.add(handler as EventHandler)
      return () => {
        subs.delete(handler as EventHandler)
      }
    },
  }
}
