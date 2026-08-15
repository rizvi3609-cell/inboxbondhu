/**
 * Response shapes from the frozen API contract (subset the dashboard reads).
 * The api validates everything server-side; these are display types only.
 */

export interface Me {
  id: string
  email: string
  name: string
  locale: string
  version: number
}

export interface WorkspaceSummary {
  id: string
  name: string
  slug: string
  role: 'owner' | 'admin' | 'agent' | 'viewer'
  plan: 'trial' | 'starter' | 'growth'
}

export interface ConversationRow {
  id: string
  status: 'open' | 'pending' | 'resolved'
  mode: 'ai' | 'human'
  customer?: { id: string; displayName: string } | null
  customerName?: string
  lastMessageAt: string
  lastMessagePreview: string | null
  lastMessageDirection?: string | null
  unreadCount: number
  handoverReason?: string | null
  version: number
}

export interface MessageRow {
  id: string
  direction: 'inbound' | 'outbound'
  author: { type: string; userId?: string | null }
  contentType: string
  text: string | null
  status: string
  failureCode?: string | null
  createdAt: string
  aiMeta?: { groundingBlocked?: boolean } | null
}

export interface ProductRow {
  id: string
  sku: string
  name: string
  basePriceMinor: number
  status: 'active' | 'draft' | 'archived'
  variants: Array<{ sku: string; name: string; stock: number; reserved: number; isActive: boolean }>
  version: number
}

export interface KnowledgeRow {
  id: string
  question: string
  answer: string
  status: 'draft' | 'approved' | 'archived'
  version: number
}

export interface OrderRow {
  id: string
  orderCode: string | null
  fulfillmentStatus: string
  paymentStatus: string
  totalMinor: number
  recipientName: string
  deliveryZone: string
  createdAt: string | null // serialised by the API since P9.1 (audit M-1)
  version: number
}

export interface AnalyticsSummary {
  conversations: { total: number; aiResolved: number }
  ai: { replies: number; handovers: number; groundingBlocked: number; costMinor: number; p50LatencyMs: number | null }
  orders: { confirmed: number; revenueMinor: number }
  conversionRate: number
}

export interface QuotaStatus {
  plan: string
  periodKey: string
  conversationsUsed: number
  conversationsLimit: number
  aiPaused: boolean
}

export function taka(minor: number): string {
  return `৳${(minor / 100).toLocaleString('en-IN')}`
}
