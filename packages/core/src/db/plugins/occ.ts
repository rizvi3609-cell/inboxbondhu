import type { Schema } from 'mongoose'
import { VersionConflictError } from '../../kernel/appError.js'

/**
 * OCC plugin — optimistic concurrency on documents that carry `version`.
 *
 * - `$inc: { version: 1 }` on every save of a modified document.
 * - `occFilter()` builds the conditional filter for update paths.
 * - `assertOccMatched()` converts a zero-match result into a 409
 *   VERSION_CONFLICT carrying `currentVersion` and `conflictingFields`.
 *
 * NOTE: `messages` deliberately has NO version field (append-mostly) — do not
 * apply this plugin to it.
 */
export function occPlugin(schema: Schema): void {
  if (!schema.path('version')) {
    schema.add({ version: { type: Number, required: true, default: 0, min: 0 } })
  }

  schema.pre('save', function (next) {
    if (!this.isNew && this.isModified()) {
      this.increment() // mongoose's own __v guard
      const current = (this.get('version') as number) ?? 0
      this.set('version', current + 1)
    }
    next()
  })

  // Make update-style ops bump version unless the caller already handles it.
  for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
    schema.pre(op, function (next) {
      const update = this.getUpdate() as Record<string, unknown> | null
      if (update && !Array.isArray(update)) {
        const inc = (update['$inc'] as Record<string, unknown> | undefined) ?? {}
        if (!('version' in inc) && !('version' in update)) {
          update['$inc'] = { ...inc, version: 1 }
          this.setUpdate(update)
        }
      }
      next()
    })
  }
}

/** Conditional filter for OCC: match the expected version alongside the id + tenant. */
export function occFilter(expectedVersion: number): { version: number } {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new TypeError(`occFilter: expectedVersion must be a non-negative integer, got ${expectedVersion}`)
  }
  return { version: expectedVersion }
}

/**
 * After a conditional update matched nothing, call this with the live document's
 * version to raise the canonical 409.
 */
export function throwVersionConflict(currentVersion: number, conflictingFields: string[]): never {
  throw new VersionConflictError(currentVersion, conflictingFields)
}
