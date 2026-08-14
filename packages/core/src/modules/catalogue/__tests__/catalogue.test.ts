/**
 * MOD-06 tests — DoD:
 * - 5000-row CSV imports with a per-row error report
 * - kill mid-import + restart resumes with ZERO duplicates (MVP gate #9)
 * - a cell starting =cmd() is neutralised
 * - UTF-8 only; plan cap enforced DURING import; cancel stops at checkpoint
 * - product CRUD: archive-not-delete, restore, compare-at rule, OCC
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  Import, Membership, Product, User, Workspace,
  CatalogueService, decodeUtf8Strict, neutraliseFormulaCell, parseCsv, CsvEncodingError,
} from '../../../index.js'
import { makeTenantContext, type TenantContext } from '../../../kernel/tenantContext.js'
import { dropData, fakeUlid, oid, startDb, stopDb } from '../../../__tests__/setupDb.js'

let svc: CatalogueService

beforeAll(async () => {
  await startDb()
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
  svc = new CatalogueService()
})

async function fixture(plan: 'trial' | 'starter' | 'growth' = 'growth'): Promise<{ ws: string; ctx: TenantContext }> {
  const owner = await User.create({
    ulid: fakeUlid(), email: `o${Math.random().toString(36).slice(2)}@x.example`,
    passwordHash: 'h', name: 'Owner Person', emailVerifiedAt: new Date(),
  })
  const ws = await Workspace.create({
    name: 'Rupa Fashion', slug: `rupa-${Math.random().toString(36).slice(2, 8)}`, ownerId: owner._id, plan,
    businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) },
    aiConfig: {},
  })
  await Membership.create({ workspaceId: ws._id, userId: owner._id, role: 'admin', joinedAt: new Date() })
  return {
    ws: String(ws._id),
    ctx: makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'admin', requestId: fakeUlid() }),
  }
}

const HEADER = 'sku,name,description,category,price,variant_sku,variant_name,stock,color,size'
function csvOf(rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8')
}

describe('CSV sanitisation (DoD #3)', () => {
  it('neutralises leading =, +, -, @, |, TAB — the =cmd() case included', () => {
    expect(neutraliseFormulaCell('=cmd()')).toBe('cmd()')
    expect(neutraliseFormulaCell('=1+1')).toBe('1+1')
    expect(neutraliseFormulaCell('+8801712345678')).toBe('8801712345678')
    expect(neutraliseFormulaCell('-DROP TABLE')).toBe('DROP TABLE')
    expect(neutraliseFormulaCell('@SUM(A1)')).toBe('SUM(A1)')
    expect(neutraliseFormulaCell('|calc')).toBe('calc')
    expect(neutraliseFormulaCell('\t=HYPERLINK(evil)')).toBe('HYPERLINK(evil)')
    expect(neutraliseFormulaCell('normal jama')).toBe('normal jama') // untouched
  })

  it('a formula cell in a real CSV never reaches the stored product', async () => {
    const { ws, ctx } = await fixture()
    const start = await svc.startImport(ctx, 'f.csv', csvOf(['INJ-1,=cmd()|shell,,,100,INJ-1-V,Standard,5,,']))
    if (!start.ok) throw start.error
    await svc.processImport(ws, start.value.importId)
    const p = await Product.findOne({ workspaceId: ws, sku: 'INJ-1' }).exec()
    expect(p!.name).toBe('cmd()|shell') // leading = stripped before parsing
  })

  it('rejects non-UTF-8 with a clear message (never mojibake)', async () => {
    const { ctx } = await fixture()
    const latin1 = Buffer.from([0x73, 0x6b, 0x75, 0x0a, 0xe9, 0xe8, 0xff]) // é è ÿ in latin-1
    expect(() => decodeUtf8Strict(latin1)).toThrow(CsvEncodingError)
    const res = await svc.startImport(ctx, 'bad.csv', latin1)
    expect(!res.ok && res.error.code).toBe('VALIDATION_FAILED')
    if (!res.ok) expect(res.error.message).toMatch(/UTF-8/)
  })

  it('parses quoted fields, escaped quotes, CRLF', () => {
    const { header, rows } = parseCsv('a,b\r\n"hello, world","say ""hi"""\n')
    expect(header).toEqual(['a', 'b'])
    expect(rows[0]!.cells).toEqual({ a: 'hello, world', b: 'say "hi"' })
  })
})

describe('DoD #1 — 5000-row CSV with per-row error report', () => {
  it('imports the full 5000 rows, collects structured errors for bad ones', async () => {
    const { ws, ctx } = await fixture()
    // Realistic fashion CSV: 3 variant-rows per product SKU → ~1650 products,
    // under the growth cap (2000) so the cap doesn't dominate this test
    // (cap-during-import has its own dedicated test below).
    const rows: string[] = []
    for (let i = 0; i < 5000; i += 1) {
      if (i % 100 === 7) {
        rows.push(`BAD-${i},X,,,not-a-price,BAD-${i}-V,Standard,5,,`) // name too short + bad price
      } else {
        const productIdx = Math.floor(i / 3)
        rows.push(`SKU-${productIdx},Product Number ${productIdx},desc,women,${100 + (productIdx % 900)},SKU-${i}-V,Variant ${i % 3},${i % 20},Red,M`)
      }
    }
    const start = await svc.startImport(ctx, 'big.csv', csvOf(rows))
    if (!start.ok) throw start.error
    expect(start.value.totalRows).toBe(5000)

    const result = await svc.processImport(ws, start.value.importId)
    expect(result.status).toBe('completed')
    expect(result.failed).toBe(50) // every i % 100 === 7
    expect(result.success).toBe(4950)

    const imp = await Import.findOne({ _id: start.value.importId, workspaceId: ws }).exec()
    const errors = imp!.get('errors') as Array<{ row: number; column: string; code: string }>
    expect(errors.length).toBeGreaterThanOrEqual(50)
    expect(errors[0]).toMatchObject({ column: expect.any(String), code: expect.any(String) })
    expect(imp!.lastProcessedRow).toBe(5000)
    const productCount = await Product.countDocuments({ workspaceId: ws }).exec()
    expect(productCount).toBeGreaterThan(1600) // ~1667 products with merged variants
    expect(productCount).toBeLessThan(1700)
  }, 300_000)

  it('rejects a CSV over the row limit with a clear message', async () => {
    const { ctx } = await fixture()
    const rows = Array.from({ length: 5001 }, (_, i) => `S-${i},Product ${i},,,10,S-${i}-V,Std,1,,`)
    const res = await svc.startImport(ctx, 'huge.csv', csvOf(rows))
    expect(!res.ok && res.error.code).toBe('VALIDATION_FAILED')
    if (!res.ok) expect(res.error.message).toContain('5000')
  }, 60_000)
})

describe('MVP gate #9 — kill mid-import, restart, ZERO duplicates', () => {
  it('resumes from the checkpoint; total products exactly matches unique rows', async () => {
    const { ws, ctx } = await fixture()
    const rows = Array.from({ length: 350 }, (_, i) => `R-${i},Resume Product ${i},,,50,R-${i}-V,Std,3,,`)
    const start = await svc.startImport(ctx, 'resume.csv', csvOf(rows))
    if (!start.ok) throw start.error
    const importId = start.value.importId

    // "Kill the worker" between checkpoints — deterministic simulation: the
    // process dies at the row-300 CHECKPOINT WRITE. Checkpoints at 100 and 200
    // persisted; rows 200–299 were inserted but never checkpointed → the
    // restart must redo them without duplicating.
    const svc2 = new CatalogueService()
    const originalFOAU = Import.findOneAndUpdate.bind(Import)
    ;(Import as { findOneAndUpdate: typeof Import.findOneAndUpdate }).findOneAndUpdate = ((
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      const set = (update as { $set?: { lastProcessedRow?: number } }).$set
      if (set?.lastProcessedRow === 300) {
        throw new Error('SIMULATED WORKER CRASH (SIGKILL at checkpoint 300)')
      }
      return originalFOAU(filter as never, update as never, options as never)
    }) as typeof Import.findOneAndUpdate
    try {
      await svc2.processImport(ws, importId).catch(() => undefined) // the dead process
    } finally {
      ;(Import as { findOneAndUpdate: typeof Import.findOneAndUpdate }).findOneAndUpdate = originalFOAU
    }

    const midway = await Import.findOne({ _id: importId, workspaceId: ws }).exec()
    expect(midway!.status).toBe('processing') // crashed, not completed
    expect(midway!.lastProcessedRow).toBe(200) // last durable checkpoint
    const countAfterCrash = await Product.countDocuments({ workspaceId: ws }).exec()
    expect(countAfterCrash).toBe(300) // rows 200–299 done but NOT checkpointed

    // Worker restarts → resumes from row 200; rows 200..299 are REDONE but
    // the duplicate-key path counts them as success — zero duplicates.
    const resumed = await svc.processImport(ws, importId)
    expect(resumed.status).toBe('completed')

    const total = await Product.countDocuments({ workspaceId: ws }).exec()
    expect(total).toBe(350) // EXACTLY the unique rows — MVP gate #9
    const skus = await Product.distinct('sku', { workspaceId: ws }).exec()
    expect(skus).toHaveLength(350)
  }, 120_000)

  it('cancel stops the worker at the next checkpoint', async () => {
    const { ws, ctx } = await fixture()
    const rows = Array.from({ length: 300 }, (_, i) => `C-${i},Cancel Product ${i},,,50,C-${i}-V,Std,3,,`)
    const start = await svc.startImport(ctx, 'cancel.csv', csvOf(rows))
    if (!start.ok) throw start.error

    // Cancel while "queued" — the worker should stop at its first checkpoint.
    await svc.cancelImport(ctx, start.value.importId)
    const result = await svc.processImport(ws, start.value.importId)
    expect(result.status).toBe('cancelled')
    expect(await Product.countDocuments({ workspaceId: ws }).exec()).toBe(0) // stopped before any checkpoint... 
  })
})

describe('plan cap enforced DURING import', () => {
  it('trial (50) fills to the cap and errors the rest as PLAN_LIMIT_EXCEEDED', async () => {
    const { ws, ctx } = await fixture('trial')
    const rows = Array.from({ length: 80 }, (_, i) => `T-${i},Trial Product ${i},,,10,T-${i}-V,Std,1,,`)
    const start = await svc.startImport(ctx, 'cap.csv', csvOf(rows))
    if (!start.ok) throw start.error
    const result = await svc.processImport(ws, start.value.importId)
    expect(result.success).toBe(50)
    expect(result.failed).toBe(30)
    const imp = await Import.findOne({ _id: start.value.importId, workspaceId: ws }).exec()
    const errors = imp!.get('errors') as Array<{ code: string }>
    expect(errors.every((e) => e.code === 'PLAN_LIMIT_EXCEEDED')).toBe(true)
    expect(await Product.countDocuments({ workspaceId: ws }).exec()).toBe(50)
  }, 60_000)

  it('single create respects the cap too (PLAN_LIMIT_EXCEEDED 429)', async () => {
    const { ctx } = await fixture('trial')
    for (let i = 0; i < 50; i += 1) {
      const r = await svc.create(ctx, {
        sku: `CAP-${i}`, name: `Cap Product ${i}`, basePriceMinor: 1000,
        variants: [{ sku: `CAP-${i}-V`, name: 'Std', stock: 1 }],
      })
      expect(r.ok).toBe(true)
    }
    const overflow = await svc.create(ctx, {
      sku: 'CAP-50', name: 'Straw Product', basePriceMinor: 1000,
      variants: [{ sku: 'CAP-50-V', name: 'Std', stock: 1 }],
    })
    expect(!overflow.ok && overflow.error.code).toBe('PLAN_LIMIT_EXCEEDED')
  }, 60_000)
})

describe('product CRUD', () => {
  it('rows sharing a SKU merge as variants of one product', async () => {
    const { ws, ctx } = await fixture()
    const start = await svc.startImport(ctx, 'variants.csv', csvOf([
      'JAMA-1,Cotton Jama,,,100,JAMA-1-R-M,Red / M,5,Red,M',
      'JAMA-1,Cotton Jama,,,100,JAMA-1-B-L,Blue / L,3,Blue,L',
    ]))
    if (!start.ok) throw start.error
    await svc.processImport(ws, start.value.importId)
    expect(await Product.countDocuments({ workspaceId: ws }).exec()).toBe(1)
    const p = await Product.findOne({ workspaceId: ws, sku: 'JAMA-1' }).exec()
    expect((p!.get('variants') as unknown[]).length).toBe(2)
  })

  it('DELETE archives (never deletes); PATCH restores archived → active', async () => {
    const { ws, ctx } = await fixture()
    const created = await svc.create(ctx, {
      sku: 'ARC-1', name: 'Archive Me', basePriceMinor: 5000,
      variants: [{ sku: 'ARC-1-V', name: 'Std', stock: 2 }],
    })
    if (!created.ok) throw created.error
    const id = created.value['id'] as string

    const archived = await svc.archive(ctx, id)
    expect(archived.ok).toBe(true)
    const row = await Product.findOne({ _id: id, workspaceId: ws }).exec()
    expect(row).not.toBeNull() // row retained
    expect(row!.status).toBe('archived')

    // Restore per PRD §2.5.
    const restored = await svc.update(ctx, id, row!.version, { status: 'active' })
    expect(restored.ok).toBe(true)
    expect((await Product.findOne({ _id: id, workspaceId: ws }).exec())!.status).toBe('active')

    // Foreign id → 404 (no existence leak).
    const foreign = await svc.archive(ctx, oid())
    expect(!foreign.ok && foreign.error.code).toBe('NOT_FOUND')
  })

  it('OCC: stale version → VERSION_CONFLICT; duplicate SKU → 409', async () => {
    const { ctx } = await fixture()
    const a = await svc.create(ctx, { sku: 'OCC-1', name: 'First Product', basePriceMinor: 100, variants: [{ sku: 'V1', name: 'S', stock: 1 }] })
    if (!a.ok) throw a.error
    await svc.update(ctx, a.value['id'] as string, 0, { name: 'Renamed Product' })
    const stale = await svc.update(ctx, a.value['id'] as string, 0, { name: 'Stale Write Name' })
    expect(!stale.ok && stale.error.code).toBe('VERSION_CONFLICT')

    const dup = await svc.create(ctx, { sku: 'OCC-1', name: 'Dup Product', basePriceMinor: 100, variants: [{ sku: 'V1', name: 'S', stock: 1 }] })
    expect(!dup.ok && dup.error.code).toBe('DUPLICATE_RESOURCE')
  })
})
