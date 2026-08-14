/**
 * MOD-06 catalogue service — product CRUD (DELETE = archive; restore
 * archived → active per PRD §2.5), plan product cap, and the resumable
 * CSV import (checkpoint every 100 rows, cancel at next checkpoint).
 */
import { AppError, VersionConflictError } from '../../kernel/appError.js'
import { Result } from '../../kernel/result.js'
import type { TenantContext } from '../../kernel/tenantContext.js'
import { AuditLog, Import, Product, Workspace } from '../../db/models/index.js'
import {
  CsvEncodingError, decodeUtf8Strict, parseCsv, parseProductRow, validateHeader,
  type ImportRowError,
} from './csv.js'

export const PLAN_PRODUCT_CAPS: Record<string, number> = { trial: 50, starter: 500, growth: 2000 }
const CHECKPOINT_EVERY = 100

export interface ProductInput {
  sku: string
  name: string
  description?: string | null | undefined
  category?: string | null | undefined
  basePriceMinor: number
  compareAtPriceMinor?: number | null | undefined
  variants: Array<{
    sku: string
    name: string
    attributes?: {
      color?: string | null | undefined
      size?: string | null | undefined
      material?: string | null | undefined
    } | null | undefined
    priceMinor?: number | null | undefined
    stock: number
    lowStockThreshold?: number | null | undefined
    isActive?: boolean | undefined
  }>
  images?: Array<{ spacesKey: string; alt?: string | null | undefined; position: number }> | undefined
  status?: 'active' | 'draft' | undefined
}

export class CatalogueService {
  // ── #46 list ──────────────────────────────────────────────────────────────

  async list(
    ctx: TenantContext,
    query: { status?: 'active' | 'draft' | 'archived'; q?: string; cursor?: string; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100)
    const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId }
    if (query.status) filter['status'] = query.status
    if (query.q) filter['$text'] = { $search: query.q } // I35
    if (query.cursor) filter['name'] = { $gt: query.cursor }

    const rows = await Product.find(filter).sort({ name: 1 }).limit(limit + 1).exec() // I33
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return Result.ok({
      products: page.map((p) => this.serialise(p)),
      nextCursor: hasMore ? page[page.length - 1]!.name : null,
    })
  }

  async get(ctx: TenantContext, productId: string) {
    const p = await Product.findOne({ _id: productId, workspaceId: ctx.workspaceId }).exec()
    if (!p) return Result.err(new AppError('NOT_FOUND', 'Product not found.'))
    return Result.ok(this.serialise(p))
  }

  // ── #47 create — enforces the plan cap ───────────────────────────────────

  async create(ctx: TenantContext, input: ProductInput) {
    const capError = await this.checkProductCap(ctx.workspaceId, 1)
    if (capError) return Result.err(capError)
    try {
      const product = await Product.create({
        workspaceId: ctx.workspaceId,
        ...input,
        sku: input.sku.toUpperCase(),
        status: input.status ?? 'draft',
        searchText: ' ', // pre-validate hook regenerates
      })
      await this.audit(ctx, 'product.created', String(product._id), null, { sku: product.sku, name: product.name })
      return Result.ok(this.serialise(product))
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        return Result.err(new AppError('DUPLICATE_RESOURCE', 'A product with this SKU already exists.'))
      }
      if ((err as Error).name === 'ValidationError') {
        return Result.err(new AppError('VALIDATION_FAILED', (err as Error).message))
      }
      throw err
    }
  }

  // ── #48 update — If-Match OCC; supports restore archived → active ────────

  async update(
    ctx: TenantContext,
    productId: string,
    expectedVersion: number,
    changes: Partial<Omit<ProductInput, 'status'>> & { status?: 'active' | 'draft' | 'archived' | undefined },
  ) {
    const product = await Product.findOne({ _id: productId, workspaceId: ctx.workspaceId }).exec()
    if (!product) return Result.err(new AppError('NOT_FOUND', 'Product not found.'))
    if (product.version !== expectedVersion) {
      return Result.err(new VersionConflictError(product.version, Object.keys(changes)))
    }
    // Apply via document save so the searchText pre-validate hook runs.
    if (changes.sku !== undefined) product.sku = changes.sku.toUpperCase()
    if (changes.name !== undefined) product.name = changes.name
    if (changes.description !== undefined) product.description = changes.description ?? null
    if (changes.category !== undefined) product.category = changes.category ?? null
    if (changes.basePriceMinor !== undefined) product.basePriceMinor = changes.basePriceMinor
    if (changes.compareAtPriceMinor !== undefined) product.compareAtPriceMinor = changes.compareAtPriceMinor ?? null
    if (changes.variants !== undefined) product.set('variants', changes.variants)
    if (changes.images !== undefined) product.set('images', changes.images)
    if (changes.status !== undefined) product.status = changes.status // restore path: archived → active
    try {
      await product.save() // occ plugin bumps version
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        return Result.err(new AppError('DUPLICATE_RESOURCE', 'A product with this SKU already exists.'))
      }
      if ((err as Error).name === 'ValidationError') {
        return Result.err(new AppError('VALIDATION_FAILED', (err as Error).message))
      }
      throw err
    }
    await this.audit(ctx, 'product.updated', productId, null, changes as Record<string, unknown>)
    return Result.ok(this.serialise(product))
  }

  // ── #49 DELETE = archive, never delete (R17 provenance) ─────────────────

  async archive(ctx: TenantContext, productId: string) {
    const res = await Product.updateOne(
      { _id: productId, workspaceId: ctx.workspaceId, status: { $ne: 'archived' } },
      { $set: { status: 'archived' } },
    ).exec()
    if (res.matchedCount === 0) {
      const exists = await Product.findOne({ _id: productId, workspaceId: ctx.workspaceId }).exec()
      if (!exists) return Result.err(new AppError('NOT_FOUND', 'Product not found.'))
      return Result.err(new AppError('INVALID_STATE_TRANSITION', 'Product is already archived.'))
    }
    await this.audit(ctx, 'product.archived', productId, null, null)
    return Result.ok({ archived: true })
  }

  // ── CSV import ────────────────────────────────────────────────────────────

  /**
   * #50 — accepts the file buffer, validates encoding + header + row count,
   * stores the CSV (Spaces in prod — the raw text rides on the import row
   * until the storage integration lands; flagged), creates `imports`.
   * The WORKER runs processImport; concurrency 1 keeps checkpoints coherent.
   */
  async startImport(
    ctx: TenantContext,
    fileName: string,
    fileBuffer: Buffer,
    maxRows = 5000,
  ): Promise<Result<{ importId: string; totalRows: number }, AppError>> {
    let text: string
    try {
      text = decodeUtf8Strict(fileBuffer)
    } catch (err) {
      if (err instanceof CsvEncodingError) return Result.err(new AppError('VALIDATION_FAILED', err.message))
      throw err
    }
    const { header, rows } = parseCsv(text)
    const headerError = validateHeader(header)
    if (headerError) {
      return Result.err(new AppError('VALIDATION_FAILED', headerError.message, { details: [headerError] }))
    }
    if (rows.length === 0) return Result.err(new AppError('VALIDATION_FAILED', 'CSV contains no data rows.'))
    if (rows.length > maxRows) {
      return Result.err(new AppError('VALIDATION_FAILED', `CSV has ${rows.length} rows — the limit is ${maxRows}.`))
    }

    const imp = await Import.create({
      workspaceId: ctx.workspaceId,
      type: 'products_csv',
      fileName,
      // OPEN QUESTION: Spaces integration is not built (no credentials to
      // verify against). The narrow interim stores the sanitised CSV text on
      // the spacesKey field prefixed 'inline:'. One-file swap when storage lands.
      spacesKey: `inline:${text}`,
      totalRows: rows.length,
      createdBy: ctx.userId,
    })
    await this.audit(ctx, 'import.started', String(imp._id), null, { fileName, totalRows: rows.length })
    return Result.ok({ importId: String(imp._id), totalRows: rows.length })
  }

  /** #51 */
  async getImport(ctx: TenantContext, importId: string) {
    const imp = await Import.findOne({ _id: importId, workspaceId: ctx.workspaceId }).exec()
    if (!imp) return Result.err(new AppError('NOT_FOUND', 'Import not found.'))
    return Result.ok({
      id: String(imp._id),
      fileName: imp.fileName,
      status: imp.status,
      totalRows: imp.totalRows,
      lastProcessedRow: imp.lastProcessedRow,
      successCount: imp.successCount,
      failureCount: imp.failureCount,
      errors: imp.get('errors'),
      startedAt: imp.startedAt,
      completedAt: imp.completedAt,
    })
  }

  /** #52 — cancel; the worker stops at the NEXT checkpoint. */
  async cancelImport(ctx: TenantContext, importId: string) {
    const res = await Import.updateOne(
      { _id: importId, workspaceId: ctx.workspaceId, status: { $in: ['pending', 'processing'] } },
      { $set: { status: 'cancelled', completedAt: new Date() } },
    ).exec()
    if (res.matchedCount === 0) {
      const exists = await Import.findOne({ _id: importId, workspaceId: ctx.workspaceId }).exec()
      if (!exists) return Result.err(new AppError('NOT_FOUND', 'Import not found.'))
      return Result.err(new AppError('INVALID_STATE_TRANSITION', `Import is already ${exists.status}.`))
    }
    return Result.ok({ cancelled: true })
  }

  // ── the worker-side processor (csv-import queue, concurrency 1) ──────────

  /**
   * Resumable: starts from `lastProcessedRow`, checkpoints every 100 rows.
   * A crash between checkpoints redoes ≤ 100 rows — upsert by {workspaceId,
   * sku} makes the redo idempotent (zero duplicates — MVP gate #9).
   * Rows sharing a SKU merge as additional variants of one product.
   */
  async processImport(workspaceId: string, importId: string): Promise<{ status: string; success: number; failed: number }> {
    const imp = await Import.findOne({ _id: importId, workspaceId }).exec()
    if (!imp || imp.status === 'cancelled' || imp.status === 'completed') {
      return { status: imp?.status ?? 'missing', success: imp?.successCount ?? 0, failed: imp?.failureCount ?? 0 }
    }

    await Import.updateOne(
      { _id: importId, workspaceId, status: 'pending' },
      { $set: { status: 'processing', startedAt: new Date() } },
    ).exec()

    const raw = imp.spacesKey.startsWith('inline:') ? imp.spacesKey.slice(7) : ''
    const { rows } = parseCsv(raw)

    const ws = await Workspace.findOne({ _id: workspaceId }).exec()
    const cap = PLAN_PRODUCT_CAPS[ws?.plan ?? 'trial'] ?? 50

    let success = imp.successCount
    let failed = imp.failureCount
    let processed = imp.lastProcessedRow // resume checkpoint
    const newErrors: ImportRowError[] = []

    for (let i = processed; i < rows.length; i += 1) {
      const parsed = parseProductRow(rows[i]!)
      if (!parsed.value) {
        failed += 1
        newErrors.push(...parsed.errors)
      } else {
        const p = parsed.value
        const existing = await Product.findOne({ workspaceId, sku: p.sku }).exec()
        if (existing) {
          // Merge/refresh variant on the existing product (upsert semantics).
          const variants = existing.get('variants') as Array<{ sku: string; name: string; stock: number }>
          const vIdx = variants.findIndex((v) => v.sku === p.variantSku)
          const variant = {
            sku: p.variantSku, name: p.variantName,
            attributes: { color: p.color, size: p.size, material: null },
            stock: p.stock, reserved: vIdx >= 0 ? (variants[vIdx] as { reserved?: number }).reserved ?? 0 : 0,
            isActive: true,
          }
          if (vIdx >= 0) variants[vIdx] = variant as never
          else variants.push(variant as never)
          existing.set('variants', variants)
          existing.name = p.name
          if (p.description) existing.description = p.description
          if (p.category) existing.category = p.category
          existing.basePriceMinor = p.basePriceMinor
          existing.importId = imp._id
          await existing.save()
          success += 1
        } else {
          // The cap is enforced DURING import, not after.
          const count = await Product.countDocuments({ workspaceId, status: { $ne: 'archived' } }).exec()
          if (count >= cap) {
            failed += 1
            newErrors.push({
              row: rows[i]!.row, column: 'sku', code: 'PLAN_LIMIT_EXCEEDED',
              message: `Product cap (${cap}) for the ${ws?.plan ?? 'trial'} plan reached.`,
            })
          } else {
            try {
              await Product.create({
                workspaceId,
                sku: p.sku, name: p.name, description: p.description, category: p.category,
                basePriceMinor: p.basePriceMinor,
                variants: [{
                  sku: p.variantSku, name: p.variantName,
                  attributes: { color: p.color, size: p.size, material: null },
                  stock: p.stock, reserved: 0, isActive: true,
                }],
                status: 'active',
                importId: imp._id,
                searchText: ' ',
              })
              success += 1
            } catch (err) {
              if ((err as { code?: number }).code === 11000) {
                // Redo-after-crash raced an earlier insert — idempotent, count as success.
                success += 1
              } else {
                failed += 1
                newErrors.push({ row: rows[i]!.row, column: 'sku', code: 'WRITE_FAILED', message: (err as Error).message.slice(0, 200) })
              }
            }
          }
        }
      }
      processed = i + 1

      // Checkpoint every 100 rows; honour cancel at the checkpoint.
      if (processed % CHECKPOINT_EVERY === 0 || processed === rows.length) {
        const errorsToStore = newErrors.splice(0, newErrors.length)
        const fresh = await Import.findOneAndUpdate(
          { _id: importId, workspaceId, status: 'processing' },
          {
            $set: { lastProcessedRow: processed, successCount: success, failureCount: failed },
            ...(errorsToStore.length > 0 ? { $push: { errors: { $each: errorsToStore, $slice: 500 } } } : {}),
          },
          { new: true },
        ).exec()
        if (!fresh) {
          // Cancelled mid-run — stop at this checkpoint as specified.
          return { status: 'cancelled', success, failed }
        }
      }
    }

    await Import.updateOne(
      { _id: importId, workspaceId, status: 'processing' },
      { $set: { status: 'completed', completedAt: new Date() } },
    ).exec()
    return { status: 'completed', success, failed }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async checkProductCap(workspaceId: string, adding: number): Promise<AppError | null> {
    const ws = await Workspace.findOne({ _id: workspaceId }).exec()
    const cap = PLAN_PRODUCT_CAPS[ws?.plan ?? 'trial'] ?? 50
    const count = await Product.countDocuments({ workspaceId, status: { $ne: 'archived' } }).exec()
    if (count + adding > cap) {
      return new AppError('PLAN_LIMIT_EXCEEDED', `Your ${ws?.plan ?? 'trial'} plan allows ${cap} products.`)
    }
    return null
  }

  private serialise(p: {
    _id: unknown; sku: string; name: string; description?: string | null
    category?: string | null; basePriceMinor: number; compareAtPriceMinor?: number | null
    status: string; version: number; get(k: string): unknown
  }): Record<string, unknown> {
    return {
      id: String(p._id),
      sku: p.sku,
      name: p.name,
      description: p.description ?? null,
      category: p.category ?? null,
      basePriceMinor: p.basePriceMinor,
      compareAtPriceMinor: p.compareAtPriceMinor ?? null,
      variants: p.get('variants'),
      images: p.get('images'),
      status: p.status,
      version: p.version,
    }
  }

  private async audit(ctx: TenantContext, action: string, resourceId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): Promise<void> {
    await AuditLog.create({
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      actorType: 'user',
      actorRole: ctx.role === 'system' ? null : ctx.role,
      action,
      resourceType: action.startsWith('import') ? 'import' : 'product',
      resourceId,
      before,
      after,
      requestId: ctx.requestId,
    })
  }
}
