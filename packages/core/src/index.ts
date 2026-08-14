export { AppError, VersionConflictError, CANONICAL_CODES, type CanonicalCode } from './kernel/appError.js'
export { makeTenantContext, type TenantContext } from './kernel/tenantContext.js'
export { Money, type MoneyMinor } from './kernel/money.js'
export { Result } from './kernel/result.js'
export { ulid, isUlid, ulidTime, ULID_REGEX } from './kernel/ulid.js'
export { DhakaTime, type BusinessDay } from './kernel/dhakaTime.js'
export { Deadline } from './kernel/deadline.js'
export { createEventBus, type EventBus, type DomainEvent, type EventHandler } from './kernel/eventBus.js'
export * from './db/index.js'
export * from './modules/identity/index.js'
export * from './modules/workspace/index.js'
export * from './modules/channels/index.js'
export * from './modules/inbox/index.js'
export * from './modules/catalogue/index.js'
export * from './modules/knowledge/index.js'
export * from './modules/ai/index.js'
export * from './modules/orders/index.js'
export * from './modules/payments/index.js'
export {
  bootDataLayer,
  shutdownDataLayer,
  healthCheck,
  assertNoeviction,
  connectMongo,
  createRedis,
  type DbClients,
  type HealthReport,
} from './db/client.js'
