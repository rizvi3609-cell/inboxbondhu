/**
 * §10.3 retrieval — MongoDB $text over products.searchText (active only) and
 * knowledgeItems.searchText (approved INSIDE the query). Top 5 products +
 * top 3 FAQs, score < 0.4 dropped. The Retriever interface is stable so the
 * Atlas Vector Search swap is one file.
 */
import { Product, KnowledgeItem } from '../../db/models/index.js'
import { normaliseBanglish } from './schema.js'

export interface RetrievedDoc {
  id: string
  type: 'product' | 'faq'
  name: string
  /** Whole-taka price for prompt display; null for FAQs. */
  priceTaka: number | null
  priceMinor: number | null
  /** Live stock - reserved across variants; null for FAQs. */
  available: number | null
  variants: Array<{ sku: string; name: string; priceMinor: number; available: number }> | null
  text: string
  score: number
}

export interface Retriever {
  search(workspaceId: string, query: string): Promise<RetrievedDoc[]>
}

export const mongoTextRetriever: Retriever = {
  async search(workspaceId: string, query: string): Promise<RetrievedDoc[]> {
    const normalised = normaliseBanglish(query)

    const [products, faqs] = await Promise.all([
      Product.find(
        { workspaceId, status: 'active', $text: { $search: normalised } }, // I35
        { score: { $meta: 'textScore' } },
      )
        .sort({ score: { $meta: 'textScore' } })
        .limit(5)
        .exec(),
      KnowledgeItem.find(
        { workspaceId, status: 'approved', $text: { $search: normalised } }, // I37, approved INSIDE
        { score: { $meta: 'textScore' } },
      )
        .sort({ score: { $meta: 'textScore' } })
        .limit(3)
        .exec(),
    ])

    const docs: RetrievedDoc[] = []
    for (const p of products) {
      const score = (p as unknown as { get(k: string): number }).get('score')
      if (score < 0.4) continue
      const variants = (p.get('variants') as Array<{ sku: string; name: string; priceMinor?: number | null; stock: number; reserved: number; isActive: boolean }>)
        .filter((v) => v.isActive)
        .map((v) => ({
          sku: v.sku,
          name: v.name,
          priceMinor: v.priceMinor ?? p.basePriceMinor,
          available: v.stock - v.reserved, // live availability (§10.4 rule 4)
        }))
      const available = variants.reduce((sum, v) => sum + v.available, 0)
      docs.push({
        id: String(p._id),
        type: 'product',
        name: p.name,
        priceMinor: p.basePriceMinor,
        priceTaka: Math.floor(p.basePriceMinor / 100),
        available,
        variants,
        text: `${p.name}. ${p.description ?? ''}`.trim().slice(0, 400),
        score,
      })
    }
    for (const f of faqs) {
      const score = (f as unknown as { get(k: string): number }).get('score')
      if (score < 0.4) continue
      docs.push({
        id: String(f._id),
        type: 'faq',
        name: f.question,
        priceMinor: null,
        priceTaka: null,
        available: null,
        variants: null,
        text: f.answer, // verbatim AI source (D11)
        score,
      })
    }
    return docs
  },
}
