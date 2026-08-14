import { mkdirSync } from 'node:fs'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose from 'mongoose'

/**
 * Shared test DB — mongodb-memory-server AS A REPLICA SET so transactions
 * work (prompt.md §16.1). One instance per test run (vitest singleFork).
 */
let replSet: MongoMemoryReplSet | null = null

// Reap the mongod and its /tmp data dir even if a suite is interrupted —
// leaked data dirs fill tmpfs and present as fassert() startup failures.
process.once('exit', () => {
  void replSet?.stop({ doCleanup: true, force: true })
})

export async function startDb(): Promise<void> {
  if (!replSet) {
    // Keep mongod data dirs off the small tmpfs — CI boxes have tiny /tmp.
    const dataDir = process.env['TMPDIR'] ?? `${process.env['HOME'] ?? '/tmp'}/.cache/mongoms-data`
    mkdirSync(dataDir, { recursive: true })
    process.env['TMPDIR'] = dataDir
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  }
  // isolate:false shares the process across files; another suite may have
  // disconnected the default mongoose instance. Reconnect if needed.
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(replSet.getUri(), { dbName: 'inboxbondhu_test' })
  }
}

export async function stopDb(): Promise<void> {
  // Shared instance across files (isolate: false): keep the replica set alive
  // for the remaining suites; the process teardown reaps it.
  await mongoose.disconnect()
}

export async function dropData(): Promise<void> {
  const db = mongoose.connection.db
  if (!db) return
  const collections = await db.listCollections().toArray()
  for (const { name } of collections) {
    await db.collection(name).deleteMany({})
  }
}

export function oid(): string {
  return new mongoose.Types.ObjectId().toHexString()
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function fakeUlid(): string {
  let s = ''
  for (let i = 0; i < 26; i += 1) s += CROCKFORD[Math.floor(Math.random() * 32)]
  return s
}

export function sha256ish(seed: string): string {
  // 64 hex chars for fields that require a SHA-256 shape in tests.
  let out = ''
  let h = 0
  for (let i = 0; out.length < 64; i += 1) {
    h = (h * 31 + seed.charCodeAt(i % seed.length) + i) >>> 0
    out += h.toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}
