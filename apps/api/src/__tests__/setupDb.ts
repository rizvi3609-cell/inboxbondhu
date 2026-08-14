/**
 * API-test DB helper — same shape as packages/core's, duplicated because each
 * package's tsconfig rootDir forbids cross-package source imports. The vitest
 * run is a single process (isolate: false), so if core's suite already started
 * a replica set and connected mongoose, we reuse that connection.
 */
import { mkdirSync } from 'node:fs'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose from 'mongoose'

let replSet: MongoMemoryReplSet | null = null

process.once('exit', () => {
  void replSet?.stop({ doCleanup: true, force: true })
})

export async function startDb(): Promise<void> {
  if (mongoose.connection.readyState === 1) return // reuse the shared connection
  if (!replSet) {
    const dataDir = process.env['TMPDIR'] ?? `${process.env['HOME'] ?? '/tmp'}/.cache/mongoms-data`
    mkdirSync(dataDir, { recursive: true })
    process.env['TMPDIR'] = dataDir
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  }
  await mongoose.connect(replSet.getUri(), { dbName: 'inboxbondhu_api_test' })
}

export async function stopDb(): Promise<void> {
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
