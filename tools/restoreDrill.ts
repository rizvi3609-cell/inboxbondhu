/**
 * Phase 9 restore drill (§19 checklist: "Restore drill executed once, end to
 * end"; architecture.md §13: monthly restore drill to a scratch cluster).
 *
 * What it proves, end to end:
 *   1. BACKUP  — dump every collection (canonical EJSON — full BSON type
 *               fidelity: ObjectIds stay ObjectIds, Dates stay Dates) plus
 *               index definitions to a dated directory. Production uses DO
 *               managed snapshots + PITR; this drill proves the RESTORE
 *               choreography and data integrity, which snapshots alone never
 *               prove.
 *   2. RESTORE — recreate indexes, then load the dump into a SEPARATE
 *               scratch database, starting from a dropped (empty) DB.
 *   3. VERIFY  — per-collection counts match; per-collection canonical-EJSON
 *               content hashes match; a business invariant re-checked on the
 *               restored data (every order's subtotal == Σ line totals).
 *
 * Usage:
 *   tsx tools/restoreDrill.ts [sourceUri] [scratchUri]
 *   default source: MONGODB_URI (or the local dev RS)
 *   default scratch: same host, db "inboxbondhu_restore_drill"
 *
 * Exit 0 = drill passed. Non-zero = the backup is NOT restorable — fix that
 * before trusting any retention/DR statement.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import mongoose from 'mongoose'
import { EJSON } from 'bson'
// tools/ is not a workspace package — relative import to the ONE env reader.
import { loadSeedConfig } from '../packages/config/src/index.js'

const seedCfg = loadSeedConfig()
const sourceUri = process.argv[2] ?? seedCfg.MONGODB_URI
const scratchUri = process.argv[3] ?? sourceUri.replace(/\/([A-Za-z0-9_-]+)(\?|$)/, '/inboxbondhu_restore_drill$2')

const DUMP_DIR = join(process.cwd(), '.restore-drill', new Date().toISOString().slice(0, 10))

/** Canonical-EJSON hash, _id-sorted so scan order can never affect it. */
function contentHash(docs: Array<Record<string, unknown>>): string {
  const canonical = docs
    .map((d) => EJSON.stringify(d, { relaxed: false }))
    .sort()
  return createHash('sha256').update(canonical.join('\n')).digest('hex')
}

async function main(): Promise<void> {
  console.log(`restore drill\n  source : ${sourceUri}\n  scratch: ${scratchUri}\n  dump   : ${DUMP_DIR}`)
  mkdirSync(DUMP_DIR, { recursive: true })

  // ── 1. BACKUP ──────────────────────────────────────────────────────────────
  const source = await mongoose.createConnection(sourceUri).asPromise()
  const sourceDb = source.db!
  const collections = (await sourceDb.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort()

  const manifest: Record<string, { count: number; hash: string }> = {}
  for (const name of collections) {
    const docs = (await sourceDb.collection(name).find({}).toArray()) as Array<Record<string, unknown>>
    const indexes = await sourceDb.collection(name).indexes()
    writeFileSync(
      join(DUMP_DIR, `${name}.ejson`),
      EJSON.stringify({ docs, indexes }, { relaxed: false }),
    )
    manifest[name] = { count: docs.length, hash: contentHash(docs) }
    console.log(`  dumped ${name}: ${docs.length} docs, ${indexes.length} indexes`)
  }
  writeFileSync(join(DUMP_DIR, '_manifest.json'), JSON.stringify(manifest, null, 2))
  await source.close()

  // ── 2. RESTORE into the scratch DB ─────────────────────────────────────────
  const scratch = await mongoose.createConnection(scratchUri).asPromise()
  const scratchDb = scratch.db!
  await scratchDb.dropDatabase() // a real restore starts from nothing

  for (const file of readdirSync(DUMP_DIR).filter((f) => f.endsWith('.ejson'))) {
    const name = file.replace(/\.ejson$/, '')
    const parsed = EJSON.parse(readFileSync(join(DUMP_DIR, file), 'utf8'), { relaxed: false }) as {
      docs: Array<Record<string, unknown>>
      indexes: Array<Record<string, unknown>>
    }
    // Indexes FIRST on the empty collection — mirrors mongorestore's order
    // and proves unique indexes accept the data.
    for (const idx of parsed.indexes) {
      if (idx['name'] === '_id_') continue
      const { key, name: idxName, ...rest } = idx as { key: Record<string, number>; name: string }
      const opts = { ...rest } as Record<string, unknown>
      delete opts['v']
      delete opts['ns']
      delete opts['background']
      await scratchDb.collection(name).createIndex(key, { name: idxName, ...opts })
    }
    if (parsed.docs.length > 0) {
      await scratchDb.collection(name).insertMany(parsed.docs, { ordered: true })
    }
    console.log(`  restored ${name}: ${parsed.docs.length} docs`)
  }

  // ── 3. VERIFY ──────────────────────────────────────────────────────────────
  const failures: string[] = []
  for (const [name, expected] of Object.entries(manifest)) {
    const docs = (await scratchDb.collection(name).find({}).toArray()) as Array<Record<string, unknown>>
    if (docs.length !== expected.count) {
      failures.push(`${name}: restored count ${docs.length} ≠ ${expected.count}`)
      continue
    }
    if (contentHash(docs) !== expected.hash) {
      failures.push(`${name}: content hash mismatch — restored bytes differ from the dump`)
    }
  }

  // Business-invariant spot check on the RESTORED data.
  const orders = (await scratchDb.collection('orders').find({}).toArray()) as Array<Record<string, unknown>>
  for (const o of orders) {
    const items = (o['items'] ?? []) as Array<{ lineTotalMinor: number }>
    const subtotal = items.reduce((s, i) => s + i.lineTotalMinor, 0)
    if (subtotal !== o['subtotalMinor']) {
      failures.push(`orders/${String(o['_id'])}: subtotalMinor ${String(o['subtotalMinor'])} ≠ Σ lineTotalMinor ${subtotal}`)
    }
  }
  console.log(`  verified ${orders.length} restored orders' money integrity`)

  await scratch.close()

  if (failures.length > 0) {
    console.error('RESTORE DRILL FAILED:\n- ' + failures.join('\n- '))
    process.exit(1)
  }
  console.log(`RESTORE DRILL PASSED — ${collections.length} collections, counts + hashes + invariants verified.`)
}

void main().catch((err: Error) => {
  console.error(`restore drill could not run: ${err.message}`)
  process.exit(1)
})
