/**
 * TenantContext — immutable. Constructed only by the `tenant` middleware (apps/api)
 * or from a worker job header. INV-01: every tenant-scoped query filters by
 * `workspaceId` FROM THIS CONTEXT — never from a request body or bare URL param.
 */
export interface TenantContext {
  readonly workspaceId: string
  readonly userId: string
  readonly role: 'owner' | 'admin' | 'agent' | 'viewer' | 'system'
  readonly requestId: string
}

export function makeTenantContext(input: TenantContext): TenantContext {
  return Object.freeze({ ...input })
}
