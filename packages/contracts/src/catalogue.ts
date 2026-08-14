import { z } from 'zod'
import { isoDate, moneyMinor, objectIdString } from './common.js'

// ─── products (D10) ──────────────────────────────────────────────────────────

export const productStatus = z.enum(['active', 'draft', 'archived']) // AI sees 'active' only

export const productVariant = z
  .object({
    /** Called `sku` here; the SAME value is `variantSku` in orders.items[] (DB-15). Do not harmonise. */
    sku: z.string().min(1),
    name: z.string().min(1), // e.g. "Red / M"
    attributes: z
      .object({
        color: z.string().nullish(),
        size: z.string().nullish(),
        material: z.string().nullish(),
      })
      .strict()
      .nullish(),
    priceMinor: moneyMinor.nullish(), // overrides basePriceMinor when present
    stock: z.number().int().min(0),
    /** INV-03: reserved ≤ stock — enforced by the T1 $expr filter + nightly reconciliation. */
    reserved: z.number().int().min(0).default(0),
    lowStockThreshold: z.number().int().min(0).nullish(),
    isActive: z.boolean().default(true),
  })
  .strict()

export const productImage = z
  .object({
    spacesKey: z.string().min(1),
    alt: z.string().nullish(),
    position: z.number().int().min(0),
  })
  .strict()

export const ProductDoc = z
  .object({
    workspaceId: objectIdString,
    sku: z.string().min(1).regex(/^[A-Z0-9_-]+$/, 'uppercase'), // unique with workspaceId
    name: z.string().min(2).max(200),
    description: z.string().max(4000).nullish(),
    category: z.string().nullish(),
    basePriceMinor: moneyMinor,
    compareAtPriceMinor: moneyMinor.nullish(),
    variants: z.array(productVariant).min(1), // ADR-007: embedded
    images: z.array(productImage).max(10).default([]),
    status: productStatus.default('draft'),
    /** Derived in a pre-save hook — never written from a use case. */
    searchText: z.string().default(''),
    importId: objectIdString.nullish(),
    version: z.number().int().min(0).default(0),
  })
  .strict()
export type ProductDoc = z.infer<typeof ProductDoc>

// ─── imports (D19) ───────────────────────────────────────────────────────────

export const importStatus = z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled'])

export const ImportDoc = z
  .object({
    workspaceId: objectIdString,
    type: z.literal('products_csv'),
    fileName: z.string().min(1),
    spacesKey: z.string().min(1),
    totalRows: z.number().int().min(0),
    /** Resume checkpoint, every 100 rows (US-011). */
    lastProcessedRow: z.number().int().min(0).default(0),
    successCount: z.number().int().min(0).default(0),
    failureCount: z.number().int().min(0).default(0),
    errors: z
      .array(
        z
          .object({
            row: z.number().int().min(0),
            column: z.string(),
            code: z.string(),
            message: z.string(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
    status: importStatus.default('pending'),
    startedAt: isoDate.nullish(),
    completedAt: isoDate.nullish(),
    createdBy: objectIdString,
  })
  .strict()
export type ImportDoc = z.infer<typeof ImportDoc>
