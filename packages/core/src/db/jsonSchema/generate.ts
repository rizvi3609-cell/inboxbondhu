/**
 * $jsonSchema validators GENERATED from the Zod contracts — never hand-written
 * next to a Zod schema (agent.md §4.1). CI runs `--check` and fails on drift.
 *
 * Usage:
 *   tsx packages/core/src/db/jsonSchema/generate.ts          # write generated/*.json
 *   tsx packages/core/src/db/jsonSchema/generate.ts --check  # diff, exit 1 on drift
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z, type ZodTypeAny } from 'zod'
import {
  UserDoc, SessionDoc, WorkspaceDoc, MembershipDoc, InvitationDoc,
  ChannelConnectionDoc, CustomerDoc, ConversationDoc, MessageDoc,
  ProductDoc, KnowledgeItemDoc, OrderDoc, OrderCounterDoc,
  StockReservationDoc, WebhookEventDoc, OutboxEventDoc,
  UsageLedgerDoc, AuditLogDoc, ImportDoc,
} from '@inboxbondhu/contracts'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'generated')

/** Minimal Zod → MongoDB $jsonSchema converter covering the subset we use. */
function toBson(schema: ZodTypeAny): Record<string, unknown> {
  const def = schema._def
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.AnyZodObject).shape
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape) as [string, ZodTypeAny][]) {
        properties[key] = toBson(value)
        if (!value.isOptional() && !value.isNullable() && !(value._def.typeName === z.ZodFirstPartyTypeKind.ZodDefault)) {
          required.push(key)
        }
      }
      const out: Record<string, unknown> = { bsonType: 'object', properties }
      if (required.length > 0) out['required'] = required
      return out
    }
    case z.ZodFirstPartyTypeKind.ZodString: {
      const out: Record<string, unknown> = { bsonType: 'string' }
      for (const check of def.checks ?? []) {
        if (check.kind === 'min') out['minLength'] = check.value
        if (check.kind === 'max') out['maxLength'] = check.value
        if (check.kind === 'regex') out['pattern'] = check.regex.source
      }
      return out
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const isInt = (def.checks ?? []).some((c: { kind: string }) => c.kind === 'int')
      const out: Record<string, unknown> = { bsonType: isInt ? ['int', 'long'] : ['int', 'long', 'double'] }
      for (const check of def.checks ?? []) {
        if (check.kind === 'min') out['minimum'] = check.value
        if (check.kind === 'max') out['maximum'] = check.value
      }
      return out
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { bsonType: 'bool' }
    case z.ZodFirstPartyTypeKind.ZodDate:
      return { bsonType: 'date' }
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { enum: def.values }
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { enum: [def.value] }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const out: Record<string, unknown> = { bsonType: 'array', items: toBson(def.type) }
      if (def.exactLength) { out['minItems'] = def.exactLength.value; out['maxItems'] = def.exactLength.value }
      if (def.minLength) out['minItems'] = def.minLength.value
      if (def.maxLength) out['maxItems'] = def.maxLength.value
      return out
    }
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return { bsonType: 'object' }
    case z.ZodFirstPartyTypeKind.ZodUnknown:
      return {}
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = toBson(def.innerType)
      return { anyOf: [inner, { bsonType: 'null' }] }
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return toBson(def.innerType)
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return toBson(def.schema)
    default:
      return {}
  }
}

/**
 * ObjectId-bearing string fields in the wire contracts become bsonType
 * objectId at the DB layer. We patch known id paths after generation.
 */
const ID_FIELDS = new Set([
  'workspaceId', 'userId', 'ownerId', 'invitedBy', 'acceptedUserId', 'connectedBy',
  'customerId', 'channelConnectionId', 'conversationId', 'assignedTo', 'productId',
  'importId', 'createdBy', 'approvedBy', 'orderId', 'byUserId',
])

function patchObjectIds(node: unknown, key?: string): unknown {
  if (Array.isArray(node)) return node.map((n) => patchObjectIds(n))
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (key !== undefined && ID_FIELDS.has(key) && obj['bsonType'] === 'string') {
      return { bsonType: 'objectId' }
    }
    if (key !== undefined && ID_FIELDS.has(key) && Array.isArray(obj['anyOf'])) {
      return { anyOf: [{ bsonType: 'objectId' }, { bsonType: 'null' }] }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = k === 'properties'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, patchObjectIds(pv, pk)]))
        : patchObjectIds(v, k)
    }
    return out
  }
  return node
}

const COLLECTIONS: Record<string, ZodTypeAny> = {
  users: UserDoc,
  sessions: SessionDoc,
  workspaces: WorkspaceDoc,
  memberships: MembershipDoc,
  invitations: InvitationDoc,
  channelConnections: ChannelConnectionDoc,
  customers: CustomerDoc,
  conversations: ConversationDoc,
  messages: MessageDoc,
  products: ProductDoc,
  knowledgeItems: KnowledgeItemDoc,
  orders: OrderDoc,
  orderCounters: OrderCounterDoc,
  stockReservations: StockReservationDoc,
  webhookEvents: WebhookEventDoc,
  outboxEvents: OutboxEventDoc,
  usageLedger: UsageLedgerDoc,
  auditLogs: AuditLogDoc,
  imports: ImportDoc,
}

export function generateAll(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [collection, schema] of Object.entries(COLLECTIONS)) {
    const raw = toBson(schema)
    // Loosen: DB validators use moderate level; timestamps/_id/__v/version are DB concerns.
    delete (raw as { required?: unknown }).required
    out[collection] = patchObjectIds(raw) as Record<string, unknown>
  }
  return out
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (isMain) {
  const checkMode = process.argv.includes('--check')
  const generated = generateAll()
  mkdirSync(OUT_DIR, { recursive: true })
  let drift = false
  for (const [collection, schema] of Object.entries(generated)) {
    const file = join(OUT_DIR, `${collection}.json`)
    const next = JSON.stringify({ $jsonSchema: schema }, null, 2) + '\n'
    if (checkMode) {
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''
      if (prev !== next) {
        console.error(`DRIFT: ${collection}.json is stale — run pnpm jsonschema:generate`)
        drift = true
      }
    } else {
      writeFileSync(file, next)
    }
  }
  if (checkMode && drift) process.exit(1)
  if (!checkMode) console.log(`generated ${Object.keys(generated).length} $jsonSchema validators → ${OUT_DIR}`)
}
