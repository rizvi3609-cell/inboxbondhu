/**
 * CSV parsing + sanitisation for product import (§9 Phase 5 item 3).
 * - UTF-8 only: reject BOM-less non-UTF-8 (mojibake) with a clear message.
 * - Formula-injection defence: strip leading = + - @ | and TAB from EVERY cell
 *   before parsing values (PRD §2.5, agent.md §13).
 * - RFC-4180-ish: quoted fields, escaped quotes, CRLF/LF.
 */

export class CsvEncodingError extends Error {
  constructor() {
    super('File must be UTF-8 encoded. Re-save the CSV as UTF-8 and try again.')
    this.name = 'CsvEncodingError'
  }
}

/** Strict UTF-8 validation — invalid sequences throw (never import mojibake). */
export function decodeUtf8Strict(buffer: Buffer): string {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    let text = decoder.decode(buffer)
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // strip BOM
    return text
  } catch {
    throw new CsvEncodingError()
  }
}

/** The §2.5 sanitiser: leading =, +, -, @, |, TAB stripped from a cell. */
export function neutraliseFormulaCell(cell: string): string {
  return cell.replace(/^[=+\-@|\t]+/, '')
}

export interface CsvRow {
  /** 1-based data row number (header = row 0). */
  row: number
  cells: Record<string, string>
}

export function parseCsv(text: string): { header: string[]; rows: CsvRow[] } {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      record.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      record.push(field)
      field = ''
      if (record.length > 1 || record[0] !== '') records.push(record)
      record = []
    } else {
      field += ch
    }
  }
  record.push(field)
  if (record.length > 1 || record[0] !== '') records.push(record)

  if (records.length === 0) return { header: [], rows: [] }
  const header = records[0]!.map((h) => neutraliseFormulaCell(h.trim()).toLowerCase())
  const rows: CsvRow[] = records.slice(1).map((cells, idx) => {
    const obj: Record<string, string> = {}
    header.forEach((name, col) => {
      obj[name] = neutraliseFormulaCell((cells[col] ?? '').trim())
    })
    return { row: idx + 1, cells: obj }
  })
  return { header, rows }
}

// ── Row → product input validation ──────────────────────────────────────────

export interface ImportRowError {
  row: number
  column: string
  code: string
  message: string
}

export interface ParsedProductRow {
  sku: string
  name: string
  description: string | null
  category: string | null
  basePriceMinor: number
  variantSku: string
  variantName: string
  stock: number
  color: string | null
  size: string | null
}

export const REQUIRED_COLUMNS = ['sku', 'name', 'price', 'variant_sku', 'variant_name', 'stock'] as const

export function validateHeader(header: string[]): ImportRowError | null {
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) {
      return { row: 0, column: col, code: 'MISSING_COLUMN', message: `Required column "${col}" is missing.` }
    }
  }
  return null
}

export function parseProductRow(row: CsvRow): { value: ParsedProductRow | null; errors: ImportRowError[] } {
  const errors: ImportRowError[] = []
  const c = row.cells

  const sku = (c['sku'] ?? '').toUpperCase()
  if (!/^[A-Z0-9_-]{1,64}$/.test(sku)) {
    errors.push({ row: row.row, column: 'sku', code: 'INVALID_SKU', message: 'SKU must be 1–64 chars A–Z 0–9 _ -' })
  }
  const name = c['name'] ?? ''
  if (name.length < 2 || name.length > 200) {
    errors.push({ row: row.row, column: 'name', code: 'INVALID_NAME', message: 'Name must be 2–200 characters.' })
  }
  const description = c['description'] || null
  if (description && description.length > 2000) {
    errors.push({ row: row.row, column: 'description', code: 'DESCRIPTION_TOO_LONG', message: 'Description over 2000 characters (API edge).' })
  }

  // Price arrives in taka; stored integer poisha. > 0 and ≤ ৳9,999,999.
  const priceTaka = Number(c['price'])
  const basePriceMinor = Math.round(priceTaka * 100)
  if (!Number.isFinite(priceTaka) || basePriceMinor <= 0 || basePriceMinor > 999_999_900 || Math.abs(priceTaka * 100 - basePriceMinor) > 1e-6) {
    errors.push({ row: row.row, column: 'price', code: 'INVALID_PRICE', message: 'Price must be > 0 and ≤ 9,999,999 with at most 2 decimals.' })
  }

  const variantSku = (c['variant_sku'] ?? '').toUpperCase()
  if (!/^[A-Z0-9_-]{1,64}$/.test(variantSku)) {
    errors.push({ row: row.row, column: 'variant_sku', code: 'INVALID_VARIANT_SKU', message: 'Variant SKU must be 1–64 chars A–Z 0–9 _ -' })
  }
  const variantName = c['variant_name'] ?? ''
  if (variantName.length < 1 || variantName.length > 100) {
    errors.push({ row: row.row, column: 'variant_name', code: 'INVALID_VARIANT_NAME', message: 'Variant name must be 1–100 characters.' })
  }
  const stock = Number(c['stock'])
  if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) {
    errors.push({ row: row.row, column: 'stock', code: 'INVALID_STOCK', message: 'Stock must be an integer 0–1,000,000.' })
  }

  if (errors.length > 0) return { value: null, errors }
  return {
    value: {
      sku, name, description,
      category: c['category'] || null,
      basePriceMinor,
      variantSku, variantName, stock,
      color: c['color'] || null,
      size: c['size'] || null,
    },
    errors: [],
  }
}
