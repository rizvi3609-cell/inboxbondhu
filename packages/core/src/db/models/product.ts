import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { moneyPlugin } from '../plugins/money.js'
import { occPlugin } from '../plugins/occ.js'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D10 `products` — variants EMBEDDED (ADR-007): stock reservation must be
 * atomic with the price read.
 * - `reserved ≤ stock` is enforced by the T1 $expr filter + nightly recon (DB-08).
 * - searchText is regenerated in a pre-save hook — never from a use case.
 * - Products are ARCHIVED, never deleted (order provenance, R17).
 * - variants[].sku here == orders.items[].variantSku (DB-15) — do not rename.
 */
const variantSchema = new Schema(
  {
    sku: { type: String, required: true },
    name: { type: String, required: true }, // e.g. "Red / M"
    attributes: {
      color: { type: String, default: null },
      size: { type: String, default: null },
      material: { type: String, default: null },
    },
    priceMinor: { type: Number, min: 0, default: null }, // overrides basePriceMinor
    stock: { type: Number, required: true, min: 0 },
    reserved: { type: Number, required: true, min: 0, default: 0 }, // ≤ stock (INV-03)
    lowStockThreshold: { type: Number, min: 0, default: null },
    isActive: { type: Boolean, required: true, default: true },
  },
  { _id: false },
)

const imageSchema = new Schema(
  {
    spacesKey: { type: String, required: true },
    alt: { type: String, default: null },
    position: { type: Number, required: true, min: 0 },
  },
  { _id: false },
)

const productSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    sku: { type: String, required: true, uppercase: true },
    name: { type: String, required: true, minlength: 2, maxlength: 200 },
    description: { type: String, maxlength: 4000, default: null },
    category: { type: String, default: null },
    basePriceMinor: { type: Number, required: true, min: 0 },
    compareAtPriceMinor: { type: Number, min: 0, default: null },
    variants: {
      type: [variantSchema],
      required: true,
      validate: [
        { validator: (v: unknown[]) => v.length >= 1, message: 'at least one variant required' },
        {
          validator: (v: { sku: string }[]) => new Set(v.map((x) => x.sku)).size === v.length,
          message: 'variant sku must be unique within the parent product',
        },
      ],
    },
    images: {
      type: [imageSchema],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 10, message: 'max 10 images' },
    },
    status: { type: String, required: true, enum: ['active', 'draft', 'archived'], default: 'draft' },
    searchText: { type: String, required: true, default: '' },
    importId: { type: Schema.Types.ObjectId, ref: 'Import', default: null },
    version: { type: Number, required: true, default: 0, min: 0 }, // OCC
  },
  { timestamps: true, strict: 'throw' },
)

// searchText derived here, never from a use case.
// pre('validate') so the required check sees the derived value.
productSchema.pre('validate', function (next) {
  const variantNames = (this.variants as { name: string; sku: string }[]).map((v) => `${v.name} ${v.sku}`)
  this.searchText = [this.name, this.description ?? '', this.sku, ...variantNames]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  next()
})

productSchema.plugin(tenancyPlugin)
productSchema.plugin(occPlugin)
productSchema.plugin(moneyPlugin)

productSchema.index({ workspaceId: 1, sku: 1 }, { unique: true, name: 'I32' })
productSchema.index({ workspaceId: 1, status: 1, name: 1 }, { name: 'I33' })
productSchema.index({ workspaceId: 1, 'variants.sku': 1 }, { name: 'I34' })
productSchema.index({ workspaceId: 1, searchText: 'text' }, { name: 'I35' }) // AI retrieval
productSchema.index(
  { workspaceId: 1, 'variants.stock': 1 },
  { name: 'I36', partialFilterExpression: { status: 'active' } },
)

export type ProductModelDoc = InferSchemaType<typeof productSchema>
export const Product =
  (mongoose.models['Product'] as mongoose.Model<InferSchemaType<typeof productSchema>>) ??
  mongoose.model('Product', productSchema, 'products')
