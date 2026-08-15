/**
 * API response VIEW types — the wire shapes the dashboard consumes (C-11 /
 * audit L-3). Dates arrive as ISO strings over JSON, so every Date field is
 * `string` here. TYPE-ONLY on purpose: `import type` from the web erases at
 * compile time — zod never enters a client bundle through this file.
 *
 * Source of truth: the serialise() methods in packages/core services. When a
 * service adds/renames a response field, THIS file must change with it, and
 * the web build breaks until both agree — which is the whole point.
 */

// ── shared ──────────────────────────────────────────────────────────────────

export type Role = 'owner' | 'admin' | 'agent' | 'viewer'
export type Provider = 'facebook' | 'instagram'

export interface ApiErrorView {
  code: string
  message: string
  requestId?: string
  currentVersion?: number
  conflictingFields?: string[]
  details?: unknown
}

// ── identity / workspace ────────────────────────────────────────────────────

export interface MeView {
  id: string
  email: string
  name: string
  phone: string | null
  locale: string
  version: number
}

/** GET /workspaces — memberships list (bare array). */
export interface WorkspaceListItemView {
  workspaceId: string
  name: string
  slug: string
  role: Role
}

/** GET /w/:id (#25). */
export interface WorkspaceView {
  id: string
  name: string
  slug: string
  plan: 'trial' | 'starter' | 'growth'
  status: string
  timezone: string
  currency: string
  businessHours: {
    enabled: boolean
    days: Array<{ day: number; open: string; close: string; closed: boolean }>
    awayMessage?: string | null
  }
  aiConfig: {
    enabled: boolean
    tone: 'friendly' | 'formal' | 'concise'
    autoReplyEnabled: boolean
    confidenceThreshold: number
    handoverKeywords: string[]
    maxDiscountPercent: number
    promptVersion?: string
  }
  deliveryZones: Array<{ name: string; feeMinor: number; etaDays: number }>
  version: number
}

export interface MemberView {
  id: string
  userId: string
  name: string
  email: string
  role: Role
  joinedAt: string
  version: number
}

export interface InvitationView {
  id: string
  email: string
  role: Role
  expiresAt: string
  createdAt: string
}

// ── channels (#35 — BARE array, the one unwrapped list) ────────────────────

export interface ChannelView {
  id: string
  provider: Provider
  pageName: string
  status: string
  connectedAt: string
}

// ── inbox ───────────────────────────────────────────────────────────────────

export interface ConversationListItemView {
  id: string
  status: 'open' | 'pending' | 'resolved'
  mode: 'ai' | 'human'
  assignedTo: string | null
  customer: { id: string; displayName: string } | null
  lastMessageAt: string
  lastMessagePreview: string | null
  lastMessageDirection: 'inbound' | 'outbound' | null
  unreadCount: number
  metaWindowExpiresAt: string | null
  tags: string[]
  version: number
}

export interface ConversationDetailView {
  id: string
  status: 'open' | 'pending' | 'resolved'
  mode: 'ai' | 'human'
  assignedTo: string | null
  handoverReason: string | null
  lastMessageAt: string
  unreadCount: number
  messageCount: number
  metaWindowExpiresAt: string | null
  tags: string[]
  version: number
  customer: {
    id: string
    displayName: string
    phone: string | null // nulled for viewers server-side
    addressText: string | null
    deliveryZone: string | null
    orderCount: number
    totalSpentMinor: number
  } | null
  openOrder: {
    id: string
    orderCode: string | null
    fulfillmentStatus: string
    totalMinor: number
  } | null
}

export interface MessageView {
  id: string
  direction: 'inbound' | 'outbound'
  author: { type: 'customer' | 'ai' | 'agent' | 'system'; userId: string | null }
  contentType: string
  text: string | null
  attachments: Array<{ type: string; spacesKey: string; mimeType: string; sizeBytes: number }> | null
  status: string
  failureCode: string | null
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  createdAt: string
}

// ── catalogue ───────────────────────────────────────────────────────────────

export interface ProductVariantView {
  sku: string
  name: string
  priceMinor?: number | null
  stock: number
  reserved: number
  isActive: boolean
}

export interface ProductView {
  id: string
  sku: string
  name: string
  description: string | null
  category: string | null
  basePriceMinor: number
  compareAtPriceMinor: number | null
  variants: ProductVariantView[]
  images: Array<{ spacesKey: string; position: number }>
  status: 'active' | 'draft' | 'archived'
  version: number
}

/** GET /imports/:id — field names the dashboard AND import.progress share. */
export interface ImportView {
  id: string
  fileName: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  totalRows: number
  lastProcessedRow: number
  successCount: number
  failureCount: number
  errors: Array<{ row: number; column: string; code: string; message: string }>
  startedAt: string | null
  completedAt: string | null
}

// ── knowledge ───────────────────────────────────────────────────────────────

export interface KnowledgeItemView {
  id: string
  question: string
  answer: string
  category: string | null
  keywords: string[]
  status: 'draft' | 'approved' | 'archived'
  version: number
}

// ── orders ──────────────────────────────────────────────────────────────────

export interface OrderItemView {
  productId: string
  variantSku: string
  nameSnapshot: string
  variantNameSnapshot: string
  unitPriceMinor: number
  quantity: number
  lineTotalMinor: number
}

export interface OrderView {
  id: string
  orderCode: string | null
  conversationId: string
  customerId: string
  items: OrderItemView[]
  subtotalMinor: number
  discountMinor: number
  discountPercent: number | null
  deliveryFeeMinor: number
  totalMinor: number
  deliveryZone: string
  deliveryAddress: string
  recipientName: string
  recipientPhone: string
  fulfillmentStatus: 'Collecting' | 'AwaitingConfirmation' | 'Confirmed' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled'
  paymentStatus: 'Unpaid' | 'PaymentPending' | 'PaymentFailed' | 'Paid' | 'Refunded'
  paymentMethod: 'cod' | 'bkash' | 'nagad' | 'rocket' | null
  statusHistory: Array<{ from: string; to: string; at: string; byType: 'ai' | 'agent' | 'system' }>
  createdAt: string | null
  version: number
}

// ── ops / plans / analytics ────────────────────────────────────────────────

/**
 * Plan tier limits — THE single source (hardcoding-audit fix). The backend
 * enforces from this constant (plans service imports it); the dashboard's
 * plan cards display from it. A pricing change is one edit, both sides.
 * Runtime truth for CURRENT usage/limits stays the API (usageLedger snapshot).
 */
/**
 * Default pending-invitations cap (spec #33: "max 20"). Single source for the
 * service default AND the dashboard's "n/20" display. Ops may raise it via
 * MAX_PENDING_INVITES — that override reaches the service, not this display
 * default (flagged in FE-PHASE-4.1 report).
 */
export const MAX_PENDING_INVITATIONS_DEFAULT = 20

export type PlanId = 'trial' | 'starter' | 'growth'
export const PLAN_LIMITS: Record<PlanId, { conversations: number; products: number }> &
  Record<string, { conversations: number; products: number } | undefined> = {
  trial: { conversations: 100, products: 50 },
  starter: { conversations: 1000, products: 500 },
  growth: { conversations: 5000, products: 2000 },
}

export interface QuotaStatusView {
  plan: string
  periodKey: string
  conversationsUsed: number
  conversationsLimit: number
  usagePercent: number
  aiPaused: boolean
  warningLevel: 'none' | 'warn80' | 'blocked100'
}

export interface PlanView {
  plan: 'trial' | 'starter' | 'growth'
  periodKey: string
  conversations: { used: number; limit: number }
  products: { used: number; limit: number }
  aiPaused: boolean
}

export interface AnalyticsSummaryView {
  conversations: { total: number; aiHandled: number }
  ai: { replies: number; avgLatencyMs: number; costMinor: number; groundingBlocked: number }
  orders: { total: number; confirmed: number; revenueMinor: number; conversionPercent: number }
}

export interface TimeseriesView {
  metric: 'conversations' | 'orders' | 'ai_replies'
  points: Array<{ day: string; count: number }>
}

export interface AuditLogView {
  id: string
  actorId: string
  actorType: 'user' | 'system' | 'ai'
  actorRole: Role | null
  action: string
  resourceType: string
  resourceId: string
  requestId: string
  createdAt: string
}

// ── realtime (§12.3 payloads — ids and a preview only) ────────────────────

export interface RtMessageCreated {
  conversationId: string
  messageId: string
  preview: string
  direction: 'inbound' | 'outbound'
  at: string
}

export interface RtConversationUpdated {
  conversationId: string
  status?: 'open' | 'pending' | 'resolved'
  mode?: 'ai' | 'human'
  at: string
}

export interface RtOrderUpdated {
  orderId: string
  orderCode?: string | null
  status?: string
  at: string
}

export interface RtImportProgress {
  importId: string
  status: string
  lastProcessedRow: number
  totalRows: number
  successCount: number
  failureCount: number
}

export interface RtQuotaWarning {
  level: 80 | 100
  used: number | null
  limit: number | null
  at: string
}

/** The typed socket event map the web subscribes to (FRONTEND-SPEC §7.2). */
export interface RtEventMap {
  'message.created': RtMessageCreated
  'conversation.updated': RtConversationUpdated
  'order.updated': RtOrderUpdated
  'import.progress': RtImportProgress
  'quota.warning': RtQuotaWarning
  'session.revoked': { reason: string; at: string }
}
