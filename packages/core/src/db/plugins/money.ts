import type { Schema } from 'mongoose'

/**
 * Money plugin — INV-02: money is always an integer in minor units (poisha),
 * and field names end in `Minor`. This plugin walks every path whose name ends
 * in `Minor` (including nested/array paths) and rejects non-integer values at
 * the model layer.
 */
export function moneyPlugin(schema: Schema): void {
  schema.eachPath((pathName, schemaType) => {
    if (!/Minor$/.test(pathName.split('.').pop() ?? '')) return
    if (schemaType.instance !== 'Number') return
    schemaType.validate({
      validator: (v: unknown) => v === null || v === undefined || Number.isInteger(v),
      message: (props: { path: string }) =>
        `${props.path}: money must be an integer in minor units — floats are forbidden (INV-02)`,
    })
  })

  // Embedded arrays (e.g. products.variants[].priceMinor, orders.items[].unitPriceMinor)
  // are covered because eachPath exposes them as 'variants.priceMinor' style paths
  // on the child schema; apply recursively to child schemas.
  for (const child of schema.childSchemas) {
    moneyPlugin(child.schema)
  }
}
