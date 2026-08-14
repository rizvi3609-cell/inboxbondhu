/**
 * AppError — the only error shape the client ever sees.
 * `code` must be one of the 18 canonical codes (prompt.md §7.2 / agent.md §11).
 */
export const CANONICAL_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'SESSION_REVOKED',
  'INSUFFICIENT_PERMISSIONS',
  'WORKSPACE_FORBIDDEN',
  'CSRF_TOKEN_INVALID',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'DUPLICATE_RESOURCE',
  'BUSINESS_RULE_VIOLATION',
  'ACCOUNT_LOCKED',
  'PRECONDITION_REQUIRED',
  'RATE_LIMITED',
  'PLAN_LIMIT_EXCEEDED',
  'NOT_IMPLEMENTED',
  'UPSTREAM_FAILED',
  'DEGRADED_MODE',
] as const

export type CanonicalCode = (typeof CANONICAL_CODES)[number]

export class AppError extends Error {
  readonly code: CanonicalCode
  readonly details?: Record<string, unknown>

  constructor(code: CanonicalCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AppError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

/**
 * VERSION_CONFLICT is the only code that extends the error envelope:
 * it carries `currentVersion` and `conflictingFields`.
 */
export class VersionConflictError extends AppError {
  readonly currentVersion: number
  readonly conflictingFields: string[]

  constructor(currentVersion: number, conflictingFields: string[]) {
    super('VERSION_CONFLICT', 'The resource was modified by someone else. Refresh and retry.', {
      currentVersion,
      conflictingFields,
    })
    this.currentVersion = currentVersion
    this.conflictingFields = conflictingFields
  }
}
