import mongoose from 'mongoose'
import { generateAll } from './jsonSchema/generate.js'

/**
 * Applies the generated $jsonSchema validators to each collection via
 * collMod (validationLevel: 'moderate' — existing docs are not re-validated,
 * new writes are). Run by migrations/boot, and by the Phase 1 DoD test that
 * asserts db.getCollectionInfos() shows validators.
 */
export async function applyValidators(): Promise<string[]> {
  const db = mongoose.connection.db
  if (!db) throw new Error('applyValidators: not connected')
  const applied: string[] = []
  const generated = generateAll()
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name))
  for (const [collection, schema] of Object.entries(generated)) {
    if (!existing.has(collection)) await db.createCollection(collection).catch(() => undefined)
    await db.command({
      collMod: collection,
      validator: { $jsonSchema: schema },
      validationLevel: 'moderate',
      validationAction: 'error',
    })
    applied.push(collection)
  }
  return applied
}
