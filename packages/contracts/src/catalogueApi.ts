import { z } from 'zod'
import { moneyMinor, objectIdString } from './common.js'
import { KnowledgeItemAnswerApi } from './knowledge.js'

/** Catalogue + knowledge API bodies (§7.3 #46–57). */

const variantInput = z
  .object({
    sku: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).transform((v) => v.toUpperCase()),
    name: z.string().min(1).max(100),
    attributes: z
      .object({
        color: z.string().max(50).nullish(),
        size: z.string().max(50).nullish(),
        material: z.string().max(50).nullish(),
      })
      .strict()
      .nullish(),
    priceMinor: moneyMinor.nullish(),
    stock: z.number().int().min(0).max(1_000_000),
    lowStockThreshold: z.number().int().min(0).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()

export const CreateProductBody = z
  .object({
    sku: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).transform((v) => v.toUpperCase()),
    name: z.string().min(2).max(200), // API edge: ≤ 200 (PRD §2.5)
    description: z.string().max(2000).nullish(), // API edge 2000; DB ceiling 4000
    category: z.string().max(80).nullish(),
    basePriceMinor: moneyMinor.refine((v) => v > 0, 'price must be > 0').refine((v) => v <= 999_999_900, 'price above ৳9,999,999'),
    compareAtPriceMinor: moneyMinor.nullish(),
    variants: z
      .array(variantInput)
      .min(1, 'at least one variant required')
      .refine((v) => new Set(v.map((x) => x.sku)).size === v.length, 'variant SKUs must be unique'),
    images: z
      .array(z.object({ spacesKey: z.string().min(1), alt: z.string().max(200).nullish(), position: z.number().int().min(0) }).strict())
      .max(10)
      .optional(),
    status: z.enum(['active', 'draft']).optional(),
  })
  .strict()
  .refine(
    (p) => p.compareAtPriceMinor == null || p.compareAtPriceMinor >= p.basePriceMinor,
    'compare-at price must be ≥ price (PRD §2.5)',
  )
export type CreateProductBody = z.infer<typeof CreateProductBody>

export const UpdateProductBody = z
  .object({
    sku: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).transform((v) => v.toUpperCase()).optional(),
    name: z.string().min(2).max(200).optional(),
    description: z.string().max(2000).nullish(),
    category: z.string().max(80).nullish(),
    basePriceMinor: moneyMinor.refine((v) => v > 0).refine((v) => v <= 999_999_900).optional(),
    compareAtPriceMinor: moneyMinor.nullish(),
    variants: z.array(variantInput).min(1).optional(),
    images: z
      .array(z.object({ spacesKey: z.string().min(1), alt: z.string().max(200).nullish(), position: z.number().int().min(0) }).strict())
      .max(10)
      .optional(),
    /** restore path: archived → active is allowed here (PRD §2.5). */
    status: z.enum(['active', 'draft', 'archived']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field required')
export type UpdateProductBody = z.infer<typeof UpdateProductBody>

export const ListProductsQuery = z
  .object({
    status: z.enum(['active', 'draft', 'archived']).optional(),
    q: z.string().max(140).optional(),
    cursor: z.string().max(220).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()

// ── knowledge ────────────────────────────────────────────────────────────────

export const CreateKnowledgeBody = z
  .object({
    question: z.string().min(5).max(500),
    /** THE deliberate asymmetry: ≤ 500 at the API edge, 2000 in the DB. */
    answer: KnowledgeItemAnswerApi,
    category: z.enum(['delivery', 'payment', 'return', 'sizing', 'general']).nullish(),
    keywords: z.array(z.string().min(1).max(40).toLowerCase()).max(20).optional(),
  })
  .strict()
export type CreateKnowledgeBody = z.infer<typeof CreateKnowledgeBody>

export const UpdateKnowledgeBody = z
  .object({
    question: z.string().min(5).max(500).optional(),
    answer: KnowledgeItemAnswerApi.optional(),
    category: z.enum(['delivery', 'payment', 'return', 'sizing', 'general']).nullish(),
    keywords: z.array(z.string().min(1).max(40).toLowerCase()).max(20).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field required')
export type UpdateKnowledgeBody = z.infer<typeof UpdateKnowledgeBody>

export const ListKnowledgeQuery = z
  .object({
    status: z.enum(['draft', 'approved', 'archived']).optional(),
    category: z.enum(['delivery', 'payment', 'return', 'sizing', 'general']).optional(),
    cursor: objectIdString.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
