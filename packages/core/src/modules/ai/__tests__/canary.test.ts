/**
 * P9 — evalCanary (§13.2 row 9, P-10): deterministic 20-case subset, run
 * through the same assemble→complete→parse→ground path as production, and a
 * regression (fabricated id, wrong price, missed injection) is DETECTED.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockLlmClient } from '@inboxbondhu/integrations'
import {
  KnowledgeItem, Membership, Product, User, Workspace,
  createIndexes, mongoTextRetriever, pickCanarySubset, runEvalCanary,
  type CanaryCase,
} from '../../../index.js'
import { dropData, startDb, stopDb } from '../../../__tests__/setupDb.js'

const here = dirname(fileURLToPath(import.meta.url))
const CORPUS_PATH = join(here, '..', '..', '..', '..', '..', '..', 'evals', 'banglish-corpus.jsonl')

function loadCorpus(): CanaryCase[] {
  return readFileSync(CORPUS_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CanaryCase)
}

let ws: string

beforeAll(async () => {
  await startDb()
  await dropData()
  await createIndexes()
  const owner = await User.create({
    ulid: 'c'.repeat(26), email: 'canary@x.example', passwordHash: 'h', name: 'Canary Owner',
  })
  const workspace = await Workspace.create({ name: 'Canary Shop', slug: 'canary-shop', ownerId: owner._id, businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) } })
  ws = String(workspace._id)
  await Membership.create({ workspaceId: ws, userId: owner._id, role: 'owner', joinedAt: new Date() })
  await Product.create({
    workspaceId: ws, sku: 'JAMA-01', name: 'Cotton Jama',
    description: 'Cotton Jama comfortable deshi fabric sizes M L XL',
    basePriceMinor: 1499_00,
    variants: [{ sku: 'JAMA-01-M', name: 'M', stock: 5, reserved: 0, isActive: true }],
    status: 'active', searchText: ' ',
  })
  await KnowledgeItem.create({
    workspaceId: ws, question: 'Delivery charge koto?',
    answer: 'Dhaka city te delivery charge 60 taka, Dhakar baire 120 taka.',
    status: 'approved', approvedBy: owner._id, searchText: ' ',
  })
}, 300_000)

afterAll(async () => {
  await stopDb()
})

describe('evalCanary', () => {
  it('pickCanarySubset is deterministic and spans the corpus', () => {
    const corpus = loadCorpus()
    const a = pickCanarySubset(corpus, 20)
    const b = pickCanarySubset([...corpus].reverse(), 20) // input order must not matter
    expect(a).toHaveLength(20)
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id))
    // Spans: first and last corpus regions both represented.
    const sortedIds = [...corpus].sort((x, y) => x.id.localeCompare(y.id)).map((c) => c.id)
    expect(sortedIds.indexOf(a[19]!.id)).toBeGreaterThan(sortedIds.length / 2)
  })

  it('a healthy pipeline passes the 20-case subset', async () => {
    const { client: llm } = createMockLlmClient()
    const subset = pickCanarySubset(loadCorpus(), 20)
    const result = await runEvalCanary(ws, subset, { llm, retriever: mongoTextRetriever })
    expect(result.total).toBe(20)
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
    expect(result.passed).toBe(20)
  })

  it('DETECTS a regression: model starts fabricating source ids', async () => {
    const { client: llm, state } = createMockLlmClient()
    const factCases = loadCorpus().filter(
      (c) => c.expectedAction === 'reply' && /price|delivery|availability/.test(c.expectedIntent),
    ).slice(0, 3)
    // Every call fabricates an uncited id — the grounding gate must catch it.
    const originalComplete = llm.complete.bind(llm)
    const broken = {
      complete: async (p: Parameters<typeof llm.complete>[0], o: Parameters<typeof llm.complete>[1]) => {
        state.nextDecisionMutator = (d) => {
          d['sourceIds'] = ['fabricated-000000000000']
        }
        return originalComplete(p, o)
      },
    }
    const result = await runEvalCanary(ws, factCases, { llm: broken, retriever: mongoTextRetriever })
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures[0]!.reason).toContain('grounding blocked')
  })

  it('DETECTS a regression: parse failures surface as canary failures', async () => {
    const { client: llm, state } = createMockLlmClient()
    const one = loadCorpus().filter((c) => c.expectedAction === 'reply' && !c.injection).slice(0, 1)
    state.nextRawText = 'NOT JSON AT ALL'
    const result = await runEvalCanary(ws, one, { llm, retriever: mongoTextRetriever })
    expect(result.passed).toBe(0)
    expect(result.failures[0]!.reason).toMatch(/parse failed|canary error/)
  })

  it('injection cases pass ONLY via the pre-filter handover path', async () => {
    const { client: llm } = createMockLlmClient()
    const injections = loadCorpus().filter((c) => c.injection).slice(0, 4)
    expect(injections.length).toBeGreaterThan(0)
    const result = await runEvalCanary(ws, injections, { llm, retriever: mongoTextRetriever })
    expect(result.failures, JSON.stringify(result.failures)).toEqual([])
  })
})
